import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import type { Readable } from 'node:stream'

import {
  DEFAULT_GATEWAY_MODE,
  DEFAULT_RPC_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  ENV_DASHBOARD_SESSION_TOKEN,
  ENV_GATEWAY_MODE,
  ENV_GATEWAY_URL,
  ENV_HERMES_BIN,
  ENV_HERMES_HOME,
  ENV_RPC_TIMEOUT_MS,
  ENV_SESSION_TOKEN,
  ENV_STARTUP_TIMEOUT_MS,
  GATEWAY_MODE_ATTACH,
  GATEWAY_MODE_SERVE,
  MAX_TIMEOUT_MS,
} from '../constants.js'

export type GatewayMode = typeof GATEWAY_MODE_SERVE | typeof GATEWAY_MODE_ATTACH

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessLike

/** The `hermes serve` child: stdout carries the port sentinel, stderr the
 * diagnostics tail; the protocol itself rides the WebSocket. */
export interface ChildProcessLike {
  readonly pid?: number | undefined
  readonly killed: boolean
  readonly exitCode: number | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface WebSocketLikeEvent {
  readonly data?: unknown
  readonly code?: number
}

export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: WebSocketLikeEvent) => void,
  ): void
}

export interface GatewayClientOptions {
  readonly mode?: GatewayMode | undefined
  readonly gatewayUrl?: string | undefined
  readonly sessionToken?: string | undefined
  readonly hermesBin?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly webSocketFactory?: ((url: string) => WebSocketLike) | undefined
  readonly spawnProcess?: SpawnFn | undefined
  readonly startupTimeoutMs?: number | undefined
  readonly rpcTimeoutMs?: number | undefined
  readonly killGraceMs?: number | undefined
  /** Diagnostics sink (child output, protocol violations). Default: stderr. */
  readonly log?: ((message: string) => void) | undefined
}

export const expandHome = (path: string): string => {
  if (path === '~') {
    return homedir()
  }
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return resolve(homedir(), path.slice(2))
  }
  return resolve(path)
}

/**
 * The Hermes home directory, resolved exactly as upstream does
 * (`hermes_constants.py` `_hermes_home_from_env` +
 * `_get_platform_default_hermes_home`): HERMES_HOME from the environment, then
 * the platform default. The session-cwd cache lives under it
 * (src/session/sessionDirectory.ts), so the two sides must agree on where
 * home is — the gateway child inherits this same environment.
 */
export function resolveHermesHome(env: NodeJS.ProcessEnv): string {
  const configured = env[ENV_HERMES_HOME]?.trim()
  if (configured) {
    return expandHome(configured)
  }
  if (process.platform === 'win32') {
    const localAppData = env['LOCALAPPDATA']?.trim()
    return resolve(localAppData || resolve(homedir(), 'AppData', 'Local'), 'hermes')
  }
  return resolve(homedir(), '.hermes')
}

export const parseEnvMilliseconds = (name: string, raw: string | undefined, fallback: number): number => {
  const trimmed = raw?.trim()
  if (!trimmed) {
    return fallback
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer number of milliseconds, got ${JSON.stringify(raw)}`)
  }
  const value = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds, got ${JSON.stringify(raw)}`)
  }
  if (value > MAX_TIMEOUT_MS) {
    throw new Error(`${name} must be at most ${MAX_TIMEOUT_MS}ms, got ${JSON.stringify(raw)}`)
  }
  return value
}

/** Build client options from a process environment (see constants.ts for the
 * variable names). Fails fast on contradictory configuration. */
export function gatewayOptionsFromEnv(env: NodeJS.ProcessEnv): GatewayClientOptions {
  const rawMode = env[ENV_GATEWAY_MODE]?.trim()
  const mode = rawMode || DEFAULT_GATEWAY_MODE
  if (mode !== GATEWAY_MODE_SERVE && mode !== GATEWAY_MODE_ATTACH) {
    throw new Error(
      `${ENV_GATEWAY_MODE} must be one of ${GATEWAY_MODE_SERVE}|${GATEWAY_MODE_ATTACH}, got ${JSON.stringify(mode)}`,
    )
  }

  const gatewayUrl = env[ENV_GATEWAY_URL]?.trim()
  if (mode === GATEWAY_MODE_ATTACH && !gatewayUrl) {
    throw new Error(`${ENV_GATEWAY_URL} is required when ${ENV_GATEWAY_MODE}=${GATEWAY_MODE_ATTACH}`)
  }
  if (mode !== GATEWAY_MODE_ATTACH && gatewayUrl) {
    throw new Error(`${ENV_GATEWAY_URL} only applies when ${ENV_GATEWAY_MODE}=${GATEWAY_MODE_ATTACH}`)
  }

  const hermesBin = env[ENV_HERMES_BIN]?.trim()
  if (mode !== GATEWAY_MODE_SERVE && hermesBin) {
    throw new Error(`${ENV_HERMES_BIN} only applies when ${ENV_GATEWAY_MODE}=${GATEWAY_MODE_SERVE}`)
  }

  // The adapter-owned token variable first; the Hermes-owned ambient one (a
  // Hermes Desktop shell may export it) is the fallback.
  const sessionToken = env[ENV_SESSION_TOKEN]?.trim() || env[ENV_DASHBOARD_SESSION_TOKEN]?.trim()

  return {
    mode,
    gatewayUrl: gatewayUrl || undefined,
    sessionToken: sessionToken || undefined,
    hermesBin: hermesBin || undefined,
    env,
    startupTimeoutMs: parseEnvMilliseconds(ENV_STARTUP_TIMEOUT_MS, env[ENV_STARTUP_TIMEOUT_MS], DEFAULT_STARTUP_TIMEOUT_MS),
    rpcTimeoutMs: parseEnvMilliseconds(ENV_RPC_TIMEOUT_MS, env[ENV_RPC_TIMEOUT_MS], DEFAULT_RPC_TIMEOUT_MS),
  }
}
