/**
 * The live-tier fixture: spawn the BUILT adapter as a child process, drive it
 * as a real ACP client over stdio, and tear both it and its scratch Hermes home
 * down afterwards.
 *
 * Two deliberate choices:
 *   - The subject is `dist/index.js`, not the TypeScript sources. The bundle is
 *     what ships and what clients execute, so an e2e that never loads it
 *     would miss exactly the entry/transport breakage this tier exists to catch
 *     (.rules requires a dist smoke run for transport changes).
 *   - Hermes runs against a per-test scratch `HERMES_HOME`, which it bootstraps
 *     itself (`hermes_cli/config.py` mkdirs the home), so a live run cannot
 *     mutate the developer's real Hermes config, sessions, or MCP servers.
 *
 * The provider key reaches Hermes through the child ENVIRONMENT: with
 * multiplexing off (the default; `agent/secret_scope.py` only flips it in
 * upstream tests) a profile secret scope is an overlay over `os.environ`, so
 * `get_secret('OPENROUTER_API_KEY')` falls through to the inherited value and
 * no `.env` has to be written into the scratch home.
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import * as acp from '@agentclientprotocol/sdk'
import type {
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import { vi } from 'vitest'

import {
  ENV_GATEWAY_MODE,
  ENV_HERMES_HOME,
  GATEWAY_MODE_SERVE,
  KILL_GRACE_MS,
  PROTOCOL_VERSION,
} from '../../constants.js'
import { ENV_PROVIDER_API_KEY, requireEnv } from './e2eGate.js'

// ── Constants ───────────────────────────────────────────────────────────────

const E2E_CLIENT_NAME = 'hermes-acp-e2e-client'
const SCRATCH_PREFIX = 'hermes-acp-e2e-'
const HOME_DIRNAME = 'hermes-home'
const WORKSPACE_DIRNAME = 'workspace'

/** dist/index.js, relative to this file (src/__tests__/e2e). */
const DIST_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js')

/** Permission and elicitation round-trips fail closed here exactly as they do
 * in the snapshot tier: an unanswered card is a denial, never an allow. */
const FAIL_CLOSED_PERMISSION: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
const FAIL_CLOSED_ELICITATION: CreateElicitationResponse = { action: 'cancel' }

/** Redaction applied to every captured child log line before it can reach a
 * test report. `.rules` forbids logging secrets, and this tier necessarily runs
 * with a real provider key in the environment. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /(authorization:\s*bearer\s+)\S+/gi,
  // Everything after the `sk-` marker goes: an OpenRouter key is `sk-or-v1-…`,
  // so keeping even a few characters would publish part of the real secret.
  /(sk-)[A-Za-z0-9_-]+/g,
  /((?:api[_-]?key|token)["'\s:=]+)\S+/gi,
]
const REDACTED = '$1<redacted>'

const POLL_INTERVAL_MS = 50

export interface ScratchPaths {
  readonly hermesHome: string
  readonly workspace: string
}

export interface SpawnedAgentOptions {
  /** Extra child environment (transport mode overrides, for the spawn-mode
   * variant). Serve mode is the default: it avoids the python-resolution
   * heuristic entirely. */
  readonly env?: Readonly<Record<string, string>>
  /** Run against an existing home instead of a fresh one — what a
   * second-process load/resume needs, since the stored session only exists in
   * the home that created it. Paths passed in are NOT removed on stop; the
   * fixture that made them owns them. */
  readonly paths?: ScratchPaths
}

export interface SpawnedAgent {
  /** The scratch Hermes home the child runs against. */
  readonly hermesHome: string
  /** The scratch workspace sessions are opened at. */
  readonly workspace: string
  readonly child: ChildProcessWithoutNullStreams
  /** Agent-side ACP methods (initialize, session/*), as a client sees them. */
  readonly agent: acp.ClientContext
  /** Every `session/update` received, in arrival order. */
  readonly updates: readonly SessionNotification[]
  /** Every `session/request_permission` received, in arrival order; each was
   * answered with the fail-closed default (a denial toward Hermes). */
  readonly permissionRequests: readonly RequestPermissionRequest[]
  /** Accumulated `agent_message_chunk` text for one session. */
  agentText(sessionId: string): string
  /** Wait until the accumulated agent text for `sessionId` matches. */
  waitForText(sessionId: string, matches: (text: string) => boolean, timeoutMs: number): Promise<string>
  /** Captured child stderr, secret-scrubbed. */
  logDump(): string
  /** Close the connection, stop the child (SIGTERM then SIGKILL), remove the
   * scratch home. Safe to call twice. */
  stop(): Promise<void>
}

