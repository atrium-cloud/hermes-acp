/**
 * `session/resume` and `session/load`: the shared subscribe flow, with load's
 * synchronous transcript replay on top. Scripted gateway, no real Hermes.
 */

import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { MODEL_OPTIONS_TIMEOUT_MS, SESSION_LIST_FETCH_CAP } from '../constants.js'
import { GatewayRpcError } from '../gateway/GatewayClient.js'
import type {
  LazySessionInfo,
  ModelOptionsResult,
  SessionHistoryResult,
  SessionResumeResult,
  TranscriptMessage,
} from '../gateway/types.js'
import type { GatewayRequestMethod, ScriptedGateway } from './acpTestFixture.js'
import {
  UPDATE_DELIVERY_FAILURE,
  createAcpTestFixture,
  scriptSessionSettings,
  TEST_COMMAND_CATALOG,
  TEST_MODEL_CATALOG,
} from './acpTestFixture.js'

const TEST_CWD = '/tmp/hermes-acp-session-resume'
const GATEWAY_SESSION_ID = 'gw-session-1'
// The ACP sessionId: the stored session key, deliberately distinct from the
// live gateway id so a test always proves which namespace a value came from.
const STORED_SESSION_ID = 'stored-1'
// A compressed-away parent and the continuation tip session.resume resolves
// it to (methods_session.py ~369) — a third id namespace, distinct from both
// the requested id and the live id.
const PARENT_SESSION_ID = 'stored-parent-1'
const TIP_SESSION_ID = 'stored-tip-1'

const CALL_POLL_INTERVAL_MS = 1
const CALL_POLL_ATTEMPTS = 500

/**
 * The registration window opens only once the resume has reached the gateway,
 * so a second request issued before the first call lands would test nothing.
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

/**
 * The pinned `_lazy_resume_info` shape (server.py ~8356): cwd, model, empty
 * tools/skills, the lazy flag — and NO title, which is why a fresh load reads
 * the title off session.list instead of the resume response's info.
 */
const lazyResumeInfo: LazySessionInfo = {
  model: 'test-model',
  provider: 'test-provider',
  tools: {},
  cwd: TEST_CWD,
  lazy: true,
}

function resumeResult(overrides: Partial<SessionResumeResult> = {}): SessionResumeResult {
  return {
    session_id: GATEWAY_SESSION_ID,
    resumed: STORED_SESSION_ID,
    messages: [],
    info: lazyResumeInfo,
    ...overrides,
  }
}

/** The session.list row the load-time title read finds the title on. */
function scriptStoredTitle(gateway: ScriptedGateway, storedKey: string, title: string): void {
  gateway.setResult('sessionList', {
    sessions: [{ id: storedKey, title, preview: '', started_at: 0, message_count: 0 }],
  })
}

/** One of every transcript row shape the replay maps, in replay order. */
const HISTORY_ROWS: readonly TranscriptMessage[] = [
  { role: 'user', text: 'hello' },
  { role: 'assistant', reasoning_content: 'thinking it over', text: 'the answer' },
  // Tool rows carry the call, never the result (`_history_to_messages`).
  { role: 'tool', row_id: 42, name: 'terminal', context: 'run ls' },
  { role: 'tool', name: 'read_file', args: { path: '/repo/a.ts', offset: 5 } },
  // A skill-invoked user turn keeps its visible invocation text.
  { role: 'user', text: '/deploy staging', display_kind: 'skill_invocation' },
  // Chrome rows the TUI renders but ACP has no equivalent for: dropped.
  { role: 'system', text: 'model switched' },
  { role: 'user', text: '/status', display_kind: 'command' },
]

/** The updates HISTORY_ROWS replay to, in order (title first on a fresh load). */
const REPLAYED_UPDATES = [
  { sessionUpdate: 'session_info_update', title: 'old chat' },
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking it over' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the answer' } },
  {
    sessionUpdate: 'tool_call',
    toolCallId: '42',
    title: 'run ls',
    name: 'terminal',
    kind: 'execute',
    status: 'completed',
  },
  {
    sessionUpdate: 'tool_call',
    // No row_id on this row: the id is its replay position.
    toolCallId: 'replay-3',
    title: 'read_file',
    name: 'read_file',
    kind: 'read',
    status: 'completed',
    rawInput: { path: '/repo/a.ts', offset: 5 },
    locations: [{ path: '/repo/a.ts', line: 5 }],
  },
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '/deploy staging' } },
]

