/**
 * Turn-lifecycle tests: scripted gateway events in, recorded ACP transcript
 * out. No network, no real Hermes.
 */

import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { GatewayRpcError } from '../gateway/GatewayClient.js'
import type { GatewayEvent, SessionInfo } from '../gateway/types.js'
import type { AcpTestFixture, GatewayRequestMethod, ScriptedGateway } from './acpTestFixture.js'
import {
  createAcpTestFixture,
  scriptSessionSettings,
  TEST_GATEWAY_BUILD_IDENTITY,
  UPDATE_DELIVERY_FAILURE,
} from './acpTestFixture.js'

const TEST_CWD = '/tmp/hermes-acp-session-prompt'
// Live gateway ids: emitted events and session-scoped gateway calls carry
// these. The ACP sessionId is the stored key below, deliberately distinct so
// every assertion proves which namespace it is reading.
const SESSION_ID = 'gw-session-1'
const OTHER_SESSION_ID = 'gw-session-2'
const STORED_SESSION_ID = 'stored-session-1'
const PROMPT_TEXT = 'summarize the repo'

const CALL_POLL_INTERVAL_MS = 1
const CALL_POLL_ATTEMPTS = 500

/**
 * Events are only routed once a turn is installed, so a test that emits before
 * `prompt.submit` lands would silently drop them. Wait for the call instead.
 */
async function waitForGatewayCall(gateway: ScriptedGateway, method: GatewayRequestMethod): Promise<void> {
  for (let attempt = 0; attempt < CALL_POLL_ATTEMPTS; attempt += 1) {
    if (gateway.recordedCalls().some((call) => call.method === method)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, CALL_POLL_INTERVAL_MS))
  }
  throw new Error(`scripted gateway: ${method}() was never called`)
}

async function openSession(fixture: AcpTestFixture, sessionId = SESSION_ID, storedSessionId = STORED_SESSION_ID): Promise<void> {
  fixture.gateway.setResult('sessionCreate', { session_id: sessionId, stored_session_id: storedSessionId })
  scriptSessionSettings(fixture.gateway)
  await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
  fixture.gateway.clearRecordedCalls()
  fixture.clearTranscript()
}

/**
 * Start a prompt and wait until the gateway has accepted the submit. The
 * pending response is wrapped: an async function that returned it directly
 * would adopt it and only settle once the turn was over.
 */
async function startPrompt(
  fixture: AcpTestFixture,
  sessionId = STORED_SESSION_ID,
): Promise<{ readonly response: Promise<acp.PromptResponse> }> {
  fixture.gateway.setResult('promptSubmit', { status: 'streaming' })
  const response = fixture.client.request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: 'text', text: PROMPT_TEXT }],
  })
  await waitForGatewayCall(fixture.gateway, 'promptSubmit')
  return { response }
}

/**
 * A full `_session_info` record, matching the settings `openSession` scripted so
 * the frame carries no delta of its own. `running` is the field under test: it
 * is what separates a mid-turn frame from the settled end-of-turn bookend.
 */
function sessionInfo(running: boolean): SessionInfo {
  return {
    model: 'hermes-4-70b',
    provider: 'nous',
    reasoning_effort: 'medium',
    service_tier: 'default',
    fast: false,
    yolo: false,
    approval_mode: 'manual',
    tools: {},
    cwd: TEST_CWD,
    running,
    title: '',
    stored_session_id: STORED_SESSION_ID,
    turn_started_at: null,
    ...TEST_GATEWAY_BUILD_IDENTITY,
  }
}

function emitAll(gateway: ScriptedGateway, events: readonly GatewayEvent[]): void {
  for (const event of events) {
    gateway.emit(event)
  }
}

/**
 * Wait for the session's update channel to flush. Outside a turn there is no
 * prompt response to await, so the transcript needs an explicit drain before
 * it can be asserted on.
 */
async function drainUpdates(fixture: AcpTestFixture, sessionId = STORED_SESSION_ID): Promise<void> {
  await fixture.server.session(sessionId)?.updates.drained()
  // One more tick for the in-process client to run its notification handler.
  await new Promise((resolve) => setTimeout(resolve, CALL_POLL_INTERVAL_MS))
}

