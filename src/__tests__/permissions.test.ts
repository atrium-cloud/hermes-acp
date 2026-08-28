/**
 * Approval and clarify round-trips: scripted gateway events in, recorded ACP
 * transcript and gateway calls out. No network, no real Hermes.
 *
 * The invariants under test are the fail-closed ones — an unanswered prompt
 * denies, a turn that ends first denies exactly once, and a question nobody
 * answered is never answered on the user's behalf.
 */

import * as acp from '@agentclientprotocol/sdk'
import type { CreateElicitationResponse, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import {
  APPROVAL_CHOICE_DENY,
  APPROVAL_CHOICE_ONCE,
  APPROVAL_CHOICE_SESSION,
  APPROVAL_GATE_TOOL_CALL_PREFIX,
  CLARIFY_ANSWER_FIELD,
  CLARIFY_TOOL_NAME,
  PROTOCOL_VERSION,
} from '../constants.js'
import type { GatewayEvent } from '../gateway/types.js'
import { approvalOptions } from '../turn/permissions.js'
import type { AcpTestFixture, GatewayCall, GatewayRequestMethod, ScriptedGateway } from './acpTestFixture.js'
import { createAcpTestFixture, scriptSessionSettings } from './acpTestFixture.js'

const TEST_CWD = '/tmp/hermes-acp-permissions'
// Live gateway id (events, approval.respond calls); the ACP sessionId is the
// stored key below, distinct on purpose.
const SESSION_ID = 'gw-session-1'
const STORED_SESSION_ID = 'stored-session-1'
const PROMPT_TEXT = 'delete the build directory'
const APPROVAL_REQUEST_ID = 'approval-1'
const CLARIFY_REQUEST_ID = 'clarify-1'
const TOOL_CALL_ID = 'call-1'

const POLL_INTERVAL_MS = 1
const POLL_ATTEMPTS = 500

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`timed out waiting for ${description}`)
}

function waitForGatewayCall(gateway: ScriptedGateway, method: GatewayRequestMethod): Promise<void> {
  return waitFor(() => gateway.recordedCalls().some((call) => call.method === method), `gateway ${method}()`)
}

function waitForAcpRequest(fixture: AcpTestFixture, method: string): Promise<void> {
  return waitFor(
    () => fixture.transcript().some((entry) => entry.kind === 'request' && entry.method === method),
    `ACP request ${method}`,
  )
}

function gatewayCalls(gateway: ScriptedGateway, method: GatewayRequestMethod): readonly GatewayCall[] {
  return gateway.recordedCalls().filter((call) => call.method === method)
}

/**
 * Open a session, having advertised (or withheld) form elicitation support at
 * initialize — clarify is capability-gated on it.
 */
async function openSession(fixture: AcpTestFixture, supportsElicitation = true): Promise<void> {
  await fixture.client.request(acp.methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: supportsElicitation ? { elicitation: { form: {} } } : {},
  })
  fixture.gateway.setResult('sessionCreate', { session_id: SESSION_ID, stored_session_id: STORED_SESSION_ID })
  scriptSessionSettings(fixture.gateway)
  await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
  fixture.gateway.setResult('approvalRespond', { resolved: 1 })
  fixture.gateway.setResult('clarifyRespond', { status: 'ok' })
  fixture.gateway.clearRecordedCalls()
  fixture.clearTranscript()
}

/**
 * Start a prompt and wait until the gateway has accepted the submit. The
 * pending response is wrapped: an async function that returned it directly
 * would adopt it and only settle once the turn was over.
 */
async function startPrompt(fixture: AcpTestFixture): Promise<{ readonly response: Promise<acp.PromptResponse> }> {
  fixture.gateway.setResult('promptSubmit', { status: 'streaming' })
  const response = fixture.client.request(acp.methods.agent.session.prompt, {
    sessionId: STORED_SESSION_ID,
    prompt: [{ type: 'text', text: PROMPT_TEXT }],
  })
  await waitForGatewayCall(fixture.gateway, 'promptSubmit')
  fixture.gateway.clearRecordedCalls()
  return { response }
}

const TERMINAL_TOOL_START: GatewayEvent = {
  type: 'tool.start',
  session_id: SESSION_ID,
  payload: { tool_id: TOOL_CALL_ID, name: 'terminal', context: 'rm -rf build' },
}

