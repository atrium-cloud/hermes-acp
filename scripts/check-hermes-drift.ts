/**
 * Hermes gateway drift checker.
 *
 * The tui_gateway surface is untyped Python (raw dict literals, no pydantic
 * on the JSON-RPC path), so payload shapes cannot be derived mechanically —
 * src/gateway/types.ts stays hand-written. What CAN be automated is drift
 * detection: this script fetches a Hermes release (or reads a local
 * checkout), extracts the gateway method names and emitted event types, and
 * diffs them against the subset this adapter consumes. Missing names are
 * breaking (exit 1); new upstream events are informational. For every name we
 * depend on it prints the upstream definition sites, so the hand-verification
 * pass of a version bump starts from a worklist instead of a cold grep.
 *
 * Usage:
 *   bun run drift                 # check against the latest GitHub release
 *   bun run drift -- --tag v2026.8.19
 *   bun run drift -- --root /path/to/hermes-agent
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// ── CONSTANTS ───────────────────────────────────────────────────────────────

const HERMES_REPO = 'NousResearch/hermes-agent'
const LATEST_RELEASE_URL = `https://api.github.com/repos/${HERMES_REPO}/releases/latest`
const tarballUrl = (tag: string): string =>
  `https://codeload.github.com/${HERMES_REPO}/tar.gz/refs/tags/${encodeURIComponent(tag)}`

const GATEWAY_DIR = 'tui_gateway'
const PYPROJECT_FILE = 'pyproject.toml'

const TYPES_PATH = 'src/gateway/types.ts'
const CLIENT_PATH = 'src/gateway/HermesGatewayClient.ts'
const REFS_PATH = 'docs/refs.md'

// Upstream extraction patterns (Python source).
const METHOD_DECORATOR_PATTERN = /@method\(\s*"([a-z0-9._-]+)"/g
// The `_emit(` sites are the gateway event stream; `"type":` literals are NOT
// collected as events because ws.py control frames (hb, hello, rpc, …) would
// drown the report.
// Blind spot: methods registered through a variable (e.g. the projects.*
// family via `_projects_method(name)` in server.py) never match the literal
// decorator pattern. None of our consumed methods take that path today; if
// one ever does, teach the extractor about the registration helper instead
// of accepting a false BREAKING.
const EMIT_CALL_PATTERN = /_emit\(\s*"([a-z0-9._-]+)"/g
// Existence oracle for events that reach the wire without a literal `_emit`
// call: gateway.ready is a hand-built frame in entry.py/ws.py, and
// clarify.request goes through an emission helper. Only these names may fall
// back to the string-literal oracle — generic names (like `error`, which
// appears as a dict key everywhere) must match a real `_emit` site or they
// could survive their own removal from the event stream unnoticed.
const LITERAL_ORACLE_EVENTS = new Set(['gateway.ready', 'clarify.request'])
// Any dotted-or-plain lowercase string literal counts toward existence.
const STRING_LITERAL_PATTERN = /"([a-z][a-z0-9._-]*)"/g

// Our-side extraction patterns (TypeScript source).
const KNOWN_EVENTS_BLOCK_PATTERN = /const KNOWN_EVENT_TYPES[^{]*\{([\s\S]*?)\n\}/
const KNOWN_EVENT_KEY_PATTERN = /^\s*(?:'([a-z0-9._-]+)'|([a-z][a-zA-Z0-9]*)):\s*true,?\s*$/gm
const REQUEST_CALL_PATTERN = /request\(\s*'([a-z0-9._-]+)'/g
const PYPROJECT_VERSION_PATTERN = /^version\s*=\s*"([^"]+)"/m
const REFS_PIN_PATTERN = /Pinned reference: Hermes ([0-9][\w.-]*) \(tag `([^`]+)`\)/

// ── Extraction (pure, tested) ───────────────────────────────────────────────

export interface UpstreamSite {
  readonly file: string
  readonly line: number
}

export interface UpstreamSurface {
  readonly methods: ReadonlyMap<string, readonly UpstreamSite[]>
  readonly emittedEvents: ReadonlyMap<string, readonly UpstreamSite[]>
  /** Every name that appears as a string literal anywhere in tui_gateway —
   * the existence oracle for events emitted through variables (e.g.
   * clarify.request goes through a helper, not a literal `_emit`). */
  readonly literals: ReadonlyMap<string, readonly UpstreamSite[]>
}

/** Map every match offset to a 1-based line via a precomputed offset table
 * (server.py alone is tens of thousands of lines; per-match slicing is O(n²)). */