function scrub(text: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, REDACTED), text)
}

/** Scratch dirs for one live run: an isolated Hermes home plus the workspace
 * sessions are rooted at. The caller owns `root` and must remove it — the
 * fixture only cleans up scratch it created itself. */
export function createScratchPaths(): { readonly root: string; readonly hermesHome: string; readonly workspace: string } {
  const root = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX))
  const hermesHome = join(root, HOME_DIRNAME)
  const workspace = join(root, WORKSPACE_DIRNAME)
  mkdirSync(hermesHome, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  return { root, hermesHome, workspace }
}

/**
 * Spawn the built adapter with a scratch home and the provider key, without
 * any ACP wiring. The half-dead-client characterization needs the raw child:
 * it has to stop draining stdout, which is impossible once the SDK's reader
 * owns the stream.
 */
export function spawnAgentProcess(
  hermesHome: string,
  workspace: string,
  options: SpawnedAgentOptions = {},
): ChildProcessWithoutNullStreams {
  const providerKey = requireEnv(ENV_PROVIDER_API_KEY)
  return spawn(process.execPath, [DIST_ENTRY], {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      // Hermetic tier: every adapter/Hermes variable shares the HERMES_
      // prefix (src/constants.ts), so drop them all rather than let host
      // config (e.g. an operator's HERMES_ACP_RPC_TIMEOUT_MS) steer the
      // child. The explicit entries below re-add what the tier needs.
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERMES_'))),
      [ENV_HERMES_HOME]: hermesHome,
      [ENV_PROVIDER_API_KEY]: providerKey,
      [ENV_GATEWAY_MODE]: GATEWAY_MODE_SERVE,
      ...options.env,
    },
  })
}

/** SIGTERM, then SIGKILL if the child is still up after the grace window. */
export async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return
  }
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => {
      resolveExit()
    })
  })
  child.kill('SIGTERM')
  const killer = setTimeout(() => {
    child.kill('SIGKILL')
  }, KILL_GRACE_MS)
  try {
    await exited
  } finally {
    clearTimeout(killer)
  }
}

/**
 * Spawn the built adapter and connect to it as an ACP client.
 *
 * `initialize` is performed here: every case needs it, and a handshake failure
 * should surface as the fixture failing rather than as a confusing method
 * error inside the first test.
 */
export async function createSpawnedAgent(options: SpawnedAgentOptions = {}): Promise<SpawnedAgent> {
  const owned = options.paths === undefined ? createScratchPaths() : null
  const paths = options.paths ?? {
    hermesHome: owned?.hermesHome ?? '',
    workspace: owned?.workspace ?? '',
  }
  const child = spawnAgentProcess(paths.hermesHome, paths.workspace, options)

  const logLines: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    logLines.push(scrub(chunk))
  })

  const updates: SessionNotification[] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const clientApp = acp
    .client({ name: E2E_CLIENT_NAME })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      updates.push(ctx.params)
    })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      permissionRequests.push(ctx.params)
      return FAIL_CLOSED_PERMISSION
    })
    .onRequest(acp.methods.client.elicitation.create, () => FAIL_CLOSED_ELICITATION)

  const connection = clientApp.connect(
    acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  )

  let stopped = false
  const agentText = (sessionId: string): string =>
    updates
      .filter((notification) => notification.sessionId === sessionId)
      .map((notification) => notification.update)
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => (update.content.type === 'text' ? update.content.text : ''))
      .join('')

  const fixture: SpawnedAgent = {
    hermesHome: paths.hermesHome,
    workspace: paths.workspace,
    child,
    agent: connection.agent,
    updates,
    permissionRequests,
    agentText,
    async waitForText(sessionId, matches, timeoutMs) {
      return await vi.waitFor(
        () => {
          const text = agentText(sessionId)
          if (!matches(text)) {
            throw new Error(`agent text has not matched yet: ${JSON.stringify(text)}`)
          }
          return text
        },
        { timeout: timeoutMs, interval: POLL_INTERVAL_MS },
      )
    },
    logDump: () => logLines.join(''),
    async stop() {
      if (stopped) {
        return
      }
      stopped = true
      connection.close()
      await stopChild(child)
      if (owned !== null) {
        rmSync(owned.root, { recursive: true, force: true })
      }
    },
  }

  try {
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
  } catch (error) {
    await fixture.stop()
    throw new Error(`e2e: the spawned adapter failed to initialize: ${String(error)}\n${scrub(logLines.join(''))}`)
  }

  return fixture
}
