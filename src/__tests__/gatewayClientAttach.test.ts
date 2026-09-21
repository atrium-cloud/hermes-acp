import { describe, expect, it } from 'vitest'

import { ENV_SESSION_TOKEN } from '../constants.js'
import type { GatewayEvent, GatewayServerRequest } from '../gateway/types.js'
import { createHarness, READY_FRAME, startReadyClient } from './gatewayTestDoubles.js'

describe('GatewayClient over WebSocket (attach mode)', () => {
  it('resolves start after open + gateway.ready and round-trips requests', async () => {
    const { client, socket } = await startReadyClient()

    const response = client.request('session.create', { cwd: '/tmp' })
    const sent = JSON.parse(socket.sent[0]!) as { jsonrpc: string; id: number; method: string; params: object }
    expect(sent).toMatchObject({ jsonrpc: '2.0', method: 'session.create', params: { cwd: '/tmp' } })

    socket.serverSend({ jsonrpc: '2.0', id: sent.id, result: { session_id: 'abc123' } })
    await expect(response).resolves.toEqual({ session_id: 'abc123' })
  })

  it('appends session token to attach mode url when provided', async () => {
    const harness = createHarness({
      mode: 'attach',
      gatewayUrl: 'ws://127.0.0.1:9119/api/ws',
      sessionToken: 'attach-secret-token',
    })
    const started = harness.client.start()
    const socket = harness.sockets[0]!
    expect(socket.url).toBe('ws://127.0.0.1:9119/api/ws?token=attach-secret-token')
    socket.serverOpen()
    socket.serverSend(READY_FRAME)
    await started
  })

  it('does not append a token when the attach URL already carries one', async () => {
    const harness = createHarness({
      mode: 'attach',
      gatewayUrl: 'ws://127.0.0.1:9119/api/ws?token=url-token',
      sessionToken: 'other-token',
    })
    const started = harness.client.start()
    const socket = harness.sockets[0]!
    expect(socket.url).toBe('ws://127.0.0.1:9119/api/ws?token=url-token')
    socket.serverOpen()
    socket.serverSend(READY_FRAME)
    await started
  })

  it('ignores whitespace-only token env vars instead of sending an empty token', async () => {
    const harness = createHarness({
      mode: 'attach',
      gatewayUrl: 'ws://127.0.0.1:9119/api/ws',
      env: { [ENV_SESSION_TOKEN]: '   ' },
    })
    const started = harness.client.start()
    const socket = harness.sockets[0]!
    expect(socket.url).toBe('ws://127.0.0.1:9119/api/ws')
    socket.serverOpen()
    socket.serverSend(READY_FRAME)
    await started
  })

  it('rejects attach URLs that are not ws:// or wss://', async () => {
    const harness = createHarness({ mode: 'attach', gatewayUrl: 'http://127.0.0.1:9119/api/ws' })
    await expect(harness.client.start()).rejects.toThrow(/must be ws:\/\/ or wss:\/\/, got http:/)
  })

  it('redacts the session token from connect-failure errors and logs', async () => {
    const harness = createHarness({
      mode: 'attach',
      gatewayUrl: 'ws://127.0.0.1:9119/api/ws',
      sessionToken: 'attach-secret-token',
    })
    const started = harness.client.start()
    harness.sockets[0]!.serverError()

    const error = await started.then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(error?.message).toContain('token=<redacted>')
    expect(error?.message).not.toContain('attach-secret-token')
    expect(harness.logs.join('\n')).not.toContain('attach-secret-token')
  })

  it('redacts the session token from post-ready websocket error logs', async () => {
    const harness = createHarness({
      mode: 'attach',
      gatewayUrl: 'ws://127.0.0.1:9119/api/ws',
      sessionToken: 'attach-secret-token',
    })
    const started = harness.client.start()
    const socket = harness.sockets[0]!
    socket.serverOpen()
    socket.serverSend(READY_FRAME)
    await started

    socket.serverError()
    expect(harness.logs.some((line) => line.includes('token=<redacted>'))).toBe(true)
    expect(harness.logs.join('\n')).not.toContain('attach-secret-token')
  })

  it('points at the session token env var when the gateway rejects with 4401', async () => {
    const harness = createHarness()
    const started = harness.client.start()
    harness.sockets[0]!.serverClose(4401)
    await expect(started).rejects.toThrow(
      /closed during connect \(code 4401\); the gateway rejected the session token — set HERMES_ACP_SESSION_TOKEN/,
    )
  })

  it('rejects requests with the gateway error code and message', async () => {
    const { client, socket } = await startReadyClient()

    const response = client.request('session.resume', { session_id: 'nope' })
    const sent = JSON.parse(socket.sent[0]!) as { id: number }
    socket.serverSend({ jsonrpc: '2.0', id: sent.id, error: { code: 4006, message: 'session_id required' } })

    const error = await response.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toMatchObject({ name: 'GatewayRpcError', code: 4006, message: 'session_id required' })
  })

  it('dispatches known events to subscribers and drops unknown types', async () => {
    const { client, socket, logs } = await startReadyClient()

    const events: GatewayEvent[] = []
    client.onEvent((event) => events.push(event))

    socket.serverSend({
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'message.delta', session_id: 's1', payload: { text: 'hello' } },
    })
    socket.serverSend({
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'pet.generate.progress', session_id: 's1' },
    })
    // Object.prototype keys must not pass the known-type guard.
    socket.serverSend({
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'toString', session_id: 's1' },
    })

    expect(events).toEqual([{ type: 'message.delta', session_id: 's1', payload: { text: 'hello' } }])
    expect(logs.filter((line) => line.includes('unknown gateway event type'))).toEqual([
      'ignoring unknown gateway event type: pet.generate.progress',
      'ignoring unknown gateway event type: toString',
    ])
  })

  it('dispatches known server requests, answers them on their id, and refuses unknown methods', async () => {
    const { client, socket, logs } = await startReadyClient()

    const requests: GatewayServerRequest[] = []
    client.onServerRequest((request) => requests.push(request))

    // A string id plus a method is the gateway asking, not notifying.
    socket.serverSend({
      jsonrpc: '2.0',
      id: 'srq-1',
      method: 'approval',
      params: { session_id: 's1', request_id: 'r1', command: 'rm -rf build', description: 'delete' },
    })
    socket.serverSend({ jsonrpc: '2.0', id: 'srq-2', method: 'sudo', params: { session_id: 's1' } })
    socket.serverSend({ jsonrpc: '2.0', id: 'srq-3', method: 'clarify', params: 'not-an-object' })

    expect(requests).toEqual([
      {
        id: 'srq-1',
        method: 'approval',
        params: { session_id: 's1', request_id: 'r1', command: 'rm -rf build', description: 'delete' },
      },
    ])
    // The unsupported prompt is refused on the wire so the blocked tool fails
    // now instead of after its timeout; nothing reaches the subscribers.
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      jsonrpc: '2.0',
      id: 'srq-2',
      error: { code: -32601, message: 'hermes-agent-acp has no handler for server request method sudo' },
    })
    expect(JSON.parse(socket.sent[1]!)).toEqual({
      jsonrpc: '2.0',
      id: 'srq-3',
      error: { code: -32602, message: 'server request clarify carried no params object' },
    })
    expect(logs.filter((line) => line.includes('server request'))).toEqual([
      'refusing gateway server request srq-2 with unsupported method: sudo',
      'refusing gateway server request srq-3 (clarify) without a params object',
    ])

    client.respond('srq-1', { choice: 'deny' })
    expect(JSON.parse(socket.sent[2]!)).toEqual({ jsonrpc: '2.0', id: 'srq-1', result: { choice: 'deny' } })
  })

  it('isolates throwing onEvent subscribers and does not interrupt dispatch', async () => {
    const { client, socket } = await startReadyClient()

    const events: GatewayEvent[] = []
    client.onEvent(() => {
      throw new Error('faulty subscriber')
    })
    client.onEvent((event) => {
      events.push(event)
    })

    socket.serverSend({
      jsonrpc: '2.0',
      method: 'event',
      params: { type: 'message.delta', payload: { text: 'resilient' } },
    })

    expect(events).toEqual([{ type: 'message.delta', payload: { text: 'resilient' } }])
  })

  it('handles multiple batched ndjson lines in a single websocket message', async () => {
    const { client, socket } = await startReadyClient()

    const events: GatewayEvent[] = []
    client.onEvent((event) => events.push(event))

    const p1 = client.request('session.list', {})
    const p2 = client.request('session.history', { session_id: 's1' })

    const sent1 = JSON.parse(socket.sent[0]!) as { id: number }
    const sent2 = JSON.parse(socket.sent[1]!) as { id: number }

    const batchedFrame = [
      JSON.stringify({ jsonrpc: '2.0', id: sent1.id, result: { sessions: ['s1'] } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', payload: { text: 'batched' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: sent2.id, result: { messages: [] } }),
    ].join('\n')

    socket.serverSendRaw(batchedFrame)

    await expect(p1).resolves.toEqual({ sessions: ['s1'] })
    await expect(p2).resolves.toEqual({ messages: [] })
    expect(events).toEqual([{ type: 'message.delta', payload: { text: 'batched' } }])
  })

  it('rejects the request promise on timeout', async () => {
    const harness = createHarness({ rpcTimeoutMs: 20 })
    const started = harness.client.start()
    harness.sockets[0]!.serverOpen()
    harness.sockets[0]!.serverSend(READY_FRAME)
    await started

    await expect(harness.client.request('model.options', {})).rejects.toThrow(
      'gateway request timed out after 20ms: model.options',
    )
  })

  it('honors a per-request timeout below the client-wide budget', async () => {
    // The client-wide budget is sized for the slowest gateway method; a read a
    // user is waiting on (the auth catalog behind the ACP handshake) bounds
    // itself far lower and degrades rather than holding the handshake open.
    const harness = createHarness({ rpcTimeoutMs: 60_000 })
    const started = harness.client.start()
    harness.sockets[0]!.serverOpen()
    harness.sockets[0]!.serverSend(READY_FRAME)
    await started

    await expect(harness.client.request('model.options', {}, 20)).rejects.toThrow(
      'gateway request timed out after 20ms: model.options',
    )
  })

  it('rejects pending requests and emits onExit when the socket drops post-ready', async () => {
    const { client, socket } = await startReadyClient()

    const exits: (number | null)[] = []
    client.onExit((code) => exits.push(code))

    const pending = client.request('session.list', {})
    socket.serverClose(1011)

    await expect(pending).rejects.toThrow('gateway websocket closed (code 1011)')
    expect(exits).toEqual([null])
  })

  it('isolates throwing onExit subscribers', async () => {
    const { client, socket } = await startReadyClient()

    const exits: (number | null)[] = []
    client.onExit(() => {
      throw new Error('faulty exit subscriber')
    })
    client.onExit((code) => {
      exits.push(code)
    })

    socket.serverClose(1006)
    expect(exits).toEqual([null])
  })

  it('rejects start when the socket closes during connect', async () => {
    const harness = createHarness()
    const started = harness.client.start()
    harness.sockets[0]!.serverClose(1006)
    await expect(started).rejects.toThrow('gateway websocket closed during connect (code 1006)')
  })

  it('rejects start when the socket closes after open but before gateway.ready', async () => {
    const harness = createHarness()
    const started = harness.client.start()
    harness.sockets[0]!.serverOpen()
    harness.sockets[0]!.serverClose(1006)
    await expect(started).rejects.toThrow('gateway websocket closed (code 1006)')
  })

  it('rejects start when gateway.ready never arrives', async () => {
    const harness = createHarness({ startupTimeoutMs: 20 })
    const started = harness.client.start()
    harness.sockets[0]!.serverOpen()
    await expect(started).rejects.toThrow('timed out after 20ms starting Hermes gateway (attach mode)')
  })

  it('rejects start and closes socket when websocket open never fires', async () => {
    const harness = createHarness({ startupTimeoutMs: 20 })
    const started = harness.client.start()
    await expect(started).rejects.toThrow('timed out after 20ms starting Hermes gateway (attach mode)')
    expect(harness.sockets[0]!.wasClosedByClient).toBe(true)
  })

  it('kill() rejects pending requests and closes the socket without emitting onExit', async () => {
    const { client, socket } = await startReadyClient()

    const exits: (number | null)[] = []
    client.onExit((code) => exits.push(code))

    const pending = client.request('session.list', {})
    await client.kill('test teardown')
    socket.serverClose(1000)

    await expect(pending).rejects.toThrow('gateway closed: test teardown')
    expect(socket.wasClosedByClient).toBe(true)
    expect(exits).toEqual([])
  })

  it('rejects a second start()', async () => {
    const harness = createHarness()
    const started = harness.client.start()
    harness.sockets[0]!.serverOpen()
    harness.sockets[0]!.serverSend(READY_FRAME)
    await started
    await expect(harness.client.start()).rejects.toThrow('gateway already started')
  })
})