const buildLineLookup = (source: string): ((offset: number) => number) => {
  const starts: number[] = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      starts.push(index + 1)
    }
  }
  return (offset: number): number => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if ((starts[mid] as number) <= offset) {
        low = mid
      } else {
        high = mid - 1
      }
    }
    return low + 1
  }
}

const collect = (
  target: Map<string, UpstreamSite[]>,
  file: string,
  source: string,
  pattern: RegExp,
  lineAt: (offset: number) => number,
): void => {
  for (const match of source.matchAll(pattern)) {
    const name = match[1] ?? match[2]
    if (!name) {
      continue
    }
    const sites = target.get(name) ?? []
    sites.push({ file, line: lineAt(match.index) })
    target.set(name, sites)
  }
}

export function extractUpstreamSurface(files: ReadonlyMap<string, string>): UpstreamSurface {
  const methods = new Map<string, UpstreamSite[]>()
  const emittedEvents = new Map<string, UpstreamSite[]>()
  const literals = new Map<string, UpstreamSite[]>()
  for (const [file, source] of files) {
    const lineAt = buildLineLookup(source)
    collect(methods, file, source, METHOD_DECORATOR_PATTERN, lineAt)
    collect(emittedEvents, file, source, EMIT_CALL_PATTERN, lineAt)
    collect(literals, file, source, STRING_LITERAL_PATTERN, lineAt)
  }
  return { methods, emittedEvents, literals }
}

export function extractOurEventTypes(typesSource: string): readonly string[] {
  const block = KNOWN_EVENTS_BLOCK_PATTERN.exec(typesSource)?.[1]
  if (!block) {
    throw new Error(`drift check: could not locate KNOWN_EVENT_TYPES in ${TYPES_PATH}`)
  }
  const names: string[] = []
  for (const match of block.matchAll(KNOWN_EVENT_KEY_PATTERN)) {
    const name = match[1] ?? match[2]
    if (name) {
      names.push(name)
    }
  }
  if (names.length === 0) {
    throw new Error(`drift check: KNOWN_EVENT_TYPES parsed empty from ${TYPES_PATH}`)
  }
  return names
}

export function extractOurMethods(clientSource: string): readonly string[] {
  const names = [...clientSource.matchAll(REQUEST_CALL_PATTERN)].map((match) => match[1] as string)
  if (names.length === 0) {
    throw new Error(`drift check: no gateway.request calls parsed from ${CLIENT_PATH}`)
  }
  return [...new Set(names)]
}

export interface DriftReport {
  readonly missingMethods: readonly string[]
  readonly missingEvents: readonly string[]
  readonly newUpstreamEvents: readonly string[]
  readonly breaking: boolean
}

export function diffSurfaces(
  upstream: UpstreamSurface,
  ourMethods: readonly string[],
  ourEvents: readonly string[],
): DriftReport {
  const missingMethods = ourMethods.filter((name) => !upstream.methods.has(name))
  const missingEvents = ourEvents.filter(
    (name) =>
      !upstream.emittedEvents.has(name) &&
      !(LITERAL_ORACLE_EVENTS.has(name) && upstream.literals.has(name)),
  )
  const known = new Set(ourEvents)
  const newUpstreamEvents = [...upstream.emittedEvents.keys()].filter((name) => !known.has(name)).sort()
  return {
    missingMethods,
    missingEvents,
    newUpstreamEvents,
    breaking: missingMethods.length > 0 || missingEvents.length > 0,
  }
}

// ── Acquisition and reporting (CLI) ─────────────────────────────────────────

// Throws instead of process.exit: exit() skips pending `finally` blocks,
// which would leak the extracted-tarball temp directory on failure paths.
const fail = (message: string): never => {
  throw new Error(`drift check: ${message}`)
}

async function fetchLatestTag(): Promise<string> {
  const response = await fetch(LATEST_RELEASE_URL, {
    headers: { accept: 'application/vnd.github+json' },
  })
  if (!response.ok) {
    fail(`GitHub latest-release lookup failed: ${response.status} ${response.statusText}`)
  }
  const release = (await response.json()) as { tag_name?: string }
  if (!release.tag_name) {
    fail('GitHub latest-release response had no tag_name')
  }
  return release.tag_name as string
}

