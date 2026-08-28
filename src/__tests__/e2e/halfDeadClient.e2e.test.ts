/**
 * Characterization, not a fix: what happens when a client stays connected but
 * stops draining the adapter's stdout.
 *
 * The adapter has no write timeout, so once the OS pipe buffer fills the
 * update queue wedges and the pending `session/prompt` stalls with it
 * (docs/todos.md section 5). The roadmap asks for the SHAPE of that hang to be
 * observed against a real client before deciding whether a timeout is the
 * answer, so this test asserts the wedge rather than repairing it.
 *
 * Driven with a hand-rolled ndjson client instead of the SDK: the moment the
 * SDK's reader owns stdout it drains it, which is precisely the behavior under
 * test. The byte assertion at the end is what keeps this honest — a turn that
 * produced less than a pipe buffer would never have wedged, so the test must
 * fail rather than pass vacuously.
 */

import { afterEach, expect, it } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { rmSync } from 'node:fs'

import { PROTOCOL_VERSION } from '../../constants.js'
import { describeE2E, E2E_SETUP_TIMEOUT_MS } from './e2eGate.js'
import { createScratchPaths, spawnAgentProcess, stopChild } from './spawnedAgentFixture.js'

// ── Constants ───────────────────────────────────────────────────────────────

/** Enough output that the turn cannot fit in a pipe buffer: each streamed
 * delta rides its own `session/update` frame, so the wire volume is a large
 * multiple of the text itself. */
const FLOOD_PROMPT = 'Print the numbers from 1 to 4000, one per line, with no other text at all.'

/** Typical pipe capacity on Linux and macOS. It is only half the story: a
 * paused `child.stdout` absorbs the pipe AND Node's own readable buffer
 * (`readableHighWaterMark`, 64KB for a spawned child) before the adapter's
 * writes can block, so the floor below is the sum of the two. Under it,
 * backpressure was never reached and the stall proved nothing. */
const PIPE_BUFFER_BYTES = 64 * 1024

/** How long the client plays dead. Long enough that a healthy turn of this
 * size would have finished several times over. */
const STALL_MS = 20_000

const READ_SETTLE_MS = 50
const MALFORMED_PREVIEW_CHARS = 200

interface JsonRpcMessage {
  readonly id?: number
  readonly method?: string
  readonly result?: unknown
  readonly error?: unknown
  readonly params?: unknown
}

/**
 * The smallest ndjson JSON-RPC client that can drive an ACP agent: line
 * framing, id correlation, and — the point of the exercise — a reader that can
 * be switched off without closing the connection.
 */
class ManualClient {
  private nextId = 1
  private buffer = ''
  private draining = false
  private readonly seen: JsonRpcMessage[] = []
  private readonly settled = new Map<number, JsonRpcMessage>()
  readonly malformed: string[] = []
  bytesRead = 0

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.bytesRead += Buffer.byteLength(chunk, 'utf8')
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line !== '') {
          // Recorded rather than thrown: a throw inside a stream callback
          // takes the worker down instead of failing the test, and a
          // malformed frame is itself a finding worth surfacing.
          try {
            const message = JSON.parse(line) as JsonRpcMessage
            this.seen.push(message)
            if (typeof message.id === 'number') {
              this.settled.set(message.id, message)
            }
          } catch (error) {
            this.malformed.push(`${String(error)}: ${line.slice(0, MALFORMED_PREVIEW_CHARS)}`)
          }
        }
        newline = this.buffer.indexOf('\n')
      }
    })
    this.draining = true
  }

  /** Send a request and return its id; the caller awaits it separately so a
   * request can deliberately outlive a stall. */
  send(method: string, params: unknown): number {
    const id = this.nextId
    this.nextId += 1
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return id
  }

  settledResponse(id: number): JsonRpcMessage | undefined {
    return this.settled.get(id)
  }

  notificationsSeen(method: string): number {
    return this.seen.filter((message) => message.method === method).length
  }

  /** Stop taking delivery WITHOUT closing the connection — a half-dead client,
   * not a disconnected one. */
  playDead(): void {
    this.draining = false
    this.child.stdout.pause()
  }

  revive(): void {
    this.draining = true
    this.child.stdout.resume()
  }

  isDraining(): boolean {
    return this.draining
  }

  async waitForResponse(id: number, timeoutMs: number): Promise<JsonRpcMessage> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const settled = this.settled.get(id)
      if (settled !== undefined) {
        return settled
      }
      await new Promise((resolve) => setTimeout(resolve, READ_SETTLE_MS))
    }
    throw new Error(`manual client: request ${id} did not settle within ${timeoutMs}ms`)
  }

  async waitForNotification(method: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.notificationsSeen(method) > 0) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, READ_SETTLE_MS))
    }
    throw new Error(`manual client: no ${method} within ${timeoutMs}ms`)
  }
}

