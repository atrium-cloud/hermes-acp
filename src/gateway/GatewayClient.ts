import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'

import {
  DEFAULT_GATEWAY_MODE,
  DEFAULT_HERMES_BIN,
  DEFAULT_RPC_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  ENV_DASHBOARD_SESSION_TOKEN,
  FRAME_PREVIEW_MAX_CHARS,
  ENV_SERVE_PARENT_PID,
  ENV_SESSION_TOKEN,
  GATEWAY_MODE_ATTACH,
  GATEWAY_MODE_SERVE,
  GATEWAY_WS_PATH,
  KILL_GRACE_MS,
  SERVE_AUTO_PORT,
  SERVE_HOST,
  SERVE_READY_PATTERN,
  STDERR_LINE_MAX_CHARS,
  STDERR_TAIL_LINES,
} from '../constants.js'
import type { ChildProcessLike, GatewayClientOptions, GatewayMode, SpawnFn, WebSocketLike } from './options.js'
import { expandHome } from './options.js'
import {
  isKnownGatewayEventType,
  isKnownServerRequestMethod,
  type GatewayEvent,
  type GatewayServerRequest,
} from './types.js'

export class GatewayRpcError extends Error {
  readonly code: number | undefined
  readonly data: unknown

  constructor(message: string, code?: number, data?: unknown) {
    super(message)
    this.name = 'GatewayRpcError'
    this.code = code
    this.data = data
  }
}

interface PendingRequest {
  readonly method: string
  readonly reject: (error: Error) => void
  readonly resolve: (value: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const WS_READY_STATE_OPEN = 1
// Close code the Hermes gateway sends when the WS-upgrade credential is
// rejected (web_server.py gateway_ws).
const WS_CLOSE_UNAUTHORIZED = 4401
// JSON-RPC 2.0 error codes sent back on a server→client request this adapter
// will not answer: a method it does not implement, and a known method whose
// params are not the object its contract pins.
const JSON_RPC_METHOD_NOT_FOUND = -32601
const JSON_RPC_INVALID_PARAMS = -32602

const defaultSpawn: SpawnFn = (command, args, options) => spawn(command, [...args], options)

const defaultWebSocketFactory = (url: string): WebSocketLike => {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket
  if (typeof ctor !== 'function') {
    throw new Error('no global WebSocket implementation available to reach the Hermes gateway')
  }
  return new (ctor as new (url: string) => WebSocketLike)(url)
}

const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)))

const preview = (line: string): string => line.slice(0, FRAME_PREVIEW_MAX_CHARS) || '(empty line)'

// Gateway URLs may carry the session token as a query param; every URL that
// enters a log line or error message must pass through here first.
const redactTokenInUrl = (url: string): string => url.replace(/([?&]token=)[^&]*/gi, '$1<redacted>')

/**
 * JSON-RPC client for the Hermes tui_gateway.
 *
 * Wire protocol (tui_gateway/ws.py): newline-delimited JSON-RPC 2.0 over the
 * gateway's WebSocket. Server→client notifications always use
 * `method: "event"` with `{type, session_id?, payload?}` params; responses
 * echo the caller's integer id. The gateway also issues server→client
 * requests (tui_gateway/server_requests.py) — `{id: "srq-…", method, params}`
 * with a string id — for the blocking prompts (approval, clarify, …); they
 * are answered with a response frame carrying that id, never with a method
 * call. A request whose method this adapter has no handler for is refused
 * with JSON-RPC method-not-found, which upstream reads as "unanswered" and
 * returns to the blocked tool at once instead of after its timeout.
 *
 * Lifecycle: `start()` resolves once the gateway's `gateway.ready` event has
 * been observed (or rejects with the child's stderr tail if it dies or
 * stalls). `kill()` tears the transport down: close for the socket, SIGTERM
 * then SIGKILL for the managed `hermes serve` child.
 */
export class GatewayClient {
  private readonly mode: GatewayMode
  private readonly gatewayUrl: string | undefined
  private readonly sessionToken: string | undefined
  private readonly hermesBin: string
  private readonly env: NodeJS.ProcessEnv
  private readonly webSocketFactory: (url: string) => WebSocketLike
  private readonly spawnProcess: SpawnFn
  private readonly startupTimeoutMs: number
  private readonly rpcTimeoutMs: number
  private readonly killGraceMs: number
  private readonly log: (message: string) => void

