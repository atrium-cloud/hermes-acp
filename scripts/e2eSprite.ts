/**
 * Live e2e in an ephemeral Fly.io sprite.
 *
 * The `RUN_HERMES_E2E` tier spends real provider tokens against a real Hermes
 * install, and Hermes' install (a uv sync against the tagged source tree, plus
 * a release-tarball download) is network-heavy enough to hang for minutes on a
 * home connection. This orchestrator runs the whole tier in a throwaway sprite
 * with datacenter bandwidth: create a fresh sprite, sync the working tree in,
 * build, install the pinned Hermes, run the e2e suite, pull the results, and
 * destroy the sprite — recording evidence at every step, including the steps
 * that FAIL, so a run that dies at the Hermes install is itself proof of what
 * does not work.
 *
 * Gate: `sprite` must be on PATH and a provider key must be resolvable (a repo
 * `.env` OPENROUTER_API_KEY, else the OS environment). Absent either, the run
 * refuses before creating anything.
 *
 * Evidence lands in the git-ignored `e2e-evidence/<UTC-timestamp>-<tag>/`
 * (summary.json, results.json, output.log) with a `latest/` mirror. Secret
 * values are scrubbed from every byte written to disk; the provider key does,
 * unavoidably, pass through the local `sprite` client's argv (visible in a
 * local `ps` for the run's duration) because `sprite exec --env` is the only
 * channel it offers — an accepted local-side tradeoff, never written to the
 * repo, a file, or the remote command echo.
 *
 * Usage:
 *   bun run test:e2e:sprite                 # against the docs/refs.md pin
 *   bun run test:e2e:sprite -- --tag v2026.9.11
 *   bun run test:e2e:sprite -- --keep       # leave the sprite up for debugging
 */

import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { platform, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ── CONSTANTS ───────────────────────────────────────────────────────────────

const HERMES_REPO = 'NousResearch/hermes-agent'
const REFS_PATH = 'docs/refs.md'
// The single source of truth for the default tag is the docs/refs.md pin line;
// this regex is a local copy of the one in scripts/check-hermes-drift.ts (kept
// in sync by hand) that reads that same line.
const REFS_PIN_PATTERN = /Pinned reference: Hermes ([0-9][\w.-]*) \(tag `([^`]+)`\)/

// The variable NAME, never a value — the pre-commit secret scan cannot tell
// the difference, hence the marker.
const ENV_PROVIDER_KEY = 'OPENROUTER_API_KEY' // pragma: allowlist secret
const ENV_RUN_E2E = 'RUN_HERMES_E2E'

const EVIDENCE_DIRNAME = 'e2e-evidence'
const LATEST_DIRNAME = 'latest'

// Remote (in-sprite) absolute paths. HOME is /home/sprite, so the working copy
// must live under it — not /root, whose tree the running commands never see.
const REMOTE_REPO = '/home/sprite/hermes-acp'
const REMOTE_TARBALL = '/tmp/hermes-acp-sync.tar.gz'
const REMOTE_INSTALL_SCRIPT = '/tmp/install-hermes.sh'
const REMOTE_RESULTS = '/tmp/e2e-results.json'

// Per-step ceilings. A silent 0-CPU hang (uv introspection, a stalled download)
// is the characteristic failure here; without a ceiling the orchestrator waits
// forever and leaks the sprite. On expiry the child is killed, the step is
// recorded as timed out, and cleanup still runs.
const TIMEOUT_CREATE_MS = 180_000
const TIMEOUT_SYNC_MS = 240_000
const TIMEOUT_BUILD_MS = 300_000
const TIMEOUT_INSTALL_MS = 600_000
const TIMEOUT_E2E_MS = 1_800_000
const TIMEOUT_PULL_MS = 60_000
const TIMEOUT_DESTROY_MS = 120_000
// A `sprite create` killed mid-flight can still be provisioning remotely, so a
// destroy issued immediately after the kill may fail against a sprite that
// only materializes seconds later; the teardown retries once after a settle.
const DESTROY_RETRY_DELAY_MS = 3_000

// Captured output can be large (vitest verbose + Hermes boot logs).
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024

const REDACTED = '<redacted>'
// Mirror of the fixture's scrubber (spawnedAgentFixture.ts): a value-replacing
// net for keys that appear in captured output even after the known-value pass.
const SECRET_PATTERNS: readonly RegExp[] = [
  /(authorization:\s*bearer\s+)\S+/gi,
  /(sk-)[A-Za-z0-9_-]+/g,
  /((?:api[_-]?key|token)["'\s:=]+)\S+/gi,
]
const PATTERN_REPLACEMENT = `$1${REDACTED}`

/** The ordered step trail (advisor: evidence must show which step failed). */
const STEP_NAMES = ['create', 'sync', 'build', 'install-hermes', 'e2e', 'pull-results', 'destroy'] as const
type StepName = (typeof STEP_NAMES)[number]
/** The steps whose success defines a passing HARNESS run; `destroy` is cleanup
 * and does not gate the test verdict (a leaked sprite is a warning, not a red
 * test). */
const CRITICAL_STEPS: readonly StepName[] = ['create', 'sync', 'build', 'install-hermes', 'e2e', 'pull-results']

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The Hermes install, uploaded and run as a real remote file rather than an
// escaped `sh -c`: it globs for the newest real pyenv CPython below 3.14 (the
// `/.sprite/bin/python3` shim dies E2BIG under uv's introspection, and
// /usr/bin/python3 is 3.14, outside Hermes' requires-python), installs uv with
// it, and uv-syncs the tagged source editable. Marker lines (INTERP=,
// HERMES_VERSION=, VENV_BIN=) are parsed back for provenance and the e2e PATH.
const INSTALL_SCRIPT = `#!/bin/sh
set -eu

