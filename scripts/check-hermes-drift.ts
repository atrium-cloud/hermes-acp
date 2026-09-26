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
 * pass of a version bump starts from a worklist instead of a cold grep. Names
 * say nothing about protocol behavior: 0.21.4's `client.capabilities`
 * handshake passed this check clean and only the live e2e tier caught it.
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
// The typed wrappers, plus the transport for the startup handshake it sends
// itself (`client.capabilities`).
export const CLIENT_PATHS = ['src/gateway/HermesGatewayClient.ts', 'src/gateway/GatewayClient.ts']
const REFS_PATH = 'docs/refs.md'

// Upstream extraction patterns (Python source).
// Gateway methods register either through the base `method("name")` decorator
// (server.py) or through a helper that wraps it and funnels to the same
// `_methods[name] = fn` table: `_session_method` and `_correction_method`
// (methods_session.py) and `_rpc` (methods_tools.py). All take the method name
// as their first string argument, so one first-arg capture covers every form;
// the leading `\b` stops the bare `method` alternative from matching inside
// longer helper names like `_pet_method`.
// Residual blind spot: registrars invoked with a variable name rather than a
// literal — the projects.* family via `_projects_method(name)`, and the
// `@method(name)` factory sites in methods_session.py — never match. No method
// this adapter consumes takes that path; if one ever does it surfaces as a
// false BREAKING (the safe direction) and the fix is to teach the extractor
// about that registrar. Registrar helpers for families we do not consume (pet,
// browser control, rooms, profiles, vault) are intentionally omitted.
const METHOD_REGISTRAR_PATTERN = /@?\b(?:method|_session_method|_correction_method|_rpc)\(\s*"([a-z0-9._-]+)"/g
// The `_emit(` sites are the gateway event stream; `"type":` literals are NOT
// collected as events because ws.py control frames (hb, hello, rpc, …) would
// drown the report.
const EMIT_CALL_PATTERN = /_emit\(\s*"([a-z0-9._-]+)"/g
// Server→client requests are issued through `server_requests.send(...)` /
// `send_async(...)` (tui_gateway/server_requests.py) with the method name as
// the first string argument.
const SERVER_REQUEST_SEND_PATTERN = /\bserver_requests\.send(?:_async)?\(\s*"([a-z0-9._-]+)"/g
// Existence oracle for events that reach the wire without a literal `_emit`
// call: gateway.ready is a hand-built frame in entry.py/ws.py. Only these
// names may fall back to the string-literal oracle — generic names (like
// `error`, which appears as a dict key everywhere) must match a real `_emit`
// site or they could survive their own removal from the event stream
// unnoticed.
const LITERAL_ORACLE_EVENTS = new Set(['gateway.ready'])
// Any dotted-or-plain lowercase string literal counts toward existence.
const STRING_LITERAL_PATTERN = /"([a-z][a-z0-9._-]*)"/g

// Our-side extraction patterns (TypeScript source).
const KNOWN_EVENTS_BLOCK_PATTERN = /const KNOWN_EVENT_TYPES[^{]*\{([\s\S]*?)\n\}/
const KNOWN_SERVER_REQUESTS_BLOCK_PATTERN = /const KNOWN_SERVER_REQUEST_METHODS[^{]*\{([\s\S]*?)\n\}/
const KNOWN_EVENT_KEY_PATTERN = /^\s*(?:'([a-z0-9._-]+)'|([a-z][a-zA-Z0-9]*)):\s*true,?\s*$/gm
const REQUEST_CALL_PATTERN = /request\(\s*'([a-z0-9._-]+)'/g
const PYPROJECT_VERSION_PATTERN = /^version\s*=\s*"([^"]+)"/m
const REFS_VERIFIED_PATTERN = /Verified against: Hermes ([0-9][\w.-]*) \(tag `([^`]+)`\)/

// ── Extraction (pure, tested) ───────────────────────────────────────────────

export interface UpstreamSite {
  readonly file: string
  readonly line: number
}

export interface UpstreamSurface {
  readonly methods: ReadonlyMap<string, readonly UpstreamSite[]>
  readonly emittedEvents: ReadonlyMap<string, readonly UpstreamSite[]>
  /** Server→client request methods, by their `server_requests.send*` sites. */
  readonly serverRequests: ReadonlyMap<string, readonly UpstreamSite[]>
  /** Every name that appears as a string literal anywhere in tui_gateway —
   * the existence oracle for events emitted through variables (e.g.
   * gateway.ready is a hand-built frame, not a literal `_emit`). */
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
  const serverRequests = new Map<string, UpstreamSite[]>()
  const literals = new Map<string, UpstreamSite[]>()
  for (const [file, source] of files) {
    const lineAt = buildLineLookup(source)
    collect(methods, file, source, METHOD_REGISTRAR_PATTERN, lineAt)
    collect(emittedEvents, file, source, EMIT_CALL_PATTERN, lineAt)
    collect(serverRequests, file, source, SERVER_REQUEST_SEND_PATTERN, lineAt)
    collect(literals, file, source, STRING_LITERAL_PATTERN, lineAt)
  }
  return { methods, emittedEvents, serverRequests, literals }
}

function extractRegistryKeys(typesSource: string, blockPattern: RegExp, registryName: string): readonly string[] {
  const block = blockPattern.exec(typesSource)?.[1]
  if (!block) {
    throw new Error(`drift check: could not locate ${registryName} in ${TYPES_PATH}`)
  }
  const names: string[] = []
  for (const match of block.matchAll(KNOWN_EVENT_KEY_PATTERN)) {
    const name = match[1] ?? match[2]
    if (name) {
      names.push(name)
    }
  }
  if (names.length === 0) {
    throw new Error(`drift check: ${registryName} parsed empty from ${TYPES_PATH}`)
  }
  return names
}

export function extractOurEventTypes(typesSource: string): readonly string[] {
  return extractRegistryKeys(typesSource, KNOWN_EVENTS_BLOCK_PATTERN, 'KNOWN_EVENT_TYPES')
}

export function extractOurServerRequestMethods(typesSource: string): readonly string[] {
  return extractRegistryKeys(typesSource, KNOWN_SERVER_REQUESTS_BLOCK_PATTERN, 'KNOWN_SERVER_REQUEST_METHODS')
}

export function extractOurMethods(clientSource: string): readonly string[] {
  const names = [...clientSource.matchAll(REQUEST_CALL_PATTERN)].map((match) => match[1] as string)
  if (names.length === 0) {
    throw new Error(`drift check: no gateway.request calls parsed from ${CLIENT_PATHS.join(', ')}`)
  }
  return [...new Set(names)]
}

export interface DriftReport {
  readonly missingMethods: readonly string[]
  readonly missingEvents: readonly string[]
  readonly missingServerRequests: readonly string[]
  readonly newUpstreamEvents: readonly string[]
  /** Server requests upstream can block a tool on that this adapter refuses
   * with method-not-found (docs/caveats.md "Unsupported gateway round-trips"). */
  readonly newUpstreamServerRequests: readonly string[]
  readonly breaking: boolean
}

export function diffSurfaces(
  upstream: UpstreamSurface,
  ourMethods: readonly string[],
  ourEvents: readonly string[],
  ourServerRequests: readonly string[],
): DriftReport {
  const missingMethods = ourMethods.filter((name) => !upstream.methods.has(name))
  const missingEvents = ourEvents.filter(
    (name) =>
      !upstream.emittedEvents.has(name) &&
      !(LITERAL_ORACLE_EVENTS.has(name) && upstream.literals.has(name)),
  )
  const missingServerRequests = ourServerRequests.filter((name) => !upstream.serverRequests.has(name))
  const known = new Set(ourEvents)
  const newUpstreamEvents = [...upstream.emittedEvents.keys()].filter((name) => !known.has(name)).sort()
  const knownServerRequests = new Set(ourServerRequests)
  const newUpstreamServerRequests = [...upstream.serverRequests.keys()]
    .filter((name) => !knownServerRequests.has(name))
    .sort()
  return {
    missingMethods,
    missingEvents,
    missingServerRequests,
    newUpstreamEvents,
    newUpstreamServerRequests,
    breaking: missingMethods.length > 0 || missingEvents.length > 0 || missingServerRequests.length > 0,
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
    const typesSource = readFileSync(TYPES_PATH, 'utf8')
    const ourEvents = extractOurEventTypes(typesSource)
    const ourServerRequests = extractOurServerRequestMethods(typesSource)
    const ourMethods = extractOurMethods(CLIENT_PATHS.map((path) => readFileSync(path, 'utf8')).join('\n'))
    const report = diffSurfaces(upstream, ourMethods, ourEvents, ourServerRequests)

    const upstreamVersion = PYPROJECT_VERSION_PATTERN.exec(
      readFileSync(join(hermesRoot, PYPROJECT_FILE), 'utf8'),
    )?.[1]
    const verified = REFS_VERIFIED_PATTERN.exec(readFileSync(REFS_PATH, 'utf8'))
    console.log(`target: ${targetLabel} (version ${upstreamVersion ?? 'unknown'})`)
    console.log(
      `verified: ${verified ? `${verified[1]} (tag ${verified[2]})` : `no verified release found in ${REFS_PATH}`}`,
    )

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
    if (report.missingServerRequests.length > 0) {
      console.log('\nBREAKING — server requests we answer that upstream no longer sends:')
      for (const name of report.missingServerRequests) {
        console.log(`  ${name}`)
      }
    }
    if (report.newUpstreamEvents.length > 0) {
      console.log('\nInfo — upstream event emissions not in our typed registry (dropped at runtime):')
      console.log(`  ${report.newUpstreamEvents.join(', ')}`)
    }
    if (report.newUpstreamServerRequests.length > 0) {
      console.log('\nInfo — upstream server requests not in our typed registry (refused with method-not-found):')
      console.log(`  ${report.newUpstreamServerRequests.join(', ')}`)
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
    for (const name of ourServerRequests) {
      const sites = (upstream.serverRequests.get(name) ?? []).slice(0, 4)
      console.log(`  server request ${name}: ${sites.map((site) => `${site.file}:${site.line}`).join(', ') || 'MISSING'}`)
    }

    if (report.breaking) {
      console.log('\nresult: BREAKING drift — update src/gateway/types.ts and the verified release in docs/refs.md')
      process.exitCode = 1
    } else {
      console.log(
        '\nresult: no breaking drift; hand-verify payload shapes and run the live e2e tier before moving the verified release',
      )
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