function recordedUpdates(fixture: ReturnType<typeof createAcpTestFixture>): readonly unknown[] {
  return fixture
    .transcript(['sessionId'])
    .filter((entry) => entry.method === acp.methods.client.session.update)
    .map((entry) => (entry.params as { update: unknown }).update)
}

describe('session/resume', () => {
  it('subscribes without the transcript and registers the session under the stored key', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionResume', resumeResult())
      scriptSessionSettings(fixture.gateway)

      const response = await fixture.client.request(acp.methods.agent.session.resume, {
        sessionId: STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })

      expect(response.modes?.currentModeId).toBe('default')
      expect(response.configOptions?.[0]).toMatchObject({ id: 'model', currentValue: 'nous/hermes-4-70b' })

      // omit_messages: resume only subscribes; the transcript belongs to load.
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'sessionResume', args: [{ session_id: STORED_SESSION_ID, omit_messages: true }] },
        { method: 'modelOptions', args: [{ session_id: GATEWAY_SESSION_ID }, MODEL_OPTIONS_TIMEOUT_MS] },
        { method: 'configGet', args: [{ key: 'approval_mode', session_id: GATEWAY_SESSION_ID }] },
        { method: 'commandsCatalog', args: [] },
      ])
      expect(fixture.server.session(STORED_SESSION_ID)).toMatchObject({
        storedSessionId: STORED_SESSION_ID,
        gatewaySessionId: GATEWAY_SESSION_ID,
        cwd: TEST_CWD,
        activeTurn: null,
        activePrompt: null,
      })
      expect(fixture.sessionDirectory.get(STORED_SESSION_ID)?.cwd).toBe(TEST_CWD)
      // No replay: the only thing the client heard is nothing at all (the
      // unscripted commands catalog leaves no commands to advertise).
      expect(recordedUpdates(fixture)).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('rejects a relative cwd before touching the gateway', async () => {
    const fixture = createAcpTestFixture()
    try {
      await expect(
        fixture.client.request(acp.methods.agent.session.resume, {
          sessionId: STORED_SESSION_ID,
          cwd: 'relative/dir',
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('absolute'),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('frames a gateway failure with the failed method', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setFailure('sessionResume', new GatewayRpcError('unknown session', 4007))

      await expect(
        fixture.client.request(acp.methods.agent.session.resume, {
          sessionId: STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        // 4007 (unknown session) maps to invalidParams: a client-supplied bad id.
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('gateway method session.resume failed: unknown session'),
      })
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('rejects a tracked resume whose cwd does not match the record', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', {
        session_id: GATEWAY_SESSION_ID,
        stored_session_id: STORED_SESSION_ID,
        info: lazyResumeInfo,
      })
      scriptSessionSettings(fixture.gateway)
      await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
      fixture.gateway.clearRecordedCalls()

      // The fresh path fails a cwd mismatch invalid_params; the tracked
      // branch applies the same mis-rooting guard against the record's cwd.
      await expect(
        fixture.client.request(acp.methods.agent.session.resume, {
          sessionId: STORED_SESSION_ID,
          cwd: '/somewhere/else',
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining(TEST_CWD),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])
      expect(fixture.server.session(STORED_SESSION_ID)).toBeDefined()
    } finally {
      fixture.close()
    }
  })

  it('answers an already-tracked session without resuming it on the gateway again', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', {
        session_id: GATEWAY_SESSION_ID,
        stored_session_id: STORED_SESSION_ID,
        info: lazyResumeInfo,
      })
      scriptSessionSettings(fixture.gateway)
      await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
      fixture.gateway.clearRecordedCalls()

      const response = await fixture.client.request(acp.methods.agent.session.resume, {
        sessionId: STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })

      expect(response.modes?.currentModeId).toBe('default')
      // No sessionResume, no settings re-reads: the response is rebuilt from
      // the record.
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })
})