TAG="$1"
HERMES_SRC="/tmp/hermes-src"
TARBALL="/tmp/hermes-src.tar.gz"

echo "downloading Hermes \${TAG}"
rm -rf "$HERMES_SRC" "$TARBALL"
mkdir -p "$HERMES_SRC"
curl -fsSL "https://codeload.github.com/${HERMES_REPO}/tar.gz/refs/tags/\${TAG}" -o "$TARBALL"
tar -xzf "$TARBALL" -C "$HERMES_SRC"
TREE="$(find "$HERMES_SRC" -mindepth 1 -maxdepth 1 -type d | head -n1)"
if [ -z "$TREE" ]; then echo "ERROR: extracted tree not found"; exit 3; fi

HERMES_VERSION="$(awk -F'"' '/^version[[:space:]]*=/{print $2; exit}' "$TREE/pyproject.toml" || true)"
echo "HERMES_VERSION=\${HERMES_VERSION}"

# Newest real pyenv CPython < 3.14. Never the /.sprite/bin shim.
INTERP=""
INTERP_NUM=0
for cand in /.sprite/languages/python/pyenv/versions/*/bin/python3; do
  [ -x "$cand" ] || continue
  set -- $("$cand" -c 'import sys;print(sys.version_info[0], sys.version_info[1])' 2>/dev/null || echo "0 0")
  maj="$1"; min="$2"
  [ "$maj" = "3" ] || continue
  [ "$min" -lt 14 ] || continue
  num=$((maj * 100 + min))
  if [ "$num" -gt "$INTERP_NUM" ]; then INTERP="$cand"; INTERP_NUM="$num"; fi
done
if [ -z "$INTERP" ]; then echo "ERROR: no pyenv CPython <3.14 found"; exit 4; fi
echo "INTERP=$INTERP"

# pip drops the uv console script into whichever bin dir is writable (the
# interpreter's own bin, else the per-user base), so do NOT guess a directory.
# Resolve it authoritatively through the wheel's own locator; fall back to the
# console script's usual homes only if the locator is unavailable.
"$INTERP" -m pip install --disable-pip-version-check uv
UVBIN="$("$INTERP" -c 'import uv; print(uv.find_uv_bin())' 2>/dev/null || true)"
if [ -z "$UVBIN" ] || [ ! -x "$UVBIN" ]; then
  USER_BASE="$("$INTERP" -m site --user-base 2>/dev/null || true)"
  UVBIN=""
  for cand in "$(dirname "$INTERP")/uv" "\${USER_BASE}/bin/uv" "$HOME/.local/bin/uv"; do
    if [ -x "$cand" ]; then UVBIN="$cand"; break; fi
  done
  if [ -z "$UVBIN" ]; then UVBIN="$(command -v uv 2>/dev/null || true)"; fi
fi
if [ -z "$UVBIN" ] || [ ! -x "$UVBIN" ]; then echo "ERROR: uv not found after pip install"; exit 5; fi
echo "UVBIN=$UVBIN"

cd "$TREE"
UV_PYTHON="$INTERP" "$UVBIN" sync --no-dev --frozen
VENV_BIN="$TREE/.venv/bin"
if [ ! -x "$VENV_BIN/hermes" ]; then echo "ERROR: hermes not on venv bin ($VENV_BIN)"; exit 6; fi
"$VENV_BIN/hermes" --version || true
echo "VENV_BIN=$VENV_BIN"
`

// ── Pure helpers (tested) ────────────────────────────────────────────────────

export interface ParsedArgs {
  readonly tag: string | undefined
  readonly keep: boolean
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let tag: string | undefined
  let keep = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--tag') {
      const value = argv[index + 1]
      // A flag-shaped value means the user omitted the tag (`--tag --keep`);
      // tags are version-shaped and never start with `--`.
      if (!value || value.startsWith('--')) {
        throw new Error(`e2e-sprite: --tag requires a value`)
      }
      tag = value
      index += 1
    } else if (flag === '--keep') {
      keep = true
    } else {
      throw new Error(`e2e-sprite: unknown argument ${flag}; supported flags are --tag <tag> and --keep`)
    }
  }
  return { tag, keep }
}

/** The tag the drift checker pins in docs/refs.md, so the default target tracks
 * a single source of truth rather than a second hardcoded version. */