  private proc: ChildProcessLike | null = null
  private ws: WebSocketLike | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private readonly eventHandlers = new Set<(event: GatewayEvent) => void>()
  private readonly serverRequestHandlers = new Set<(request: GatewayServerRequest) => void>()
  private readonly exitHandlers = new Set<(code: number | null) => void>()
  private readonly stderrTail: string[] = []
  private nextRequestId = 0

  private started = false
  private killed = false
  private transportClosed = false
  private sawReady = false
  private readyGate: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private killPromise: Promise<void> | null = null

  constructor(options: GatewayClientOptions = {}) {
    this.mode = options.mode ?? DEFAULT_GATEWAY_MODE
    this.gatewayUrl = options.gatewayUrl
    this.sessionToken = options.sessionToken
    this.hermesBin = options.hermesBin ?? DEFAULT_HERMES_BIN
    this.env = options.env ?? process.env
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory
    this.spawnProcess = options.spawnProcess ?? defaultSpawn
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS
    this.log = options.log ?? ((message: string) => console.error(`[hermes-agent-acp] ${message}`))
  }

  /** Subscribe to gateway events (known types only; unknown types are
   * logged and dropped). Returns an unsubscribe function. */
  onEvent(handler: (event: GatewayEvent) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  /** Subscribe to server→client requests (known methods only; an unknown
   * method is refused on the wire before reaching any handler). Returns an
   * unsubscribe function. */
  onServerRequest(handler: (request: GatewayServerRequest) => void): () => void {
    this.serverRequestHandlers.add(handler)
    return () => this.serverRequestHandlers.delete(handler)
  }

  /** Answer a server→client request. Throws when the transport is gone; the
   * caller decides whether that is worth reporting (the request died with it). */
  respond(requestId: string, result: object): void {
    this.writeRequest({ jsonrpc: '2.0', id: requestId, result })
  }

  /** Subscribe to post-startup transport loss. Returns an unsubscribe
   * function. During startup, failures surface through `start()` instead. */
  onExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('gateway already started')
    }
    this.started = true

