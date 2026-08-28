import { EventEmitter, PassThrough } from 'node:stream'
import type { SpawnOptions } from 'node:child_process'

import { vi } from 'vitest'

import { GatewayClient } from '../gateway/GatewayClient.js'
import type { ChildProcessLike, WebSocketLike, WebSocketLikeEvent } from '../gateway/options.js'

export const READY_FRAME = { jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } }

export class FakeWebSocket implements WebSocketLike {
  readonly sent: string[] = []
  readyState = 0
  private closedByClient = false
  private readonly listeners = new Map<string, Set<(event: WebSocketLikeEvent) => void>>()

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: WebSocketLikeEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  private emit(type: string, event: WebSocketLikeEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === 3) {
      return
    }
    this.closedByClient = true
    this.readyState = 3
    this.emit('close', { code: 1000 })
  }

  // Server-side simulation helpers.
  serverOpen(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  serverSend(frame: object): void {
    this.emit('message', { data: `${JSON.stringify(frame)}\n` })
  }

  serverSendRaw(data: string): void {
    this.emit('message', { data })
  }

  serverError(): void {
    this.emit('error', {})
  }

  serverClose(code = 1006): void {
    this.readyState = 3
    this.emit('close', { code })
  }

  get wasClosedByClient(): boolean {
    return this.closedByClient
  }
}

export class FakeChildProcess extends EventEmitter implements ChildProcessLike {
  readonly pid = 4242
  killed = false
  exitCode: number | null = null
  ignoreSigterm = false
  readonly stdout: PassThrough | null = new PassThrough()
  readonly stderr: PassThrough | null = new PassThrough()
  private readonly killSignals: string[] = []

  constructor() {
    super()
    this.on('exit', () => {
      this.exitCode = this.exitCode ?? 0
    })
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killed = true
    this.killSignals.push(String(signal))
    if (signal === 'SIGTERM' && this.ignoreSigterm) {
      return true
    }
    this.emit('exit', null, signal)
    return true
  }

  get signals(): readonly string[] {
    return this.killSignals
  }

  // Server-side simulation helpers.
  stdoutLine(line: string): void {
    this.stdout?.write(`${line}\n`)
  }

  stderrLine(line: string): void {
    this.stderr?.write(`${line}\n`)
  }

  die(code: number | null): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }

  fail(error: Error): void {
    // A failed spawn (ENOENT) emits 'error' and never 'exit'.
    this.emit('error', error)
  }
}

export interface SpawnRecord {
  readonly child: FakeChildProcess
  readonly command: string
  readonly args: readonly string[]
  readonly options: SpawnOptions
}

export interface Harness {
  client: GatewayClient
  sockets: FakeWebSocket[]
  spawns: SpawnRecord[]
  logs: string[]
}

export const createHarness = (options: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {}): Harness => {
  const sockets: FakeWebSocket[] = []
  const spawns: SpawnRecord[] = []
  const logs: string[] = []
  const client = new GatewayClient({
    mode: 'attach',
    gatewayUrl: 'ws://127.0.0.1:9119/api/ws',
    startupTimeoutMs: 500,
    rpcTimeoutMs: 500,
    log: (message) => logs.push(message),
    webSocketFactory: (url) => {
      const socket = new FakeWebSocket(url)
      sockets.push(socket)
      return socket
    },
    spawnProcess: (command, args, options) => {
      const child = new FakeChildProcess()
      spawns.push({ child, command, args, options })
      return child
    },
    ...options,
  })
  return { client, sockets, spawns, logs }
}

// Readline-based pipelines (child stdout/stderr) settle on later ticks.
export const waitFor = async (probe: () => void): Promise<void> => {
  await vi.waitFor(probe, { timeout: 1_000, interval: 5 })
}

export const startReadyClient = async (): Promise<Harness & { socket: FakeWebSocket }> => {
  const harness = createHarness()
  const started = harness.client.start()
  const socket = harness.sockets[0]!
  socket.serverOpen()
  socket.serverSend(READY_FRAME)
  await started
  return { ...harness, socket }
}

export const startServe = async (harness: Harness): Promise<FakeWebSocket> => {
  const started = harness.client.start()
  harness.spawns[0]!.child.stdoutLine('HERMES_BACKEND_READY port=45678')
  await waitFor(() => {
    if (harness.sockets.length === 0) {
      throw new Error('gateway websocket not created yet')
    }
  })
  const socket = harness.sockets[0]!
  socket.serverOpen()
  socket.serverSend(READY_FRAME)
  await started
  return socket
}