async function downloadRelease(tag: string): Promise<string> {
  const response = await fetch(tarballUrl(tag))
  if (!response.ok) {
    fail(`tarball download failed for tag ${tag}: ${response.status} ${response.statusText}`)
  }
  const workDir = mkdtempSync(join(tmpdir(), 'hermes-drift-'))
  try {
    const tarPath = join(workDir, 'hermes.tar.gz')
    writeFileSync(tarPath, new Uint8Array(await response.arrayBuffer()))
    const extracted = spawnSync('tar', ['-xzf', tarPath, '-C', workDir], { stdio: 'inherit' })
    if (extracted.status !== 0) {
      fail(`tar extraction failed for ${tarPath}`)
    }
    const root = readdirSync(workDir).find((entry) => entry !== 'hermes.tar.gz')
    if (!root) {
      fail('tarball extracted to an empty directory')
    }
    return join(workDir, root as string)
  } catch (error) {
    // Failures below this point own the temp dir; main()'s finally only
    // covers a workDir that was successfully returned.
    rmSync(workDir, { recursive: true, force: true })
    throw error
  }
}

function readGatewayFiles(root: string): Map<string, string> {
  const dir = join(root, GATEWAY_DIR)
  const files = new Map<string, string>()
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.py')) {
      files.set(`${GATEWAY_DIR}/${entry}`, readFileSync(join(dir, entry), 'utf8'))
    }
  }
  if (files.size === 0) {
    fail(`no python files found under ${dir}`)
  }
  return files
}

function parseArgs(argv: readonly string[]): { root?: string; tag?: string } {
  const parsed: { root?: string; tag?: string } = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--root' || flag === '--tag') {
      const value = argv[index + 1]
      if (!value) {
        fail(`${flag} requires a value`)
      }
      parsed[flag === '--root' ? 'root' : 'tag'] = value as string
      index += 1
    } else {
      fail(`unknown argument: ${flag}; supported flags are --root <path> and --tag <tag>`)
    }
  }
  return parsed
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.root && options.tag) {
    fail('--root and --tag are mutually exclusive')
  }

  let hermesRoot: string
  let cleanupDir: string | null = null
  let targetLabel: string
  if (options.root) {
    hermesRoot = resolve(options.root)
    targetLabel = hermesRoot
  } else {
    const tag = options.tag ?? (await fetchLatestTag())
    console.log(`drift check: downloading Hermes ${tag}`)
    hermesRoot = await downloadRelease(tag)
    cleanupDir = resolve(hermesRoot, '..')
    targetLabel = tag
  }

  try {
    const upstream = extractUpstreamSurface(readGatewayFiles(hermesRoot))
    const ourEvents = extractOurEventTypes(readFileSync(TYPES_PATH, 'utf8'))
    const ourMethods = extractOurMethods(readFileSync(CLIENT_PATH, 'utf8'))
    const report = diffSurfaces(upstream, ourMethods, ourEvents)

    const upstreamVersion = PYPROJECT_VERSION_PATTERN.exec(
      readFileSync(join(hermesRoot, PYPROJECT_FILE), 'utf8'),
    )?.[1]
    const pin = REFS_PIN_PATTERN.exec(readFileSync(REFS_PATH, 'utf8'))
    console.log(`target: ${targetLabel} (version ${upstreamVersion ?? 'unknown'})`)
    console.log(`pinned: ${pin ? `${pin[1]} (tag ${pin[2]})` : `no pin found in ${REFS_PATH}`}`)

    if (report.missingMethods.length > 0) {
      console.log('\nBREAKING — gateway methods we call that no longer exist upstream:')
      for (const name of report.missingMethods) {
        console.log(`  ${name}`)
      }
    }
    if (report.missingEvents.length > 0) {
      console.log('\nBREAKING — event types we handle that no longer appear upstream:')
      for (const name of report.missingEvents) {
        console.log(`  ${name}`)
      }
    }
    if (report.newUpstreamEvents.length > 0) {
      console.log('\nInfo — upstream event emissions not in our typed registry (dropped at runtime):')
      console.log(`  ${report.newUpstreamEvents.join(', ')}`)
    }

    console.log('\nHand-verification worklist (shapes are not derivable; re-check payloads at these sites):')
    for (const name of ourMethods) {
      const sites = upstream.methods.get(name) ?? []
      console.log(`  method ${name}: ${sites.map((site) => `${site.file}:${site.line}`).join(', ') || 'MISSING'}`)
    }
    for (const name of ourEvents) {
      const sites = (upstream.emittedEvents.get(name) ?? upstream.literals.get(name) ?? []).slice(0, 4)
      console.log(`  event ${name}: ${sites.map((site) => `${site.file}:${site.line}`).join(', ') || 'MISSING'}`)
    }

    if (report.breaking) {
      console.log('\nresult: BREAKING drift — update src/gateway/types.ts and the pin in docs/refs.md')
      process.exitCode = 1
    } else {
      console.log('\nresult: no breaking drift; hand-verify payload shapes before moving the pin')
    }
  } finally {
    if (cleanupDir) {
      rmSync(cleanupDir, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