const APPROVAL_REQUEST: GatewayEvent = {
  type: 'approval.request',
  session_id: SESSION_ID,
  payload: {
    request_id: APPROVAL_REQUEST_ID,
    command: 'rm -rf build',
    description: 'recursive delete',
    choices: [APPROVAL_CHOICE_ONCE, APPROVAL_CHOICE_SESSION, APPROVAL_CHOICE_DENY],
    allow_permanent: false,
  },
}

const TURN_COMPLETE: GatewayEvent = {
  type: 'message.complete',
  session_id: SESSION_ID,
  payload: { status: 'complete' },
}

describe('approvalOptions', () => {
  it('maps gateway choices onto ACP option kinds, keyed by the choice string', () => {
    const { options, unknownChoices } = approvalOptions({
      request_id: APPROVAL_REQUEST_ID,
      command: 'rm -rf build',
      description: 'recursive delete',
      choices: ['once', 'session', 'always', 'deny'],
      allow_permanent: true,
    })

    expect(unknownChoices).toEqual([])
    expect(options.map((option) => [option.optionId, option.kind])).toEqual([
      ['once', 'allow_once'],
      ['session', 'allow_always'],
      ['always', 'allow_always'],
      ['deny', 'reject_once'],
    ])
  })

  it('drops a permanent grant Hermes said it will not honor, and any choice it cannot present', () => {
    const { options, unknownChoices } = approvalOptions({
      request_id: APPROVAL_REQUEST_ID,
      command: 'rm -rf build',
      description: 'recursive delete',
      choices: ['once', 'always', 'escalate', 'deny'],
      allow_permanent: false,
    })

    // An unrecognized choice must never reach `approval.respond`: upstream
    // approves on every resolved choice that is not "deny".
    expect(unknownChoices).toEqual(['escalate'])
    expect(options.map((option) => option.optionId)).toEqual(['once', 'deny'])
  })

  it('falls back to allow-once/deny when the gateway offered no choices', () => {
    const { options } = approvalOptions({
      request_id: APPROVAL_REQUEST_ID,
      command: 'rm -rf build',
      description: 'recursive delete',
    })
    expect(options.map((option) => option.optionId)).toEqual(['once', 'deny'])
  })
})