export function resolvePinTag(refsSource: string): string {
  const match = REFS_PIN_PATTERN.exec(refsSource)
  if (!match?.[2]) {
    throw new Error(`e2e-sprite: could not read the Hermes pin tag from ${REFS_PATH}`)
  }
  return match[2]
}

/** Redact known secret values and secret-shaped substrings from anything bound
 * for disk. The known-value pass catches the provider key even where it does
 * not match a pattern; the patterns catch bearer headers and sk- keys that a
 * child might print in a shape we did not pre-register. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let scrubbed = text
  for (const secret of secrets) {
    if (secret) {
      scrubbed = scrubbed.split(secret).join(REDACTED)
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, PATTERN_REPLACEMENT)
  }
  return scrubbed
}

/** `YYYYMMDDTHHMMSSZ` — a filesystem-safe UTC stamp. */
export function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/** `<utc-stamp>-<tag>` with the tag reduced to path-safe characters. */
export function evidenceDirName(date: Date, tag: string): string {
  const safeTag = tag.replace(/[^A-Za-z0-9._-]/g, '-')
  return `${utcStamp(date)}-${safeTag}`
}

/** First executable named `name` on `pathEnv`, or null. Used by the preflight
 * gate to refuse before creating a sprite when `sprite` is not installed. */
export function findExecutable(name: string, pathEnv: string | undefined): string | null {
  for (const dir of (pathEnv ?? '').split(':')) {
    if (!dir) {
      continue
    }
    const candidate = join(dir, name)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Not here; try the next PATH entry. A missing/again-non-executable
      // candidate is the normal case, not an error worth surfacing.
    }
  }
  return null
}

export type StepStatus = 'pending' | 'ok' | 'failed' | 'timeout' | 'skipped'

/** A run passes only if every harness-critical step is ok AND the suite it ran
 * reported zero failures. A known flake still fails the verdict — the evidence
 * says why; the orchestrator never launders a red into a green. */
export function overallVerdict(criticalStatuses: readonly StepStatus[], testsPassed: boolean): 'passed' | 'failed' {
  const allOk = criticalStatuses.every((status) => status === 'ok')
  return allOk && testsPassed ? 'passed' : 'failed'
}

export interface TestTotals {
  readonly total: number
  readonly passed: number
  readonly failed: number
  /** Runtime-skipped/todo tests. Under RUN_HERMES_E2E in the sprite the whole
   * live tier is gated IN, so a pending count > 0 means tests that should have
   * run did not — the verdict treats it as not-green. */
  readonly pending: number
  readonly failedNames: readonly string[]
}