    // The ready gate settles on the first gateway.ready event (or on failure
    // paths below). The no-op catch marks early rejections as observed for
    // the window where no starter step is awaiting it yet.
    this.readyGate = new Promise<void>((resolve, reject) => {
      if (this.sawReady) {
        resolve()
        return
      }
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.readyGate.catch(() => {})

    const mode = this.mode
    let setup: Promise<void>
    switch (mode) {
      case GATEWAY_MODE_ATTACH:
        setup = this.startAttached()
        break
      case GATEWAY_MODE_SERVE:
        setup = this.startServe()
        break
    }
    // Mark setup's rejection as observed: if `deadline` wins the race below, the
    // rejected setup promise would otherwise surface as an unhandled rejection.
    // The real error still propagates through Promise.race / failReady.
    setup.catch(() => {})

    const deadline = new Promise<never>((_, reject) => {
      this.readyTimer = setTimeout(() => {
        const timeoutError = new Error(
          `timed out after ${this.startupTimeoutMs}ms starting Hermes gateway (${mode} mode)${this.stderrTailSuffix()}`,
        )
        this.failReady(timeoutError)
        reject(timeoutError)
      }, this.startupTimeoutMs)
      this.readyTimer.unref()
    })

    try {
      await Promise.race([setup, deadline])
    } catch (error) {
      await this.kill(`startup failed: ${toError(error).message}`)
      throw error
    } finally {
      this.clearReadyTimer()
    }
  }

  /**
   * `timeoutMs` overrides the client-wide RPC budget for this one call. It
   * exists for reads on a client-facing round-trip whose caller can degrade
   * usefully — the default budget is sized for the slowest gateway method, not
   * for how long a client will wait on a handshake.
   */
  request<Params extends object, Result>(method: string, params: Params, timeoutMs?: number): Promise<Result> {
    const id = ++this.nextRequestId
    const budget = timeoutMs ?? this.rpcTimeoutMs
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`gateway request timed out after ${budget}ms: ${method}`))
      }, budget)
      timer.unref()

      this.pending.set(id, {
        method,
        reject,
        resolve: resolve as (value: unknown) => void,
        timer,
      })

      try {
        this.writeRequest({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(toError(error))
      }
    })
  }

  /** Tear the gateway down: reject pending RPCs, close the socket, SIGTERM
   * (then SIGKILL after the grace period) the spawned child. Idempotent.
   * Intentional teardown does not emit onExit — that channel is reserved
   * for unexpected transport loss. */
  kill(reason = 'requested'): Promise<void> {
    if (this.killPromise) {
      return this.killPromise
    }
    this.killed = true
    this.clearReadyTimer()
    this.rejectPending(new Error(`gateway closed: ${reason}`))
    this.failReady(new Error(`gateway closed: ${reason}`))

    // Null references BEFORE closing so the identity-guarded close handlers
    // recognize this as an intentional teardown instead of transport loss.
    const ws = this.ws
    this.ws = null
    try {
      ws?.close()
    } catch {
      // Socket already gone; teardown is best-effort.
    }

    const proc = this.proc
    this.proc = null
    if (!proc || proc.exitCode !== null) {
      this.killPromise = Promise.resolve()
      return this.killPromise
    }

    this.killPromise = new Promise<void>((resolve) => {
      let settled = false
      let grace: ReturnType<typeof setTimeout> | null = null

      const finish = () => {
        if (!settled) {
          settled = true
          if (grace) {
            clearTimeout(grace)
            grace = null
          }
          resolve()
        }
      }

      proc.on('exit', finish)

      try {
        proc.kill('SIGTERM')
      } catch {
        finish()
        return
      }

      grace = setTimeout(() => {
        if (!settled && proc.exitCode === null) {
          try {
            proc.kill('SIGKILL')
          } catch {
            // Child already gone; teardown is best-effort.
          }
        }
        finish()
      }, this.killGraceMs)
      grace.unref()
    })

    return this.killPromise
  }

  // ── Transport startup ───────────────────────────────────────────────────

  private async startAttached(): Promise<void> {
    if (!this.gatewayUrl) {
      throw new Error('attach mode requires a gateway URL')
    }
    let url: URL
    try {
      url = new URL(this.gatewayUrl)
    } catch {
      throw new Error(`invalid gateway websocket URL for attach mode: ${redactTokenInUrl(this.gatewayUrl)}`)
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error(
        `gateway URL for attach mode must be ws:// or wss://, got ${url.protocol} in ${redactTokenInUrl(this.gatewayUrl)}`,
      )
    }
    const token =
      this.sessionToken || this.env[ENV_SESSION_TOKEN]?.trim() || this.env[ENV_DASHBOARD_SESSION_TOKEN]?.trim()
    if (token && !url.searchParams.has('token')) {
      url.searchParams.set('token', token)
    }
    await this.connectWebSocket(url.toString())
    await this.readyGate
  }

  private async startServe(): Promise<void> {
    const bin = this.hermesBin.startsWith('~') ? expandHome(this.hermesBin) : this.hermesBin
    const token =
      this.sessionToken ||
      this.env[ENV_SESSION_TOKEN]?.trim() ||
      this.env[ENV_DASHBOARD_SESSION_TOKEN]?.trim() ||
      randomBytes(32).toString('hex')

    const child = this.spawnProcess(
      bin,
      ['serve', '--host', SERVE_HOST, '--port', SERVE_AUTO_PORT, '--isolated'],
      {
        env: {
          ...this.env,
          // `hermes serve` arms a parent-death watchdog from this PID, so an
          // adapter that crashes without kill() cannot leak the backend.
          [ENV_SERVE_PARENT_PID]: String(process.pid),
          [ENV_DASHBOARD_SESSION_TOKEN]: token,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    this.proc = child
    this.attachChildLogging(child, `hermes serve (${bin})`)

    const port = await this.discoverServePort(child)
    await this.connectWebSocket(`ws://${SERVE_HOST}:${port}${GATEWAY_WS_PATH}?token=${encodeURIComponent(token)}`)
    await this.readyGate
  }

  /** Watch `hermes serve` stdout for the port sentinel. Non-sentinel lines
   * (banner, bind notices) are forwarded to the diagnostics sink. Rejects
   * when the child exits or fails to spawn before announcing a port. */
  private discoverServePort(child: ChildProcessLike): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const stdout = child.stdout
      if (!stdout) {
        reject(new Error('hermes serve child has no stdout pipe'))
        return
      }
      let settled = false
      const fail = (error: Error): void => {
        if (settled) {
          return
        }
        settled = true
        reject(error)
      }
      const lines = createInterface({ input: stdout })
      lines.on('line', (line: string) => {
        const match = SERVE_READY_PATTERN.exec(line.trim())
        if (match) {
          if (!settled) {
            settled = true
            resolve(Number.parseInt(match[1] as string, 10))
          }
          return
        }
        if (line.trim()) {
          this.log(`[${child.pid ?? 'hermes-serve'}] ${line}`)
        }
      })
      child.on('exit', (code) => {
        fail(
          new Error(
            `hermes serve exited before announcing its port (code ${code ?? 'null'})${this.stderrTailSuffix()}`,
          ),
        )
      })
      // A failed spawn (ENOENT, EACCES) emits 'error' without 'exit'.
      child.on('error', (error) => {
        fail(new Error(`hermes serve failed to start: ${error.message}${this.stderrTailSuffix()}`))
      })
    })
  }

  private connectWebSocket(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let ws: WebSocketLike
      try {
        ws = this.webSocketFactory(url)
      } catch (error) {
        reject(toError(error))
        return
      }
      this.ws = ws

      ws.addEventListener('open', () => {
        if (settled) {
          return
        }
        settled = true
        resolve()
      })
      ws.addEventListener('error', () => {
        if (settled) {
          this.log(`gateway websocket error at ${redactTokenInUrl(url)}`)
          return
        }
        settled = true
        reject(new Error(`failed to connect to gateway websocket at ${redactTokenInUrl(url)}`))
      })
      ws.addEventListener('close', (event) => {
        const code = typeof event.code === 'number' ? ` (code ${event.code})` : ''
        // Any close during connect settles the connect promise — including
        // ones triggered by a child exit tearing the socket down.
        if (!settled) {
          settled = true
          // 4401 is the gateway's WS-auth rejection (web_server.py _ws_auth_ok).
          // In serve mode the adapter minted the token itself, so 4401 there
          // means env propagation into the child failed, not misconfiguration.
          const hint =
            event.code === WS_CLOSE_UNAUTHORIZED && this.mode === GATEWAY_MODE_ATTACH
              ? `; the gateway rejected the session token — set ${ENV_SESSION_TOKEN} (or include ?token= in the attach URL)`
              : ''
          reject(new Error(`gateway websocket closed during connect${code}${hint}`))
          return
        }
        if (this.ws !== ws) {
          return // Stale socket replaced by a restart or intentional kill.
        }
        this.handleTransportExit(null, `gateway websocket closed${code}`)
      })
      ws.addEventListener('message', (event) => {
        this.handleWireText(event.data)
      })
    })
  }

  // ── Frame handling ──────────────────────────────────────────────────────

  private writeRequest(frame: object): void {
    if (this.killed || this.transportClosed || !this.ws) {
      throw new Error('gateway is not connected')
    }
    if (this.ws.readyState !== WS_READY_STATE_OPEN) {
      throw new Error(`gateway websocket is not open (readyState ${this.ws.readyState})`)
    }
    this.ws.send(JSON.stringify(frame))
  }

  private handleWireText(raw: unknown): void {
    if (typeof raw !== 'string') {
      this.log(`ignoring non-text gateway websocket frame: ${typeof raw}`)
      return
    }
    const lines = raw.split(/\r?\n/)
    for (const line of lines) {
      if (line.trim()) {
        this.handleFrame(line)
      }
    }
  }

  private handleFrame(rawLine: string): void {
    const line = rawLine.trim()
    if (!line) {
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      this.log(`malformed gateway frame: ${preview(line)}`)
      return
    }
    if (typeof frame !== 'object' || frame === null) {
      this.log(`malformed gateway frame (not an object): ${preview(line)}`)
      return
    }
    const record = frame as Record<string, unknown>

    if (typeof record['method'] === 'string') {
      if (typeof record['id'] === 'string') {
        this.handleServerRequest(record['id'], record['method'], record['params'])
        return
      }
      if (record['method'] === 'event') {
        this.handleEvent(record['params'])
        return
      }
      this.log(`ignoring unexpected gateway notification method: ${record['method']}`)
      return
    }

    if (typeof record['id'] === 'number') {
      this.settleResponse(record['id'], record)
      return
    }
    this.log(`ignoring unaddressable gateway frame: ${preview(line)}`)
  }

  private settleResponse(id: number, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) {
      this.log(`response for unknown gateway request id: ${id}`)
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)

    const error = frame['error']
    if (typeof error === 'object' && error !== null) {
      const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown }
      pending.reject(
        new GatewayRpcError(
          typeof message === 'string' ? message : 'gateway request failed',
          typeof code === 'number' ? code : undefined,
          data,
        ),
      )
      return
    }
    pending.resolve(frame['result'])
  }

  private handleServerRequest(id: string, method: string, params: unknown): void {
    if (!isKnownServerRequestMethod(method)) {
      this.log(`refusing gateway server request ${id} with unsupported method: ${method}`)
      this.refuseServerRequest(
        id,
        JSON_RPC_METHOD_NOT_FOUND,
        `hermes-agent-acp has no handler for server request method ${method}`,
      )
      return
    }
    if (typeof params !== 'object' || params === null) {
      this.log(`refusing gateway server request ${id} (${method}) without a params object`)
      this.refuseServerRequest(id, JSON_RPC_INVALID_PARAMS, `server request ${method} carried no params object`)
      return
    }
    // Shapes are pinned in types.ts and trusted on the wire, as for events.
    const request = { id, method, params } as GatewayServerRequest
    for (const handler of this.serverRequestHandlers) {
      try {
        handler(request)
      } catch (error) {
        this.log(`server request handler threw: ${toError(error).message}`)
      }
    }
  }

  /** A JSON-RPC error frame for a request this adapter will never answer. A
   * transport that is already gone has nothing to refuse to. */
  private refuseServerRequest(id: string, code: number, message: string): void {
    try {
      this.writeRequest({ jsonrpc: '2.0', id, error: { code, message } })
    } catch (error) {
      this.log(`could not refuse gateway server request ${id}: ${toError(error).message}`)
    }
  }

  private handleEvent(params: unknown): void {
    if (typeof params !== 'object' || params === null) {
      this.log('gateway event without params object')
      return
    }
    const raw = params as { type?: unknown; session_id?: unknown }
    if (typeof raw.type !== 'string') {
      this.log('gateway event without a type string')
      return
    }
    if (!isKnownGatewayEventType(raw.type)) {
      this.log(`ignoring unknown gateway event type: ${raw.type}`)
      return
    }

    // Shapes are pinned in types.ts and trusted on the wire; the cast is the
    // single place parsed frames enter the typed surface.
    const event = params as GatewayEvent
    if (event.type === 'gateway.ready') {
      this.sawReady = true
      this.resolveReady()
    }
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (error) {
        this.log(`event handler threw: ${toError(error).message}`)
      }
    }
  }

  // ── Child plumbing ──────────────────────────────────────────────────────

  /** Wire the `hermes serve` child's stderr tail and exit to the client;
   * its stdout is consumed by discoverServePort (sentinel + logs). */
  private attachChildLogging(child: ChildProcessLike, label: string): void {
    if (child.stderr) {
      const stderrLines = createInterface({ input: child.stderr })
      stderrLines.on('line', (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) {
          return
        }
        this.recordStderr(trimmed)
        this.log(`[${label}] ${trimmed}`)
      })
    }

    child.on('error', (error) => {
      this.log(`[${label}] failed to start: ${error.message}`)
      this.handleTransportExit(null, `gateway child failed to start: ${error.message}`)
    })
    child.on('exit', (code) => {
      this.log(`[${label}] exited (code ${code ?? 'null'})`)
      this.handleTransportExit(code, `gateway child exited (code ${code ?? 'null'})`)
    })
  }

  private handleTransportExit(code: number | null, reason: string): void {
    if (this.killed || this.transportClosed) {
      return
    }
    this.transportClosed = true
    // Both channels carry the stderr tail: for a post-startup death the Python
    // traceback in stderr is the only diagnostic, and in-flight RPCs
    // (rejectPending) are exactly where such a death surfaces.
    const detail = `${reason}${this.stderrTailSuffix()}`
    this.failReady(new Error(detail))
    this.rejectPending(new Error(detail))

    // The sibling transport dies with the child; close it without another
    // exit round-trip (identity guard in its close handler sees this.ws null).
    const ws = this.ws
    this.ws = null
    try {
      ws?.close()
    } catch {
      // Socket already gone; teardown is best-effort.
    }

    if (this.sawReady) {
      for (const handler of this.exitHandlers) {
        try {
          handler(code)
        } catch (error) {
          this.log(`exit handler threw: ${toError(error).message}`)
        }
      }
    }
  }

  // ── Bookkeeping ─────────────────────────────────────────────────────────

  private resolveReady(): void {
    const resolve = this.readyResolve
    this.readyResolve = null
    this.readyReject = null
    resolve?.()
  }

  private failReady(error: Error): void {
    const reject = this.readyReject
    this.readyResolve = null
    this.readyReject = null
    reject?.(error)
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private recordStderr(line: string): void {
    this.stderrTail.push(line.length > STDERR_LINE_MAX_CHARS ? `${line.slice(0, STDERR_LINE_MAX_CHARS)}…` : line)
    if (this.stderrTail.length > STDERR_TAIL_LINES) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LINES)
    }
  }

  private stderrTailSuffix(): string {
    if (this.stderrTail.length === 0) {
      return ''
    }
    return `\nlast gateway stderr lines:\n${this.stderrTail.map((line) => `  ${line}`).join('\n')}`
  }
}