describe('session/prompt', () => {
  it('streams a full turn and ends it with end_turn', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)

      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'promptSubmit', args: [{ session_id: SESSION_ID, text: PROMPT_TEXT }] },
      ])

      emitAll(fixture.gateway, [
        { type: 'message.start', session_id: SESSION_ID },
        { type: 'thinking.delta', session_id: SESSION_ID, payload: { text: 'planning' } },
        { type: 'reasoning.delta', session_id: SESSION_ID, payload: { text: ' further' } },
        {
          type: 'tool.start',
          session_id: SESSION_ID,
          payload: { tool_id: 'call-1', name: 'read_file', context: 'read_file src/index.ts' },
        },
        {
          type: 'tool.complete',
          session_id: SESSION_ID,
          payload: { tool_id: 'call-1', name: 'read_file', result: { ok: true }, summary: '42 lines' },
        },
        { type: 'message.delta', session_id: SESSION_ID, payload: { text: 'The repo ' } },
        { type: 'message.delta', session_id: SESSION_ID, payload: { text: 'is an adapter.', rendered: 'ignored' } },
        {
          type: 'session.usage',
          session_id: SESSION_ID,
          payload: {
            usage: {
              model: 'hermes',
              input: 10,
              output: 5,
              reasoning: 2,
              prompt: 10,
              completion: 5,
              total: 15,
              calls: 1,
              context_used: 1500,
              context_max: 128000,
            },
          },
        },
        { type: 'session.title', session_id: SESSION_ID, payload: { title: 'Repo summary' } },
        {
          type: 'message.complete',
          session_id: SESSION_ID,
          payload: {
            text: 'The repo is an adapter.',
            status: 'complete',
            usage: { model: 'hermes', input: 30, output: 12, reasoning: 4, prompt: 30, completion: 12, total: 42, calls: 2 },
          },
        },
      ])

      // A fresh session has no totals before its first turn, so the turn's
      // share is the final snapshot as-is; the mid-turn tick moves no baseline.
      expect(await response).toEqual({
        stopReason: 'end_turn',
        usage: { totalTokens: 42, inputTokens: 30, outputTokens: 12, thoughtTokens: 4 },
      })

      expect(fixture.transcript().map((entry) => entry.params)).toEqual([
        { sessionId: STORED_SESSION_ID, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'planning' } } },
        { sessionId: STORED_SESSION_ID, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ' further' } } },
        {
          sessionId: STORED_SESSION_ID,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'read_file src/index.ts',
            name: 'read_file',
            kind: 'read',
            status: 'in_progress',
          },
        },
        {
          sessionId: STORED_SESSION_ID,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: '42 lines' } }],
            rawOutput: { ok: true },
          },
        },
        { sessionId: STORED_SESSION_ID, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The repo ' } } },
        { sessionId: STORED_SESSION_ID, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'is an adapter.' } } },
        { sessionId: STORED_SESSION_ID, update: { sessionUpdate: 'usage_update', used: 1500, size: 128000 } },
        { sessionId: STORED_SESSION_ID, update: { sessionUpdate: 'session_info_update', title: 'Repo summary' } },
      ])

      // The turn slot is released, so the session accepts another prompt.
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it("reports each turn's own token usage and its final context gauge", async () => {
    const fixture = createAcpTestFixture()
    try {
      // Hermes reports running totals. The open snapshot already carries some,
      // as a resume that reattaches a live agent does.
      fixture.gateway.setResult('sessionCreate', {
        session_id: SESSION_ID,
        stored_session_id: STORED_SESSION_ID,
        info: { usage: { model: 'hermes', input: 20, output: 5, reasoning: 0, prompt: 20, completion: 5, total: 25, calls: 1 } },
      })
      scriptSessionSettings(fixture.gateway)
      await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
      fixture.gateway.clearRecordedCalls()

      // `input` still falls back to `prompt` here (no uncached input yet) and
      // drops next turn; the share reads `prompt`, which never drops.
      const first = await startPrompt(fixture)
      fixture.gateway.emit({
        type: 'message.complete',
        session_id: SESSION_ID,
        payload: {
          status: 'complete',
          usage: { model: 'hermes', input: 150, output: 50, reasoning: 8, prompt: 150, completion: 50, total: 200, calls: 3 },
        },
      })
      expect(await first.response).toEqual({
        stopReason: 'end_turn',
        usage: { totalTokens: 175, inputTokens: 130, outputTokens: 45, thoughtTokens: 8 },
      })

      // A tick from a turn Hermes ran on its own moves the next baseline.
      fixture.gateway.emit({
        type: 'session.usage',
        session_id: SESSION_ID,
        payload: { usage: { model: 'hermes', input: 40, output: 55, reasoning: 8, prompt: 170, completion: 55, total: 225, calls: 4 } },
      })

      // No `session.usage` tick came, as for any turn making one model call:
      // the final frame alone moves the gauge, ahead of the response.
      fixture.gateway.clearRecordedCalls()
      fixture.clearTranscript()
      const second = await startPrompt(fixture)
      emitAll(fixture.gateway, [
        { type: 'message.delta', session_id: SESSION_ID, payload: { text: 'done' } },
        {
          type: 'message.complete',
          session_id: SESSION_ID,
          payload: {
            text: 'done',
            status: 'complete',
            usage: {
              model: 'hermes',
              input: 40,
              output: 70,
              reasoning: 8,
              prompt: 330,
              completion: 70,
              total: 400,
              calls: 5,
              context_used: 12013,
              context_max: 1310720,
            },
          },
        },
      ])
      expect(await second.response).toEqual({
        stopReason: 'end_turn',
        usage: { totalTokens: 175, inputTokens: 160, outputTokens: 15 },
      })
      expect(fixture.transcript().map((entry) => entry.params)).toEqual([
        { sessionId: STORED_SESSION_ID, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } },
        { sessionId: STORED_SESSION_ID, update: { sessionUpdate: 'usage_update', used: 12013, size: 1310720 } },
      ])

      // A rebuild between turns (`tools.configure`) restarts the totals, and
      // its `session.info` is the only report of that.
      fixture.gateway.emit({
        type: 'session.info',
        session_id: SESSION_ID,
        payload: {
          ...sessionInfo(false),
          usage: { model: 'hermes', input: 0, output: 0, reasoning: 0, prompt: 0, completion: 0, total: 0, calls: 0 },
        },
      })
      fixture.gateway.clearRecordedCalls()
      const third = await startPrompt(fixture)
      fixture.gateway.emit({
        type: 'message.complete',
        session_id: SESSION_ID,
        payload: {
          status: 'complete',
          usage: { model: 'hermes', input: 480, output: 100, reasoning: 0, prompt: 500, completion: 100, total: 600, calls: 5 },
        },
      })
      expect(await third.response).toEqual({
        stopReason: 'end_turn',
        usage: { totalTokens: 600, inputTokens: 500, outputTokens: 100 },
      })

      // A rebuild at turn start ("Bot Chat" capability sync) sends no totals
      // first; lower totals at the end mean the end snapshot is all this turn's.
      fixture.gateway.clearRecordedCalls()
      const fourth = await startPrompt(fixture)
      fixture.gateway.emit({
        type: 'message.complete',
        session_id: SESSION_ID,
        payload: {
          status: 'complete',
          usage: { model: 'hermes', input: 30, output: 5, reasoning: 0, prompt: 30, completion: 5, total: 35, calls: 1 },
        },
      })
      expect(await fourth.response).toEqual({
        stopReason: 'end_turn',
        usage: { totalTokens: 35, inputTokens: 30, outputTokens: 5 },
      })
    } finally {
      fixture.close()
    }
  })

  it('fails the request when the turn ends in error instead of reporting end_turn', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)

      fixture.gateway.emit({
        type: 'message.complete',
        session_id: SESSION_ID,
        // `{}` is the usage a session with no agent reports on this frame.
        payload: { text: 'Error: provider rejected the request', status: 'error', error: 'provider 402: payment required', usage: {} },
      })

      await expect(pending).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('Hermes turn failed: provider 402: payment required'),
      })
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
      expect(fixture.server.session(STORED_SESSION_ID)?.usageTotals).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('fails the request when an update could not be delivered, however cleanly the turn ended', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', { session_id: SESSION_ID, stored_session_id: STORED_SESSION_ID })
      scriptSessionSettings(fixture.gateway)
      const session = await fixture.newSessionWithFailableUpdates({ cwd: TEST_CWD, mcpServers: [] })
      const { response: pending } = await startPrompt(fixture, session.sessionId)

      session.failUpdates()
      emitAll(fixture.gateway, [
        { type: 'message.delta', session_id: SESSION_ID, payload: { text: 'the answer is 42' } },
        { type: 'message.complete', session_id: SESSION_ID, payload: { status: 'complete' } },
      ])

      // The gateway said the turn completed, but the client never received the
      // transcript it would take at face value, so `end_turn` would be a lie.
      await expect(pending).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining(`ACP session/update delivery failed: ${UPDATE_DELIVERY_FAILURE}`),
      })
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('fails the request when a terminal frame carries no status', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)

      fixture.gateway.emit({ type: 'message.complete', session_id: SESSION_ID, payload: { text: 'done' } })

      await expect(pending).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('message.complete arrived without a status'),
      })
    } finally {
      fixture.close()
    }
  })

  it('surfaces a prompt.submit failure and leaves the session promptable', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setFailure('promptSubmit', new GatewayRpcError('session is already running', 4001))

      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [{ type: 'text', text: PROMPT_TEXT }],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('gateway method prompt.submit failed: session is already running'),
      })

      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('names the failed gateway call for a transport-level submit failure too', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      // A timeout or a dropped transport arrives as a plain Error, not a
      // GatewayRpcError; unframed the SDK would report only "Internal error".
      fixture.gateway.setFailure('promptSubmit', new Error('gateway request prompt.submit timed out after 120000ms'))

      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [{ type: 'text', text: PROMPT_TEXT }],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('gateway method prompt.submit failed: gateway request prompt.submit timed out'),
      })

      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('announces a whole tool call from a completion the client never saw start', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)

      emitAll(fixture.gateway, [
        // Tool progress off: an edit's tool.start is gated away upstream but
        // its completion (with the rendered diff) is always emitted.
        {
          type: 'tool.complete',
          session_id: SESSION_ID,
          payload: { tool_id: 'edit-1', name: 'patch', args: { path: '/repo/a.ts' }, summary: 'patched', inline_diff: '- a\n+ b' },
        },
        { type: 'tool.start', session_id: SESSION_ID, payload: { tool_id: 'call-1', name: 'terminal', context: '$ ls' } },
        {
          type: 'tool.complete',
          session_id: SESSION_ID,
          payload: { tool_id: 'call-1', name: 'terminal', summary: 'ok', result: { output: 'a.ts\n', exit_code: 0 } },
        },
        { type: 'message.complete', session_id: SESSION_ID, payload: { status: 'complete' } },
      ])

      expect(await pending).toEqual({ stopReason: 'end_turn' })
      expect(
        fixture.transcript().map((entry) => {
          const params = entry.params as acp.SessionNotification
          return params.update
        }),
      ).toEqual([
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'edit-1',
          title: 'patch',
          name: 'patch',
          kind: 'edit',
          rawInput: { path: '/repo/a.ts' },
          locations: [{ path: '/repo/a.ts' }],
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'patched' } },
            { type: 'content', content: { type: 'text', text: '- a\n+ b' } },
          ],
        },
        // A terminal call renders as a terminal entry: the content item plus the
        // `_meta` side channel, and no text content of its own.
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: '$ ls',
          name: 'terminal',
          kind: 'execute',
          status: 'in_progress',
          content: [{ type: 'terminal', terminalId: 'call-1' }],
          _meta: { terminal_info: { terminal_id: 'call-1', cwd: TEST_CWD } },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed',
          rawOutput: { output: 'a.ts\n', exit_code: 0 },
          _meta: {
            terminal_output: { terminal_id: 'call-1', data: 'a.ts\n' },
            terminal_exit: { terminal_id: 'call-1', exit_code: 0, signal: null },
          },
        },
      ])
    } finally {
      fixture.close()
    }
  })

  it('relays interim assistant text only when it was not already streamed', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)

      emitAll(fixture.gateway, [
        { type: 'message.start', session_id: SESSION_ID },
        { type: 'message.interim', session_id: SESSION_ID, payload: { text: 'Checking the tests first.', already_streamed: false } },
        { type: 'message.delta', session_id: SESSION_ID, payload: { text: 'Done.' } },
        { type: 'message.interim', session_id: SESSION_ID, payload: { text: 'Done.', already_streamed: true } },
        { type: 'message.complete', session_id: SESSION_ID, payload: { status: 'complete' } },
      ])

      expect(await pending).toEqual({ stopReason: 'end_turn' })
      expect(fixture.transcript().map((entry) => (entry.params as acp.SessionNotification).update)).toEqual([
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking the tests first.' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
      ])
    } finally {
      fixture.close()
    }
  })

  it('fails the request on an error event that ends a turn before it started', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)

      // The pending-agent path: no message.start, no message.complete — the
      // error event is the whole ending.
      fixture.gateway.emit({
        type: 'error',
        session_id: SESSION_ID,
        payload: { message: 'Session no longer running before the agent was ready' },
      })

      await expect(pending).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('Session no longer running before the agent was ready'),
      })
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('keeps an error event mid-turn diagnostic', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)

      emitAll(fixture.gateway, [
        { type: 'message.start', session_id: SESSION_ID },
        { type: 'error', session_id: SESSION_ID, payload: { message: 'tool timing skew' } },
        // The frame a mid-turn model switch emits (server.py ~6171): still
        // running, so it must not turn the diagnostic above into an ending.
        { type: 'session.info', session_id: SESSION_ID, payload: sessionInfo(true) },
        { type: 'message.delta', session_id: SESSION_ID, payload: { text: 'still here' } },
        { type: 'message.complete', session_id: SESSION_ID, payload: { status: 'complete' } },
      ])

      expect(await pending).toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('fails the request on an error event the settled session.info proves was terminal', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)

      // The `@`-context refusal: the turn body emits the error and returns
      // after message.start, so no message.complete ever arrives and the
      // settled session.info from its `finally` is the whole ending.
      emitAll(fixture.gateway, [
        { type: 'message.start', session_id: SESSION_ID },
        { type: 'error', session_id: SESSION_ID, payload: { message: 'Context injection refused.' } },
        { type: 'session.info', session_id: SESSION_ID, payload: sessionInfo(false) },
      ])

      await expect(pending).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('Context injection refused.'),
      })
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('fails the request when prompt.submit consumed the text as a voice stop phrase', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('promptSubmit', { voice_stopped: true })

      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [{ type: 'text', text: 'stop' }],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('voice stop phrase'),
      })
      // No turn ran, so nothing is left wedged in the slot.
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('rejects a second prompt while a turn is in flight without touching the gateway', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)
      fixture.gateway.clearRecordedCalls()

      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [{ type: 'text', text: 'and again' }],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining('already has a turn in flight'),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])

      fixture.gateway.emit({ type: 'message.complete', session_id: SESSION_ID, payload: { status: 'complete' } })
      expect(await pending).toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('rejects an unsupported content block by name before submitting', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [{ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('content block type "audio" is not supported'),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('rejects a prompt for an unknown session', async () => {
    const fixture = createAcpTestFixture()
    try {
      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: 'never-created',
          prompt: [{ type: 'text', text: PROMPT_TEXT }],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('unknown session never-created'),
      })
    } finally {
      fixture.close()
    }
  })

  it('keeps another session\'s events out of the running turn', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)

      emitAll(fixture.gateway, [
        { type: 'message.delta', session_id: OTHER_SESSION_ID, payload: { text: 'not mine' } },
        { type: 'message.delta', payload: { text: 'session-less' } },
        { type: 'message.delta', session_id: SESSION_ID, payload: { text: 'mine' } },
        { type: 'message.complete', session_id: OTHER_SESSION_ID, payload: { status: 'error', error: 'other session blew up' } },
        { type: 'message.complete', session_id: SESSION_ID, payload: { status: 'complete' } },
      ])

      expect(await pending).toEqual({ stopReason: 'end_turn' })
      expect(fixture.transcript().map((entry) => entry.params)).toEqual([
        { sessionId: STORED_SESSION_ID, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'mine' } } },
      ])
    } finally {
      fixture.close()
    }
  })

  it('maps todo lists to plan updates, drops cancelled entries, and does not resend an unchanged plan', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)

      const todos = [
        { id: '1', content: 'read the code', status: 'completed' as const },
        { id: '2', content: 'write the mapper', status: 'in_progress' as const },
        { id: '3', content: 'ship it', status: 'pending' as const },
        { id: '4', content: 'rewrite in rust', status: 'cancelled' as const },
      ]

      emitAll(fixture.gateway, [
        { type: 'tool.start', session_id: SESSION_ID, payload: { tool_id: 'call-todo', name: 'todo' } },
        { type: 'tool.complete', session_id: SESSION_ID, payload: { tool_id: 'call-todo', name: 'todo', todos } },
        // Same list on a later completion: no second, identical plan update.
        { type: 'tool.start', session_id: SESSION_ID, payload: { tool_id: 'call-todo-2', name: 'todo' } },
        { type: 'tool.complete', session_id: SESSION_ID, payload: { tool_id: 'call-todo-2', name: 'todo', todos } },
        { type: 'message.complete', session_id: SESSION_ID, payload: { status: 'complete' } },
      ])

      expect(await pending).toEqual({ stopReason: 'end_turn' })

      const plans = fixture.transcript().flatMap((entry) => {
        const params = entry.params as acp.SessionNotification
        return params.update.sessionUpdate === 'plan' ? [params.update] : []
      })
      expect(plans).toEqual([
        {
          sessionUpdate: 'plan',
          entries: [
            { content: 'read the code', priority: 'medium', status: 'completed' },
            { content: 'write the mapper', priority: 'medium', status: 'in_progress' },
            { content: 'ship it', priority: 'medium', status: 'pending' },
          ],
        },
      ])
    } finally {
      fixture.close()
    }
  })
})