interface VitestJson {
  numTotalTests?: number
  numPassedTests?: number
  numFailedTests?: number
  numPendingTests?: number
  numTodoTests?: number
  testResults?: Array<{
    name?: string
    assertionResults?: Array<{ fullName?: string; title?: string; status?: string }>
  }>
}

/** A run is only green when the harness completed AND the live tier actually
 * ran: at least one test passed, none failed, none were skipped. A suite that
 * silently collected zero live tests (e.g. RUN_HERMES_E2E never reached the
 * sprite) exits 0 with passed === 0 — which must NOT read as passed. */
export function testsPassed(tests: TestTotals | null): boolean {
  return tests !== null && tests.passed > 0 && tests.failed === 0 && tests.pending === 0
}

/** Reduce a vitest JSON report to counts plus the names of what failed. Returns
 * null when the report is absent or unparseable — a genuine "we don't know",
 * which the verdict must treat as not-passed rather than as zero failures. */
export function summarizeTests(resultsJson: string | null): TestTotals | null {
  if (resultsJson === null) {
    return null
  }
  let parsed: VitestJson
  try {
    parsed = JSON.parse(resultsJson) as VitestJson
  } catch {
    return null
  }
  if (typeof parsed.numTotalTests !== 'number') {
    return null
  }
  const failedNames: string[] = []
  for (const file of parsed.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === 'failed') {
        failedNames.push(assertion.fullName ?? assertion.title ?? '(unnamed test)')
      }
    }
  }
  return {
    total: parsed.numTotalTests,
    passed: parsed.numPassedTests ?? 0,
    failed: parsed.numFailedTests ?? 0,
    pending: (parsed.numPendingTests ?? 0) + (parsed.numTodoTests ?? 0),
    failedNames,
  }
}

// ── Orchestration (CLI) ──────────────────────────────────────────────────────

interface ExecResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly spawnError?: Error
}

interface StepRecord {
  name: StepName
  status: StepStatus
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
  note?: string
}

interface Provenance {
  host: string
  tag: string
  keySource: string
  spriteName: string
  startedAt: string
  finishedAt?: string
  hermesVersion?: string
  interpreter?: string
  venvBin?: string
}

// Module-level run state so the signal handler and the finally path can write
// the same evidence from the same accumulated facts.
const steps: StepRecord[] = []
const outputChunks: string[] = []
const secrets: string[] = []
let provenance: Provenance | undefined
let evidenceDir = ''
let latestDir = ''
let spriteName: string | null = null
let keepSprite = false
let currentChild: ChildProcess | null = null
let finalized = false
let finalizePromise: Promise<void> | null = null
let finalVerdict: 'passed' | 'failed' = 'failed'

function logSection(title: string): void {
  outputChunks.push(`\n===== ${title} =====\n`)
}

function runLocal(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  extraEnv?: Readonly<Record<string, string>>,
): Promise<ExecResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args as string[], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    })
    currentChild = child
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURE_BYTES) {
        stdout += chunk
      }
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_CAPTURE_BYTES) {
        stderr += chunk
      }
    })
    const clearIfCurrent = (): void => {
      // A killed child's late close must not null out a child that teardown
      // has since started (the destroy process), or a later kill misfires.
      if (currentChild === child) {
        currentChild = null
      }
    }
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      clearIfCurrent()
      resolveResult({ code: null, signal: null, stdout, stderr, timedOut, spawnError: error })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      clearIfCurrent()
      resolveResult({ code, signal, stdout, stderr, timedOut })
    })
  })
}

/** Run one step: record timing/status, capture its scrubbed output, and derive
 * pass/fail. A timed-out or nonzero step is recorded; the caller decides
 * whether to abort the pipeline. */