describe('approval.request', () => {
  it('relays the selected choice and references the tool call the client saw start', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)
      fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: APPROVAL_CHOICE_ONCE } })

      fixture.gateway.emit(TERMINAL_TOOL_START)
      fixture.gateway.emit(APPROVAL_REQUEST)
      await waitForGatewayCall(fixture.gateway, 'approvalRespond')

      expect(gatewayCalls(fixture.gateway, 'approvalRespond')).toEqual([
        {
          method: 'approvalRespond',
          args: [{ session_id: SESSION_ID, request_id: APPROVAL_REQUEST_ID, choice: APPROVAL_CHOICE_ONCE }],
        },
      ])

      const transcript = fixture.transcript()
      const toolCallIndex = transcript.findIndex((entry) => entry.kind === 'notification')
      const permissionIndex = transcript.findIndex(
        (entry) => entry.kind === 'request' && entry.method === acp.methods.client.session.requestPermission,
      )
      // The permission prompt must arrive after the tool_call it points at.
      expect(toolCallIndex).toBeLessThan(permissionIndex)
      expect(transcript[permissionIndex]?.params).toMatchObject({
        sessionId: STORED_SESSION_ID,
        toolCall: { toolCallId: TOOL_CALL_ID, status: 'pending' },
      })
      // The permission prompt parked the row as pending; an allow moves it
      // back to running, since the gateway says nothing until the tool ends.
      await waitFor(
        () => fixture.transcript().some((entry) => entry.method === acp.methods.client.session.update && (entry.params as { update: { status?: string } }).update.status === 'in_progress'),
        'tool_call_update in_progress',
      )
      expect(fixture.transcript().at(-1)?.params).toEqual({
        sessionId: STORED_SESSION_ID,
        update: { sessionUpdate: 'tool_call_update', toolCallId: TOOL_CALL_ID, status: 'in_progress' },
      })

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('denies when the client dismisses the prompt', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)
      // No scripted answer: the fixture's fail-closed default is `cancelled`.

      fixture.gateway.emit(TERMINAL_TOOL_START)
      fixture.gateway.emit(APPROVAL_REQUEST)
      await waitForGatewayCall(fixture.gateway, 'approvalRespond')

      expect(gatewayCalls(fixture.gateway, 'approvalRespond')[0]?.args).toEqual([
        { session_id: SESSION_ID, request_id: APPROVAL_REQUEST_ID, choice: APPROVAL_CHOICE_DENY },
      ])

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('denies an option the adapter never offered', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)
      // "always" was filtered out by allow_permanent: false, so selecting it is
      // not consent to anything this adapter presented.
      fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'always' } })

      fixture.gateway.emit(TERMINAL_TOOL_START)
      fixture.gateway.emit(APPROVAL_REQUEST)
      await waitForGatewayCall(fixture.gateway, 'approvalRespond')

      expect(gatewayCalls(fixture.gateway, 'approvalRespond')[0]?.args).toEqual([
        { session_id: SESSION_ID, request_id: APPROVAL_REQUEST_ID, choice: APPROVAL_CHOICE_DENY },
      ])

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('opens a real tool call for the gate when no tool call is in flight', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)
      fixture.setPermissionResponse({ outcome: { outcome: 'selected', optionId: APPROVAL_CHOICE_ONCE } })

      fixture.gateway.emit(APPROVAL_REQUEST)
      await waitForGatewayCall(fixture.gateway, 'approvalRespond')

      const gateToolCallId = `${APPROVAL_GATE_TOOL_CALL_PREFIX}${APPROVAL_REQUEST_ID}`
      const transcript = fixture.transcript()
      const opened = transcript.find(
        (entry) => entry.kind === 'notification' && (entry.params as { update?: { toolCallId?: string } }).update?.toolCallId === gateToolCallId,
      )
      // The referenced tool call is one the client actually received, never a
      // dangling id (the upstream defect in acp_adapter/permissions.py).
      expect(opened?.params).toMatchObject({ update: { sessionUpdate: 'tool_call', status: 'pending' } })
      const permission = transcript.find(
        (entry) => entry.kind === 'request' && entry.method === acp.methods.client.session.requestPermission,
      )
      expect(permission?.params).toMatchObject({ toolCall: { toolCallId: gateToolCallId } })

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('denies exactly once when the turn ends while the user is still deciding', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)

      let answerUser: (answer: RequestPermissionResponse) => void = () => undefined
      fixture.setPermissionResponse(
        new Promise<RequestPermissionResponse>((resolve) => {
          answerUser = resolve
        }),
      )

      fixture.gateway.emit(TERMINAL_TOOL_START)
      fixture.gateway.emit(APPROVAL_REQUEST)
      await waitForAcpRequest(fixture, acp.methods.client.session.requestPermission)

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
      expect(gatewayCalls(fixture.gateway, 'approvalRespond')[0]?.args).toEqual([
        { session_id: SESSION_ID, request_id: APPROVAL_REQUEST_ID, choice: APPROVAL_CHOICE_DENY },
      ])

      // The late answer must not re-send the request_id: upstream resolves by
      // id and would apply it to whatever approval is queued by then.
      answerUser({ outcome: { outcome: 'selected', optionId: APPROVAL_CHOICE_ONCE } })
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 10))
      expect(gatewayCalls(fixture.gateway, 'approvalRespond')).toHaveLength(1)
    } finally {
      fixture.close()
    }
  })

  it('closes the gate row as failed and ignores a late allow when the turn ends first', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)

      let answerUser: (answer: RequestPermissionResponse) => void = () => undefined
      fixture.setPermissionResponse(
        new Promise<RequestPermissionResponse>((resolve) => {
          answerUser = resolve
        }),
      )

      // No tool.start: the approval opens its own gate row, which is the one
      // the turn's end has to close.
      fixture.gateway.emit(APPROVAL_REQUEST)
      await waitForAcpRequest(fixture, acp.methods.client.session.requestPermission)

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })

      answerUser({ outcome: { outcome: 'selected', optionId: APPROVAL_CHOICE_ONCE } })
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 10))

      // The late allow changes nothing: Hermes was told "deny" once, and the
      // client's transcript must not show the gate as having succeeded.
      expect(gatewayCalls(fixture.gateway, 'approvalRespond').map((call) => call.args)).toEqual([
        [{ session_id: SESSION_ID, request_id: APPROVAL_REQUEST_ID, choice: APPROVAL_CHOICE_DENY }],
      ])
      const gateToolCallId = `${APPROVAL_GATE_TOOL_CALL_PREFIX}${APPROVAL_REQUEST_ID}`
      const gateUpdates = fixture
        .transcript()
        .filter(
          (entry) => (entry.params as { update?: { toolCallId?: string } }).update?.toolCallId === gateToolCallId,
        )
        .map((entry) => (entry.params as { update: { status?: string } }).update.status)
      expect(gateUpdates).toEqual(['pending', 'failed'])
    } finally {
      fixture.close()
    }
  })

  it('denies without prompting when no offered choice can be presented', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)

      fixture.gateway.emit({
        type: 'approval.request',
        session_id: SESSION_ID,
        payload: {
          request_id: APPROVAL_REQUEST_ID,
          command: 'rm -rf build',
          description: 'recursive delete',
          choices: ['escalate'],
        },
      })
      await waitForGatewayCall(fixture.gateway, 'approvalRespond')

      expect(gatewayCalls(fixture.gateway, 'approvalRespond')[0]?.args).toEqual([
        { session_id: SESSION_ID, request_id: APPROVAL_REQUEST_ID, choice: APPROVAL_CHOICE_DENY },
      ])
      // Nothing is shown for a prompt with no answerable option.
      expect(
        fixture.transcript().filter((entry) => entry.method === acp.methods.client.session.requestPermission),
      ).toEqual([])

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('denies when the client errors on the permission request', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)
      fixture.setPermissionResponse(Promise.reject(new Error('client blew up')))

      fixture.gateway.emit(TERMINAL_TOOL_START)
      fixture.gateway.emit(APPROVAL_REQUEST)
      await waitForGatewayCall(fixture.gateway, 'approvalRespond')

      expect(gatewayCalls(fixture.gateway, 'approvalRespond')[0]?.args).toEqual([
        { session_id: SESSION_ID, request_id: APPROVAL_REQUEST_ID, choice: APPROVAL_CHOICE_DENY },
      ])

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('denies an approval that arrives on a session with no turn in flight', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      fixture.gateway.emit(APPROVAL_REQUEST)
      await waitForGatewayCall(fixture.gateway, 'approvalRespond')

      expect(gatewayCalls(fixture.gateway, 'approvalRespond')[0]?.args).toEqual([
        { session_id: SESSION_ID, request_id: APPROVAL_REQUEST_ID, choice: APPROVAL_CHOICE_DENY },
      ])
      // Nothing was shown to the client: there is no turn for it to belong to.
      expect(fixture.transcript()).toEqual([])
    } finally {
      fixture.close()
    }
  })
})