describe('session/cancel', () => {
  it('treats $/cancel_request on the prompt as a session/cancel', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('promptSubmit', { status: 'streaming' })
      fixture.gateway.setResult('sessionInterrupt', { status: 'interrupting' })
      const controller = new AbortController()
      const pending = fixture.client.request(
        acp.methods.agent.session.prompt,
        { sessionId: STORED_SESSION_ID, prompt: [{ type: 'text', text: PROMPT_TEXT }] },
        { cancellationSignal: controller.signal },
      )
      // The client-side promise settles on the abort; the turn's own outcome
      // is observed through the gateway calls and the released slot below.
      pending.catch(() => undefined)
      await waitForGatewayCall(fixture.gateway, 'promptSubmit')

      controller.abort()
      await waitForGatewayCall(fixture.gateway, 'sessionInterrupt')
      expect(fixture.gateway.recordedCalls()).toContainEqual({ method: 'sessionInterrupt', args: [SESSION_ID] })

      fixture.gateway.emit({ type: 'message.complete', session_id: SESSION_ID, payload: { status: 'interrupted' } })
      await drainUpdates(fixture)
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('interrupts the gateway session and resolves the prompt as cancelled', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)
      fixture.gateway.clearRecordedCalls()
      fixture.gateway.setResult('sessionInterrupt', { status: 'interrupting' })

      await fixture.client.notify(acp.methods.agent.session.cancel, { sessionId: STORED_SESSION_ID })
      await waitForGatewayCall(fixture.gateway, 'sessionInterrupt')
      expect(fixture.gateway.recordedCalls()).toEqual([{ method: 'sessionInterrupt', args: [SESSION_ID] }])

      fixture.gateway.emit({
        type: 'message.complete',
        session_id: SESSION_ID,
        payload: { text: 'partial answer', status: 'interrupted' },
      })

      expect(await pending).toEqual({ stopReason: 'cancelled' })
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('reports cancelled when the cancel lands before the agent was ready', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)
      fixture.gateway.setResult('sessionInterrupt', { status: 'interrupting' })

      await fixture.client.notify(acp.methods.agent.session.cancel, { sessionId: STORED_SESSION_ID })
      await waitForGatewayCall(fixture.gateway, 'sessionInterrupt')
      // Upstream's pending-agent path answers the interrupt with a bare error
      // event and no terminal frame.
      fixture.gateway.emit({
        type: 'error',
        session_id: SESSION_ID,
        payload: { message: 'Turn cancelled before the agent was ready' },
      })

      expect(await pending).toEqual({ stopReason: 'cancelled' })
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('still reports cancelled when the turn completes before the interrupt lands', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)
      fixture.gateway.setResult('sessionInterrupt', { status: 'interrupting' })

      await fixture.client.notify(acp.methods.agent.session.cancel, { sessionId: STORED_SESSION_ID })
      await waitForGatewayCall(fixture.gateway, 'sessionInterrupt')

      // The gateway had already finished the turn when the interrupt arrived.
      fixture.gateway.emit({ type: 'message.complete', session_id: SESSION_ID, payload: { status: 'complete' } })

      expect(await pending).toEqual({ stopReason: 'cancelled' })
    } finally {
      fixture.close()
    }
  })

  it('is a no-op for an idle or unknown session', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await fixture.client.notify(acp.methods.agent.session.cancel, { sessionId: STORED_SESSION_ID })
      await fixture.client.notify(acp.methods.agent.session.cancel, { sessionId: 'never-created' })

      expect(fixture.gateway.recordedCalls()).toEqual([])
      expect(fixture.transcript()).toEqual([])
    } finally {
      fixture.close()
    }
  })
})