async function runStep(
  name: StepName,
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ExecResult> {
  // Once teardown has started (a signal fired finalize mid-run), no further
  // pipeline step may launch — record it skipped and let main unwind.
  if (finalized && name !== 'destroy') {
    recordSkipped(name, 'teardown in progress')
    return { code: null, signal: null, stdout: '', stderr: '', timedOut: false }
  }
  const startedAt = Date.now()
  logSection(`step ${name}: ${scrubSecrets([command, ...args].join(' '), secrets)}`)
  const result = await runLocal(command, args, timeoutMs)
  outputChunks.push(scrubSecrets(result.stdout, secrets))
  if (result.stderr) {
    outputChunks.push(scrubSecrets(result.stderr, secrets))
  }
  const status: StepStatus = result.timedOut ? 'timeout' : result.code === 0 && !result.spawnError ? 'ok' : 'failed'
  const record: StepRecord = {
    name,
    status,
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: Date.now() - startedAt,
  }
  if (result.spawnError) {
    record.note = result.spawnError.message
  }
  steps.push(record)
  return result
}

function recordSkipped(name: StepName, note: string): void {
  steps.push({ name, status: 'skipped', code: null, signal: null, timedOut: false, durationMs: 0, note })
}

export function markerValue(output: string, key: string): string | undefined {
  const match = new RegExp(`^${key}=(.+)$`, 'm').exec(output)
  return match?.[1]?.trim() || undefined
}

/** Parse one `.env` line for the provider key. An unquoted value drops a
 * trailing ` # comment` (dotenv semantics); a quoted value is verbatim, so a
 * `#` inside quotes is data. Returns null when the line does not set the key. */
export function parseProviderKeyLine(line: string): string | null {
  const match = /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.+?)\s*$/.exec(line) // pragma: allowlist secret
  const raw = match?.[1]
  if (!raw) {
    return null
  }
  // Quoted values are verbatim up to the closing quote (a `#` inside is data);
  // unquoted values drop a trailing ` # comment`.
  const quoted = /^"([^"]*)"|^'([^']*)'/.exec(raw)
  if (quoted) {
    return (quoted[1] ?? quoted[2]) || null
  }
  const unquoted = raw.replace(/\s+#.*$/, '')
  return unquoted || null
}

/** Resolve the provider key, preferring a purpose-created repo `.env` over the
 * OS environment (the developer-testing rule), reading only the one line and
 * never printing the value. `.env.*` variants are deliberately not probed. */
function resolveProviderKey(): { value: string; source: string } | null {
  const envFile = join(REPO_ROOT, '.env')
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const value = parseProviderKeyLine(line)
      if (value) {
        return { value, source: 'repo .env' }
      }
    }
  }
  const fromEnv = process.env[ENV_PROVIDER_KEY]?.trim()
  if (fromEnv) {
    return { value: fromEnv, source: 'OS environment' }
  }
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

/** Idempotent, memoized teardown: destroy the sprite (unless --keep) and write
 * evidence. Signal handlers and main's finally all await the SAME promise, so a
 * second Ctrl+C cannot exit while `sprite destroy` is still in flight. */
function finalize(): Promise<void> {
  if (!finalizePromise) {
    finalizePromise = doFinalize()
  }
  return finalizePromise
}