describeE2E('half-dead client', () => {
  let child: ChildProcessWithoutNullStreams | null = null
  let scratchRoot: string | null = null

  afterEach(async () => {
    if (child !== null) {
      await stopChild(child)
      child = null
    }
    if (scratchRoot !== null) {
      rmSync(scratchRoot, { recursive: true, force: true })
      scratchRoot = null
    }
  })

  it(
    'wedges the pending prompt while the client refuses delivery, and recovers when it resumes',
    async () => {
      const paths = createScratchPaths()
      scratchRoot = paths.root
      child = spawnAgentProcess(paths.hermesHome, paths.workspace)
      // Drained and discarded: this test plays dead on stdout only, and an
      // unread stderr pipe would fill on its own and add a second, unintended
      // block to the one under observation.
      child.stderr.resume()
      const client = new ManualClient(child)

      await client.waitForResponse(
        client.send('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }),
        E2E_SETUP_TIMEOUT_MS,
      )
      const created = await client.waitForResponse(
        client.send('session/new', { cwd: paths.workspace, mcpServers: [] }),
        E2E_SETUP_TIMEOUT_MS,
      )
      const sessionId = (created.result as { sessionId: string }).sessionId

      const promptId = client.send('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: FLOOD_PROMPT }],
      })
      // Only stop draining once the turn is actually streaming; a client that
      // played dead before the first frame would test the handshake instead.
      await client.waitForNotification('session/update', E2E_SETUP_TIMEOUT_MS)
      const bytesBeforeStall = client.bytesRead
      client.playDead()

      await new Promise((resolve) => setTimeout(resolve, STALL_MS))

      // The shape of the hang: the prompt is still pending, nothing timed out,
      // and the adapter is alive and blocked rather than crashed.
      expect(client.settledResponse(promptId)).toBeUndefined()
      expect(child.exitCode).toBeNull()
      expect(client.isDraining()).toBe(false)
      // The one signal observable from inside a dead client: Node's readable
      // buffer is full, which means it stopped pulling and the pipe behind it
      // is filling too.
      expect(child.stdout.readableLength).toBeGreaterThanOrEqual(child.stdout.readableHighWaterMark)

      client.revive()
      const response = await client.waitForResponse(promptId, E2E_SETUP_TIMEOUT_MS)
      expect(response.error).toBeUndefined()

      // Non-vacuity: enough had to be in flight to fill the pipe AND Node's
      // readable buffer, or the adapter never blocked and the stall above was
      // just a paused client with a finished turn waiting in a buffer.
      expect(client.bytesRead - bytesBeforeStall).toBeGreaterThan(
        PIPE_BUFFER_BYTES + child.stdout.readableHighWaterMark,
      )
      // A frame this hand-rolled reader could not parse would quietly skew
      // every assertion above.
      expect(client.malformed).toEqual([])
    },
    E2E_SETUP_TIMEOUT_MS + STALL_MS,
  )
})