/**
 * Hermes emits these against the session, not the turn — a title is generated
 * after the first exchange and usage is refreshed on a timer — so they have to
 * translate whether or not a prompt is running.
 */
describe('session-scoped events', () => {
  const usageEvent: GatewayEvent = {
    type: 'session.usage',
    session_id: SESSION_ID,
    payload: {
      usage: {
        model: 'hermes',
        input: 10,
        output: 5,
        reasoning: 0,
        prompt: 10,
        completion: 5,
        total: 15,
        calls: 1,
        context_used: 2400,
        context_max: 128000,
      },
    },
  }
  const titleEvent: GatewayEvent = {
    type: 'session.title',
    session_id: SESSION_ID,
    payload: { title: 'Idle rename' },
  }

  it('translates title and usage that arrive between turns', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      emitAll(fixture.gateway, [titleEvent, usageEvent])
      await drainUpdates(fixture)

      expect(fixture.transcript().map((entry) => entry.params)).toEqual([
        { sessionId: STORED_SESSION_ID, update: { sessionUpdate: 'session_info_update', title: 'Idle rename' } },
        { sessionId: STORED_SESSION_ID, update: { sessionUpdate: 'usage_update', used: 2400, size: 128000 } },
      ])
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('emits each exactly once when it arrives mid-turn', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)

      emitAll(fixture.gateway, [
        titleEvent,
        usageEvent,
        { type: 'message.complete', session_id: SESSION_ID, payload: { status: 'complete' } },
      ])

      expect(await pending).toEqual({ stopReason: 'end_turn' })
      expect(fixture.transcript().map((entry) => entry.params)).toEqual([
        { sessionId: STORED_SESSION_ID, update: { sessionUpdate: 'session_info_update', title: 'Idle rename' } },
        { sessionId: STORED_SESSION_ID, update: { sessionUpdate: 'usage_update', used: 2400, size: 128000 } },
      ])
    } finally {
      fixture.close()
    }
  })

  it('drops events for a session the adapter never opened', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      fixture.gateway.emit({ type: 'session.title', session_id: OTHER_SESSION_ID, payload: { title: 'not mine' } })
      await drainUpdates(fixture)

      expect(fixture.transcript()).toEqual([])
    } finally {
      fixture.close()
    }
  })
})