describe('session/load', () => {
  it('replays the transcript synchronously, title first, before responding', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionResume', resumeResult({ messages: HISTORY_ROWS }))
      scriptSessionSettings(fixture.gateway)
      // The lazy resume info carries no title: the promised title update is
      // read off session.list, the only upstream surface that has it.
      scriptStoredTitle(fixture.gateway, STORED_SESSION_ID, 'old chat')

      const response = await fixture.client.request(acp.methods.agent.session.load, {
        sessionId: STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })

      expect(response.modes?.currentModeId).toBe('default')
      // load asked the gateway for the transcript it is about to replay, and
      // the title read follows the registration tail's settings reads.
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'sessionResume', args: [{ session_id: STORED_SESSION_ID, omit_messages: false }] },
        { method: 'modelOptions', args: [{ session_id: GATEWAY_SESSION_ID }, MODEL_OPTIONS_TIMEOUT_MS] },
        { method: 'configGet', args: [{ key: 'approval_mode', session_id: GATEWAY_SESSION_ID }] },
        { method: 'commandsCatalog', args: [] },
        { method: 'sessionList', args: [{ limit: SESSION_LIST_FETCH_CAP }] },
      ])
      // The response already resolved, so every replayed update preceding it
      // proves the replay was synchronous.
      expect(recordedUpdates(fixture)).toEqual(REPLAYED_UPDATES)
      expect(fixture.server.session(STORED_SESSION_ID)).toMatchObject({
        storedSessionId: STORED_SESSION_ID,
        gatewaySessionId: GATEWAY_SESSION_ID,
      })
      expect(fixture.sessionDirectory.get(STORED_SESSION_ID)?.cwd).toBe(TEST_CWD)
    } finally {
      fixture.close()
    }
  })

  it('advertises the command catalog ahead of the replay when the session has slash commands', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionResume', resumeResult({ messages: HISTORY_ROWS }))
      scriptSessionSettings(fixture.gateway)
      fixture.gateway.setResult('commandsCatalog', TEST_COMMAND_CATALOG)
      scriptStoredTitle(fixture.gateway, STORED_SESSION_ID, 'old chat')

      await fixture.client.request(acp.methods.agent.session.load, {
        sessionId: STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })

      // The catalog goes out as registration finishes, so it precedes even
      // the replay's title update — "title first" holds within the replay.
      const updates = recordedUpdates(fixture)
      expect(updates.map((update) => (update as { sessionUpdate: string }).sessionUpdate)).toEqual([
        'available_commands_update',
        ...REPLAYED_UPDATES.map((update) => update.sessionUpdate),
      ])
      expect(updates[0]).toMatchObject({
        sessionUpdate: 'available_commands_update',
        availableCommands: expect.arrayContaining([{ name: 'status', description: 'Show session status' }]),
      })
    } finally {
      fixture.close()
    }
  })

  it('takes the title from the resume info when it carries one, without a session.list read', async () => {
    const fixture = createAcpTestFixture()
    try {
      // The eager-build path's info is not the lazy snapshot and can carry a
      // title; when it does, the session.list fallback never runs.
      fixture.gateway.setResult(
        'sessionResume',
        resumeResult({ messages: HISTORY_ROWS, info: { ...lazyResumeInfo, title: 'old chat' } }),
      )
      scriptSessionSettings(fixture.gateway)

      await fixture.client.request(acp.methods.agent.session.load, {
        sessionId: STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })

      expect(fixture.gateway.recordedCalls().map((call) => call.method)).not.toContain('sessionList')
      expect(recordedUpdates(fixture)[0]).toEqual({ sessionUpdate: 'session_info_update', title: 'old chat' })
    } finally {
      fixture.close()
    }
  })

  it('replays without a title when the session.list title read fails', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionResume', resumeResult({ messages: HISTORY_ROWS }))
      scriptSessionSettings(fixture.gateway)
      fixture.gateway.setFailure('sessionList', new GatewayRpcError('state.db is locked'))

      const response = await fixture.client.request(acp.methods.agent.session.load, {
        sessionId: STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })

      // The title is cosmetic metadata: a failed read is logged and skipped,
      // not worth costing the user the session over.
      expect(response.modes?.currentModeId).toBe('default')
      expect(recordedUpdates(fixture)).toEqual(REPLAYED_UPDATES.slice(1))
    } finally {
      fixture.close()
    }
  })

  it('fails a load whose session is closed while its history is still being read', async () => {
    const fixture = createAcpTestFixture()
    try {
      // Open the session first so the load takes the tracked path.
      fixture.gateway.setResult('sessionCreate', {
        session_id: GATEWAY_SESSION_ID,
        stored_session_id: STORED_SESSION_ID,
        info: lazyResumeInfo,
      })
      scriptSessionSettings(fixture.gateway)
      await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
      fixture.gateway.clearRecordedCalls()
      fixture.clearTranscript()

      // Held open so the close completes while the load is in the history
      // read — past the tracked branch's closing check.
      let releaseHistory!: (result: SessionHistoryResult) => void
      fixture.gateway.setResult(
        'sessionHistory',
        new Promise<SessionHistoryResult>((resolve) => {
          releaseHistory = resolve
        }),
      )
      fixture.gateway.setResult('sessionClose', { closed: true })

      const pending = fixture.client.request(acp.methods.agent.session.load, {
        sessionId: STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })
      await waitForGatewayCall(fixture.gateway, 'sessionHistory')
      await fixture.client.request(acp.methods.agent.session.close, { sessionId: STORED_SESSION_ID })

      releaseHistory({ count: HISTORY_ROWS.length, messages: HISTORY_ROWS })
      // The replay must not send into the channel the teardown closed: a
      // closed channel drops updates without recording a failure, so a
      // success here would report a transcript that never arrived.
      await expect(pending).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining('closed'),
      })
      expect(recordedUpdates(fixture)).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('fails and discards the session when the gateway resumed it at a different cwd', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionResume', resumeResult({ info: { ...lazyResumeInfo, cwd: '/somewhere/else' } }))
      fixture.gateway.setResult('sessionClose', { closed: true })

      await expect(
        fixture.client.request(acp.methods.agent.session.load, {
          sessionId: STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('/somewhere/else'),
      })

      expect(fixture.gateway.recordedCalls().map((call) => call.method)).toEqual(['sessionResume', 'sessionClose'])
      expect(fixture.gateway.recordedCalls()[1]?.args).toEqual([GATEWAY_SESSION_ID])
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('replays an already-tracked session from session.history, without a fabricated title', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', {
        session_id: GATEWAY_SESSION_ID,
        stored_session_id: STORED_SESSION_ID,
        info: lazyResumeInfo,
      })
      scriptSessionSettings(fixture.gateway)
      fixture.gateway.setResult('commandsCatalog', TEST_COMMAND_CATALOG)
      await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
      fixture.gateway.clearRecordedCalls()
      fixture.clearTranscript()

      fixture.gateway.setResult('sessionHistory', { count: HISTORY_ROWS.length, messages: HISTORY_ROWS })
      const response = await fixture.client.request(acp.methods.agent.session.load, {
        sessionId: STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })

      expect(response.modes?.currentModeId).toBe('default')
      // History is read off the still-live session — which takes the LIVE id —
      // and the gateway is not resumed again.
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'sessionHistory', args: [GATEWAY_SESSION_ID] },
      ])
      // The record tracks no title, so the replay starts straight at the
      // chunks rather than emitting a session_info_update that would
      // overwrite the client's own. The command list follows the replay: the
      // client re-opening the session starts from an empty one.
      const replayed = recordedUpdates(fixture)
      expect(replayed.slice(0, -1)).toEqual(REPLAYED_UPDATES.slice(1))
      expect(replayed.at(-1)).toMatchObject({ sessionUpdate: 'available_commands_update' })
    } finally {
      fixture.close()
    }
  })

  it('rejects a second open of the same id while the first is still in flight', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionResume', resumeResult())
      // Held open so the second load lands while the first is still in its
      // setup reads — the window the pending-open guard exists for.
      let releaseCatalog!: (catalog: ModelOptionsResult) => void
      fixture.gateway.setResult(
        'modelOptions',
        new Promise<ModelOptionsResult>((resolve) => {
          releaseCatalog = resolve
        }),
      )
      fixture.gateway.setResult('configGet', { value: 'manual' })
      // No stored row, so no title: the load's title read comes up empty.
      fixture.gateway.setResult('sessionList', { sessions: [] })

      const first = fixture.client.request(acp.methods.agent.session.load, {
        sessionId: STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })
      await waitForGatewayCall(fixture.gateway, 'modelOptions')

      await expect(
        fixture.client.request(acp.methods.agent.session.load, {
          sessionId: STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining('already has an open in flight'),
      })
      // The loser never reached the gateway.
      expect(fixture.gateway.recordedCalls().filter((call) => call.method === 'sessionResume')).toHaveLength(1)

      releaseCatalog(TEST_MODEL_CATALOG)
      const firstResponse = await first
      expect(firstResponse.modes?.currentModeId).toBe('default')

      // The claim ended with the first open: a third call takes the
      // already-tracked branch and never resumes on the gateway again.
      fixture.gateway.clearRecordedCalls()
      await fixture.client.request(acp.methods.agent.session.resume, {
        sessionId: STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('rejects mcpServers before touching the gateway', async () => {
    const fixture = createAcpTestFixture()
    try {
      await expect(
        fixture.client.request(acp.methods.agent.session.load, {
          sessionId: STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [{ name: 'files', command: '/usr/bin/mcp-files', args: [], env: [] }],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('MCP passthrough'),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('rejects additionalDirectories before touching the gateway', async () => {
    const fixture = createAcpTestFixture()
    try {
      await expect(
        fixture.client.request(acp.methods.agent.session.resume, {
          sessionId: STORED_SESSION_ID,
          cwd: TEST_CWD,
          additionalDirectories: ['/tmp/hermes-acp-extra'],
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('additionalDirectories'),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('fails the request and tears the session down when the replay cannot be delivered', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionResume', resumeResult({ messages: HISTORY_ROWS }))
      scriptSessionSettings(fixture.gateway)
      fixture.gateway.setResult('sessionList', { sessions: [] })
      fixture.gateway.setResult('sessionClose', { closed: true })

      // The same failing-update Proxy the fixture builds for newSession, but
      // for a session that only exists once load creates it — so the proxy is
      // built by hand around the recorded agent context and the request is
      // issued on the server directly, like newSessionWithFailableUpdates does.
      const context = new Proxy(fixture.agent, {
        get(target, property) {
          if (property === 'notify') {
            return (): Promise<void> => Promise.reject(new Error(UPDATE_DELIVERY_FAILURE))
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })

      await expect(
        fixture.server.loadSession({ sessionId: STORED_SESSION_ID, cwd: TEST_CWD, mcpServers: [] }, context),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('history replay'),
      })

      // A client that never learned the session exists must not leave one
      // behind: the registration is gone and the gateway session was closed.
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
      expect(fixture.gateway.recordedCalls().map((call) => call.method)).toContain('sessionClose')
      expect(
        fixture.gateway.recordedCalls().find((call) => call.method === 'sessionClose')?.args,
      ).toEqual([GATEWAY_SESSION_ID])
    } finally {
      fixture.close()
    }
  })
})

/**
 * Resuming a compressed-away parent: upstream follows the continuation chain
 * to the tip (methods_session.py ~369) and answers with the TIP's stored key,
 * while ACP gives the adapter no way to hand the client a replacement id.
 */
describe('compression continuation', () => {
  it('registers a parent resumed to its continuation tip under the requested id', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult(
        'sessionResume',
        resumeResult({ resumed: TIP_SESSION_ID, session_key: TIP_SESSION_ID, messages: HISTORY_ROWS }),
      )
      scriptSessionSettings(fixture.gateway)
      // The title read looks the stored key — the tip — up, not the parent.
      scriptStoredTitle(fixture.gateway, TIP_SESSION_ID, 'old chat')

      await fixture.client.request(acp.methods.agent.session.load, {
        sessionId: PARENT_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })

      expect(fixture.gateway.recordedCalls()[0]).toEqual({
        method: 'sessionResume',
        args: [{ session_id: PARENT_SESSION_ID, omit_messages: false }],
      })
      // The record answers under the id the client asked with; the tip is
      // kept as the stored key for the calls that speak stored keys.
      expect(fixture.server.session(PARENT_SESSION_ID)).toMatchObject({
        storedSessionId: PARENT_SESSION_ID,
        storedKey: TIP_SESSION_ID,
        gatewaySessionId: GATEWAY_SESSION_ID,
      })
      expect(fixture.server.session(TIP_SESSION_ID)).toBeUndefined()
      // Every update is addressed to the requested id — the only one the
      // client knows.
      const addressed = fixture
        .transcript()
        .filter((entry) => entry.method === acp.methods.client.session.update)
        .map((entry) => (entry.params as { sessionId: string }).sessionId)
      expect(addressed.length).toBeGreaterThan(0)
      expect(new Set(addressed)).toEqual(new Set([PARENT_SESSION_ID]))
      // Both keys' cwd resolve for session/list: the client's id and the tip
      // row the gateway actually lists.
      expect(fixture.sessionDirectory.get(PARENT_SESSION_ID)?.cwd).toBe(TEST_CWD)
      expect(fixture.sessionDirectory.get(TIP_SESSION_ID)?.cwd).toBe(TEST_CWD)
      expect(recordedUpdates(fixture)[0]).toEqual({ sessionUpdate: 'session_info_update', title: 'old chat' })
    } finally {
      fixture.close()
    }
  })

  it('refuses a resume that lands on an already-live session instead of overwriting its record', async () => {
    const fixture = createAcpTestFixture()
    try {
      // The tip is already open, created directly under its own key.
      fixture.gateway.setResult('sessionCreate', {
        session_id: GATEWAY_SESSION_ID,
        stored_session_id: TIP_SESSION_ID,
        info: lazyResumeInfo,
      })
      scriptSessionSettings(fixture.gateway)
      await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
      fixture.gateway.clearRecordedCalls()

      // Loading the parent resolves to the tip and reuses its live session;
      // registering that again would overwrite the tip's record and strand
      // its update channel, so the load is refused.
      fixture.gateway.setResult('sessionResume', resumeResult({ resumed: TIP_SESSION_ID, session_key: TIP_SESSION_ID }))
      await expect(
        fixture.client.request(acp.methods.agent.session.load, {
          sessionId: PARENT_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining(TIP_SESSION_ID),
      })

      // The refusal came before any registration, and the live session —
      // owned by the tip's record — was NOT closed out from under it.
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'sessionResume', args: [{ session_id: PARENT_SESSION_ID, omit_messages: false }] },
      ])
      expect(fixture.server.session(TIP_SESSION_ID)).toBeDefined()
      expect(fixture.server.session(PARENT_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('deletes the continuation tip when the client deletes the requested id', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionResume', resumeResult({ resumed: TIP_SESSION_ID, session_key: TIP_SESSION_ID }))
      scriptSessionSettings(fixture.gateway)
      await fixture.client.request(acp.methods.agent.session.resume, {
        sessionId: PARENT_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })
      fixture.gateway.clearRecordedCalls()
      fixture.gateway.setResult('sessionClose', { closed: true })
      fixture.gateway.setResult('sessionDelete', { deleted: TIP_SESSION_ID })

      const response = await fixture.client.request(acp.methods.agent.session.delete, {
        sessionId: PARENT_SESSION_ID,
      })

      expect(response).toEqual({})
      // The live close takes the live id; the deletion takes the TIP's stored
      // key — the conversation the client was actually looking at.
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'sessionClose', args: [GATEWAY_SESSION_ID] },
        { method: 'sessionDelete', args: [TIP_SESSION_ID] },
      ])
      expect(fixture.server.session(PARENT_SESSION_ID)).toBeUndefined()
      expect(fixture.sessionDirectory.get(PARENT_SESSION_ID)).toBeUndefined()
      expect(fixture.sessionDirectory.get(TIP_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })
})