async function doFinalize(): Promise<void> {
  finalized = true

  // The gate is spriteName, not the step trail: a signal that lands while
  // `sprite create` is still in flight precedes its StepRecord, so scanning
  // `steps` here would skip the kill and the destroy and leak the sprite.
  if (spriteName && !keepSprite) {
    if (currentChild) {
      currentChild.kill('SIGKILL')
      currentChild = null
    }
    const destroyed = await runStep('destroy', 'sprite', ['destroy', '--force', '-s', spriteName], TIMEOUT_DESTROY_MS)
    if (destroyed.code !== 0) {
      await delay(DESTROY_RETRY_DELAY_MS)
      await runStep('destroy', 'sprite', ['destroy', '--force', '-s', spriteName], TIMEOUT_DESTROY_MS)
    }
  } else if (spriteName) {
    recordSkipped('destroy', `--keep: sprite ${spriteName} left running`)
  }

  // Preflight failures abort before a sprite or evidence dir exists; there is
  // no run to write up, and the verdict stays the default 'failed'.
  if (!evidenceDir || !provenance) {
    return
  }

  provenance.finishedAt = new Date().toISOString()

  // Scrub the pulled vitest report in place before it is read or mirrored:
  // failureMessages carry stack/log text that can include secret-shaped
  // strings, and the header promises every byte on disk is scrubbed.
  const resultsPath = join(evidenceDir, 'results.json')
  if (existsSync(resultsPath)) {
    writeFileSync(resultsPath, scrubSecrets(readFileSync(resultsPath, 'utf8'), secrets))
  }
  const tests = summarizeTests(existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8') : null)
  const criticalStatuses = CRITICAL_STEPS.map(
    (name) => steps.find((step) => step.name === name)?.status ?? 'skipped',
  )
  const verdict = overallVerdict(criticalStatuses, testsPassed(tests))
  finalVerdict = verdict

  const summary = {
    overall: verdict,
    provenance,
    steps,
    tests,
    evidenceDir,
  }
  writeFileSync(join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(join(evidenceDir, 'output.log'), outputChunks.join(''))

  rmSync(latestDir, { recursive: true, force: true })
  cpSync(evidenceDir, latestDir, { recursive: true })

  console.log(`\nresult: ${verdict}`)
  if (tests) {
    console.log(`tests: ${tests.passed}/${tests.total} passed, ${tests.failed} failed, ${tests.pending} skipped`)
    if (tests.passed === 0) {
      console.log('  WARNING no live test ran (the tier was collected but skipped)')
    }
    for (const name of tests.failedNames) {
      console.log(`  FAILED ${name}`)
    }
  } else {
    console.log('tests: no parseable results.json (the suite did not complete)')
  }
  console.log(`evidence: ${evidenceDir}`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  keepSprite = options.keep

  // Preflight gate — refuse before creating anything.
  if (!findExecutable('sprite', process.env['PATH'])) {
    throw new Error('e2e-sprite: `sprite` is not on PATH; install the Fly.io Sprites CLI to run this tier')
  }
  const key = resolveProviderKey()
  if (!key) {
    throw new Error(
      `e2e-sprite: no provider key; set ${ENV_PROVIDER_KEY} in the environment or a repo .env`,
    )
  }
  secrets.push(key.value)

  const tag = options.tag ?? resolvePinTag(readFileSync(join(REPO_ROOT, REFS_PATH), 'utf8'))
  spriteName = `hermes-acp-e2e-${randomBytes(4).toString('hex')}`

  const startedAt = new Date()
  evidenceDir = join(REPO_ROOT, EVIDENCE_DIRNAME, evidenceDirName(startedAt, tag))
  latestDir = join(REPO_ROOT, EVIDENCE_DIRNAME, LATEST_DIRNAME)
  mkdirSync(evidenceDir, { recursive: true })

  provenance = {
    host: `${platform()} ${release()}`,
    tag,
    keySource: key.source,
    spriteName,
    startedAt: startedAt.toISOString(),
  }

  console.log(`e2e-sprite: sprite=${spriteName} tag=${tag} key=${key.source}`)

  // Cleanup on interrupt: kill the in-flight child, destroy the sprite, and
  // still write whatever evidence exists. Exit only once teardown completes,
  // so a terminal SIGHUP or a second Ctrl+C cannot leak the sprite mid-destroy.
  const signalExitCode: Readonly<Record<string, number>> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      void finalize().finally(() => process.exit(signalExitCode[signal]))
    })
  }

  try {
    const created = await runStep('create', 'sprite', ['create', '--skip-console', spriteName], TIMEOUT_CREATE_MS)
    if (created.code !== 0) {
      recordSkipped('sync', 'create failed')
      return
    }

    // Sync: tar the working tree (COPYFILE_DISABLE + ._* exclusion keep macOS
    // AppleDouble files from becoming spurious vitest "transform failed"
    // suites), upload, extract into a fresh remote working copy. e2e-evidence
    // is excluded so a run never uploads prior runs' evidence.
    const localTarDir = mkdtempSync(join(tmpdir(), 'hermes-acp-e2e-'))
    const localTar = join(localTarDir, 'sync.tar.gz')
    const localInstall = join(localTarDir, 'install-hermes.sh')
    writeFileSync(localInstall, INSTALL_SCRIPT)
    try {
      const tarStartedAt = Date.now()
      const tarResult = await runLocal(
        'tar',
        [
          '--exclude=./node_modules',
          '--exclude=./dist',
          '--exclude=./.git',
          '--exclude=./.claude',
          // A repo .env is the preferred key source, but the key travels via
          // --env; never ship the file itself onto the sprite's disk.
          '--exclude=./.env',
          '--exclude=./.env.*',
          `--exclude=./${EVIDENCE_DIRNAME}`,
          '--exclude=._*',
          '-czf',
          localTar,
          '-C',
          REPO_ROOT,
          '.',
        ],
        TIMEOUT_SYNC_MS,
        // bsdtar synthesizes AppleDouble (._*) entries from xattrs at archive
        // time, which --exclude does not always catch; COPYFILE_DISABLE stops
        // them at the source so vitest never tries to parse a `._*.e2e.test.ts`.
        { COPYFILE_DISABLE: '1' },
      )
      logSection('step sync: local tar')
      outputChunks.push(scrubSecrets(tarResult.stdout + tarResult.stderr, secrets))
      if (tarResult.code !== 0) {
        steps.push({
          name: 'sync',
          status: tarResult.timedOut ? 'timeout' : 'failed',
          code: tarResult.code,
          signal: tarResult.signal,
          timedOut: tarResult.timedOut,
          durationMs: Date.now() - tarStartedAt,
          note: 'local tar failed',
        })
        return
      }

      const synced = await runStep(
        'sync',
        'sprite',
        [
          'exec',
          '--no-stdin',
          '-s',
          spriteName,
          '--file',
          `${localTar}:${REMOTE_TARBALL}`,
          '--file',
          `${localInstall}:${REMOTE_INSTALL_SCRIPT}`,
          '--',
          'sh',
          '-c',
          `rm -rf ${REMOTE_REPO} && mkdir -p ${REMOTE_REPO} && tar -xzf ${REMOTE_TARBALL} -C ${REMOTE_REPO}`,
        ],
        TIMEOUT_SYNC_MS,
      )
      if (synced.code !== 0) {
        return
      }
    } finally {
      rmSync(localTarDir, { recursive: true, force: true })
    }

    const built = await runStep(
      'build',
      'sprite',
      [
        'exec',
        '--no-stdin',
        '-s',
        spriteName,
        '--dir',
        REMOTE_REPO,
        '--',
        'sh',
        '-c',
        'bun install --ignore-scripts && bun run build',
      ],
      TIMEOUT_BUILD_MS,
    )
    if (built.code !== 0) {
      return
    }

    const installed = await runStep(
      'install-hermes',
      'sprite',
      ['exec', '--no-stdin', '-s', spriteName, '--', 'sh', REMOTE_INSTALL_SCRIPT, tag],
      TIMEOUT_INSTALL_MS,
    )
    const hermesVersion = markerValue(installed.stdout, 'HERMES_VERSION')
    const interpreter = markerValue(installed.stdout, 'INTERP')
    const venvBin = markerValue(installed.stdout, 'VENV_BIN')
    if (hermesVersion) {
      provenance.hermesVersion = hermesVersion
    }
    if (interpreter) {
      provenance.interpreter = interpreter
    }
    if (venvBin) {
      provenance.venvBin = venvBin
    }
    if (installed.code !== 0 || !venvBin) {
      recordSkipped('e2e', 'Hermes install failed')
      recordSkipped('pull-results', 'e2e did not run')
      return
    }

    // e2e: prepend the Hermes venv so the adapter's serve-mode `hermes`
    // resolves, run vitest directly (no rebuild — build already ran) with the
    // JSON reporter writing in-sprite for the pull. The key rides --env; it is
    // never echoed by the remote command.
    await runStep(
      'e2e',
      'sprite',
      [
        'exec',
        '--no-stdin',
        '-s',
        spriteName,
        '--dir',
        REMOTE_REPO,
        '--env',
        `${ENV_PROVIDER_KEY}=${key.value},${ENV_RUN_E2E}=true`,
        '--',
        'sh',
        '-c',
        `export PATH="${venvBin}:$PATH"; exec bunx vitest run --no-file-parallelism --reporter=default --reporter=json --outputFile=${REMOTE_RESULTS} src/__tests__/e2e`,
      ],
      TIMEOUT_E2E_MS,
    )

    // Pull results regardless of the suite verdict: a failing suite still
    // wrote a report, and that report is the evidence.
    await runStep(
      'pull-results',
      'sprite',
      ['file', 'pull', '-s', spriteName, REMOTE_RESULTS, join(evidenceDir, 'results.json')],
      TIMEOUT_PULL_MS,
    )
  } finally {
    await finalize()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => {
      // finalize() ran in main's finally and set finalVerdict from the evidence.
      process.exitCode = finalVerdict === 'passed' ? 0 : 1
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      void finalize().finally(() => {
        process.exitCode = 1
      })
    })
}