describe('clarify.request', () => {
  it('asks a single-choice question as an enum form and relays the answer', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)
      fixture.setElicitationResponse({ action: 'accept', content: { [CLARIFY_ANSWER_FIELD]: 'postgres' } })

      fixture.gateway.emit({
        type: 'tool.start',
        session_id: SESSION_ID,
        payload: { tool_id: TOOL_CALL_ID, name: CLARIFY_TOOL_NAME, context: 'clarify' },
      })
      fixture.gateway.emit({
        type: 'clarify.request',
        session_id: SESSION_ID,
        payload: { request_id: CLARIFY_REQUEST_ID, question: 'Which database?', choices: ['postgres', 'sqlite'] },
      })
      await waitForGatewayCall(fixture.gateway, 'clarifyRespond')

      expect(gatewayCalls(fixture.gateway, 'clarifyRespond')).toEqual([
        { method: 'clarifyRespond', args: [{ request_id: CLARIFY_REQUEST_ID, answer: 'postgres' }] },
      ])

      const elicitation = fixture
        .transcript()
        .find((entry) => entry.kind === 'request' && entry.method === acp.methods.client.elicitation.create)
      expect(elicitation?.params).toMatchObject({
        sessionId: STORED_SESSION_ID,
        // Tied to the clarify tool call the client is already showing.
        toolCallId: TOOL_CALL_ID,
        mode: 'form',
        message: 'Which database?',
        requestedSchema: {
          type: 'object',
          properties: { [CLARIFY_ANSWER_FIELD]: { type: 'string', enum: ['postgres', 'sqlite'] } },
          required: [CLARIFY_ANSWER_FIELD],
        },
      })

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('asks a multi-select single question as an array form', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)
      fixture.setElicitationResponse({ action: 'accept', content: { [CLARIFY_ANSWER_FIELD]: ['postgres', 'sqlite'] } })

      fixture.gateway.emit({
        type: 'clarify.request',
        session_id: SESSION_ID,
        payload: { request_id: CLARIFY_REQUEST_ID, question: 'Which databases?', choices: ['postgres', 'sqlite'], multi_select: true },
      })
      await waitForAcpRequest(fixture, acp.methods.client.elicitation.create)

      const elicitation = fixture
        .transcript()
        .find((entry) => entry.kind === 'request' && entry.method === acp.methods.client.elicitation.create)
      expect(elicitation?.params).toMatchObject({
        requestedSchema: {
          properties: { [CLARIFY_ANSWER_FIELD]: { type: 'array', items: { type: 'string', enum: ['postgres', 'sqlite'] } } },
        },
      })

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('asks a free-text question as a string form', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)
      fixture.setElicitationResponse({ action: 'accept', content: { [CLARIFY_ANSWER_FIELD]: 'the staging cluster' } })

      fixture.gateway.emit({
        type: 'clarify.request',
        session_id: SESSION_ID,
        payload: { request_id: CLARIFY_REQUEST_ID, question: 'Which environment?' },
      })
      await waitForGatewayCall(fixture.gateway, 'clarifyRespond')

      expect(gatewayCalls(fixture.gateway, 'clarifyRespond')[0]?.args).toEqual([
        { request_id: CLARIFY_REQUEST_ID, answer: 'the staging cluster' },
      ])
      const elicitation = fixture
        .transcript()
        .find((entry) => entry.kind === 'request' && entry.method === acp.methods.client.elicitation.create)
      expect(elicitation?.params).toMatchObject({
        requestedSchema: { properties: { [CLARIFY_ANSWER_FIELD]: { type: 'string' } } },
      })

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('asks a batch one question at a time and locks each answer by qid', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)
      fixture.setElicitationResponse((params) => ({
        action: 'accept',
        content: {
          [CLARIFY_ANSWER_FIELD]: params.message === 'Which database?' ? 'postgres' : ['redis', 'nats'],
        },
      }))

      fixture.gateway.emit({
        type: 'clarify.request',
        session_id: SESSION_ID,
        payload: {
          request_id: CLARIFY_REQUEST_ID,
          questions: [
            { qid: 'q1', question: 'Which database?', choices: ['postgres', 'sqlite'] },
            { qid: 'q2', question: 'Which queues?', choices: ['redis', 'nats'], multi_select: true },
          ],
        },
      })
      await waitFor(() => gatewayCalls(fixture.gateway, 'clarifyRespond').length === 2, 'both clarify answers')

      expect(gatewayCalls(fixture.gateway, 'clarifyRespond').map((call) => call.args)).toEqual([
        [{ request_id: CLARIFY_REQUEST_ID, answer: 'postgres', question_id: 'q1' }],
        // Multi-select rides as JSON so a choice containing a comma survives
        // Hermes' comma-splitting fallback.
        [{ request_id: CLARIFY_REQUEST_ID, answer: '["redis","nats"]', question_id: 'q2' }],
      ])

      const multiSelect = fixture
        .transcript()
        .filter((entry) => entry.kind === 'request' && entry.method === acp.methods.client.elicitation.create)[1]
      expect(multiSelect?.params).toMatchObject({
        requestedSchema: {
          properties: { [CLARIFY_ANSWER_FIELD]: { type: 'array', items: { type: 'string', enum: ['redis', 'nats'] } } },
        },
      })

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('skips questions the gateway replayed as already answered', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)
      fixture.setElicitationResponse({ action: 'accept', content: { [CLARIFY_ANSWER_FIELD]: 'sqlite' } })

      fixture.gateway.emit({
        type: 'clarify.request',
        session_id: SESSION_ID,
        payload: {
          request_id: CLARIFY_REQUEST_ID,
          questions: [
            { qid: 'q1', question: 'Which database?' },
            { qid: 'q2', question: 'Which cache?' },
          ],
          answers: { q1: 'postgres' },
        },
      })
      await waitForGatewayCall(fixture.gateway, 'clarifyRespond')

      expect(gatewayCalls(fixture.gateway, 'clarifyRespond').map((call) => call.args)).toEqual([
        [{ request_id: CLARIFY_REQUEST_ID, answer: 'sqlite', question_id: 'q2' }],
      ])

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('answers nothing when the client cancels the question', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)
      // The fixture's fail-closed default is `cancel`.

      fixture.gateway.emit({
        type: 'clarify.request',
        session_id: SESSION_ID,
        payload: { request_id: CLARIFY_REQUEST_ID, question: 'Which environment?' },
      })
      await waitForAcpRequest(fixture, acp.methods.client.elicitation.create)

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
      // No fabricated answer: a question has no fail-closed reply, so Hermes'
      // server-side timeout resolves it.
      expect(gatewayCalls(fixture.gateway, 'clarifyRespond')).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('does not ask a client that never advertised form elicitation', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture, false)
      const { response } = await startPrompt(fixture)

      fixture.gateway.emit({
        type: 'clarify.request',
        session_id: SESSION_ID,
        payload: { request_id: CLARIFY_REQUEST_ID, question: 'Which environment?' },
      })
      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })

      expect(
        fixture.transcript().filter((entry) => entry.method === acp.methods.client.elicitation.create),
      ).toEqual([])
      expect(gatewayCalls(fixture.gateway, 'clarifyRespond')).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('does not open a second card when the gateway replays a clarify already being asked', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)

      // The card stays open: the replay must be dropped while the user is still
      // looking at the first one, not stacked behind it.
      fixture.setElicitationResponse(() => new Promise<CreateElicitationResponse>(() => undefined))
      const clarifyRequest: GatewayEvent = {
        type: 'clarify.request',
        session_id: SESSION_ID,
        payload: { request_id: CLARIFY_REQUEST_ID, question: 'Which environment?' },
      }
      fixture.gateway.emit(clarifyRequest)
      await waitForAcpRequest(fixture, acp.methods.client.elicitation.create)
      fixture.gateway.emit(clarifyRequest)
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 10))

      expect(
        fixture.transcript().filter((entry) => entry.method === acp.methods.client.elicitation.create),
      ).toHaveLength(1)

      fixture.gateway.emit(TURN_COMPLETE)
      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('does not open a card for a turn that ended while the queue was draining', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const { response } = await startPrompt(fixture)
      // Loud failure mode: were the card opened, this answer would be locked
      // into a turn that is already over.
      fixture.setElicitationResponse({ action: 'accept', content: { [CLARIFY_ANSWER_FIELD]: 'staging' } })

      fixture.gateway.emit({
        type: 'clarify.request',
        session_id: SESSION_ID,
        payload: { request_id: CLARIFY_REQUEST_ID, question: 'Which environment?' },
      })
      // Settles the turn inside the drain the clarify path awaits before
      // asking. Teardown has already cancelled every elicitation it knew about,
      // so a card opened after this point is one nothing would ever abort.
      fixture.gateway.emit(TURN_COMPLETE)

      await expect(response).resolves.toEqual({ stopReason: 'end_turn' })
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 10))

      expect(
        fixture.transcript().filter((entry) => entry.method === acp.methods.client.elicitation.create),
      ).toEqual([])
      expect(gatewayCalls(fixture.gateway, 'clarifyRespond')).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('ignores a clarify that arrives on a session with no turn in flight', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      fixture.gateway.emit({
        type: 'clarify.request',
        session_id: SESSION_ID,
        payload: { request_id: CLARIFY_REQUEST_ID, question: 'Which environment?' },
      })
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 10))

      expect(fixture.transcript()).toEqual([])
      expect(gatewayCalls(fixture.gateway, 'clarifyRespond')).toEqual([])
    } finally {
      fixture.close()
    }
  })
})