describe('gateway exit', () => {
  it('fails the in-flight prompt with the death as its reason, and waits for that response', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)
      expect(fixture.server.session(STORED_SESSION_ID)?.activePrompt).not.toBeNull()

      await fixture.server.gatewayExited('gateway child exited (code 1)')

      // Failed, never a clean end_turn — and the prompt handler has already
      // returned its error by the time the exit path may continue to
      // process.exit, which is what the cleared request slot proves.
      expect(fixture.server.session(STORED_SESSION_ID)?.activePrompt).toBeNull()
      await expect(response).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('gateway transport: gateway child exited (code 1)'),
      })
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })
})

describe('connection close', () => {
  it('settles an in-flight turn as cancelled and interrupts the gateway session', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)
      fixture.gateway.clearRecordedCalls()
      fixture.gateway.setResult('sessionInterrupt', { status: 'interrupting' })

      await fixture.server.connectionClosed()

      expect(await pending).toEqual({ stopReason: 'cancelled' })
      expect(fixture.gateway.recordedCalls()).toEqual([{ method: 'sessionInterrupt', args: [SESSION_ID] }])
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('stops writing to the dead connection instead of failing on the send', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response: pending } = await startPrompt(fixture)
      fixture.gateway.setResult('sessionInterrupt', { status: 'interrupting' })

      await fixture.server.connectionClosed()
      await pending
      fixture.clearTranscript()

      // Events the gateway had already queued keep arriving after the close.
      emitAll(fixture.gateway, [
        { type: 'message.delta', session_id: SESSION_ID, payload: { text: 'too late' } },
        { type: 'session.title', session_id: SESSION_ID, payload: { title: 'too late' } },
        { type: 'message.complete', session_id: SESSION_ID, payload: { status: 'complete' } },
      ])
      await drainUpdates(fixture)

      expect(fixture.transcript()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('is a no-op when no turn is in flight', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await fixture.server.connectionClosed()

      expect(fixture.gateway.recordedCalls()).toEqual([])
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })
})
