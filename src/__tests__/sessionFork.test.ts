/**
 * `session/fork`: head-only branching of a tracked session onto a new gateway
 * session, plus the guards that keep a fork off a busy, closing, or unknown
 * parent. Scripted gateway, no real Hermes.
 */

import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { MODEL_OPTIONS_TIMEOUT_MS } from '../constants.js'
import { GatewayRpcError } from '../gateway/GatewayClient.js'
import type { SessionBranchResult, SessionCloseResult, SessionInfo } from '../gateway/types.js'
import type { AcpTestFixture, GatewayRequestMethod, ScriptedGateway } from './acpTestFixture.js'
import {
  createAcpTestFixture,
  scriptSessionSettings,
  TEST_COMMAND_CATALOG,
  TEST_GATEWAY_BUILD_IDENTITY,
} from './acpTestFixture.js'

const TEST_CWD = '/tmp/hermes-acp-session-fork'
// Live gateway ids and stored keys are deliberately distinct on both sides of
// the fork, so every assertion proves which namespace a value came from.
const PARENT_GATEWAY_SESSION_ID = 'gw-parent-1'
const PARENT_STORED_SESSION_ID = 'stored-parent-1'
const CHILD_GATEWAY_SESSION_ID = 'gw-child-1'
const CHILD_STORED_SESSION_ID = 'stored-child-1'

// tui_gateway/methods_session.py `session.branch`: an empty parent history is
// refused before anything is created.
const GATEWAY_CODE_NOTHING_TO_BRANCH = 4008

const CALL_POLL_INTERVAL_MS = 1
const CALL_POLL_ATTEMPTS = 500

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
 * The branched session's info: the FULL `_session_info` shape, not the lazy
 * skeleton `session.create` answers with — `session.branch` builds the child's
 * agent before it responds.
 */
const childSessionInfo: SessionInfo = {
  model: 'test-model',
  provider: 'test-provider',
  reasoning_effort: 'medium',
  service_tier: 'default',
  fast: false,
  yolo: false,
  approval_mode: 'ask',
  tools: {},
  cwd: TEST_CWD,
  running: false,
  title: 'parent chat (branch)',
  stored_session_id: CHILD_STORED_SESSION_ID,
  turn_started_at: null,
  ...TEST_GATEWAY_BUILD_IDENTITY,
}

const branchResult: SessionBranchResult = {
  session_id: CHILD_GATEWAY_SESSION_ID,
  stored_session_id: CHILD_STORED_SESSION_ID,
  title: 'parent chat (branch)',
  parent: PARENT_STORED_SESSION_ID,
  message_count: 1,
  messages: [{ role: 'user', text: 'hello' }],
  info: childSessionInfo,
}

/** Open the session every fork in this file branches from. */
async function openParent(fixture: AcpTestFixture): Promise<void> {
  fixture.gateway.setResult('sessionCreate', {
    session_id: PARENT_GATEWAY_SESSION_ID,
    stored_session_id: PARENT_STORED_SESSION_ID,
  })
  scriptSessionSettings(fixture.gateway)
  fixture.gateway.setResult('commandsCatalog', TEST_COMMAND_CATALOG)
  await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
  fixture.gateway.clearRecordedCalls()
  fixture.clearTranscript()
}

/**
 * Script `session.branch` to hang until the returned `release` is called: the
 * fork claim on the parent is held for exactly that long, which is the window
 * the concurrency guards exist for.
 */
function pendingBranch(fixture: AcpTestFixture): { readonly release: (result: SessionBranchResult) => void } {
  let release!: (result: SessionBranchResult) => void
  fixture.gateway.setResult(
    'sessionBranch',
    new Promise<SessionBranchResult>((resolve) => {
      release = resolve
    }),
  )
  return { release: (result) => { release(result) } }
}

function recordedUpdates(fixture: AcpTestFixture): readonly acp.SessionNotification[] {
  return fixture
    .transcript()
    .filter((entry) => entry.method === acp.methods.client.session.update)
    .map((entry) => entry.params as acp.SessionNotification)
}

describe('session/fork', () => {
  it('branches the parent head-only and registers the child under its own stored key', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openParent(fixture)
      fixture.gateway.setResult('sessionBranch', branchResult)

      const response = await fixture.client.request(acp.methods.agent.session.fork, {
        sessionId: PARENT_STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })

      expect(response.sessionId).toBe(CHILD_STORED_SESSION_ID)
      expect(response.modes?.currentModeId).toBe('default')
      expect(response.configOptions?.[0]).toMatchObject({ id: 'model', currentValue: 'nous/hermes-4-70b' })

      // No `count`: head-only forking is the contract, and this exact call
      // record is what a later breakpoint change has to trip over. The branch
      // takes the parent's LIVE id; every setup read that follows takes the
      // CHILD's, which is how the child's own registration is proven.
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'sessionBranch', args: [{ session_id: PARENT_GATEWAY_SESSION_ID, name: '' }] },
        { method: 'modelOptions', args: [{ session_id: CHILD_GATEWAY_SESSION_ID }, MODEL_OPTIONS_TIMEOUT_MS] },
        { method: 'configGet', args: [{ key: 'approval_mode', session_id: CHILD_GATEWAY_SESSION_ID }] },
        { method: 'commandsCatalog', args: [] },
      ])

      expect(fixture.server.session(CHILD_STORED_SESSION_ID)).toMatchObject({
        storedSessionId: CHILD_STORED_SESSION_ID,
        storedKey: CHILD_STORED_SESSION_ID,
        gatewaySessionId: CHILD_GATEWAY_SESSION_ID,
        cwd: TEST_CWD,
        activeTurn: null,
        activePrompt: null,
        closing: false,
      })
      // The parent is untouched: forking subscribes the client to a second
      // session, it does not move the one it branched from.
      expect(fixture.server.session(PARENT_STORED_SESSION_ID)).toMatchObject({
        gatewaySessionId: PARENT_GATEWAY_SESSION_ID,
        activeTurn: null,
        activePrompt: null,
      })
      // The child is a stored session of its own, so session/list must be able
      // to resolve its cwd in a later process too.
      expect(fixture.sessionDirectory.get(CHILD_STORED_SESSION_ID)?.cwd).toBe(TEST_CWD)

      // The establishment tail ran on the CHILD's channel: its own commands
      // update, addressed to the child's sessionId, and nothing on the
      // parent's. The copied transcript is deliberately not replayed —
      // ForkSessionResponse has no replay channel.
      const updates = recordedUpdates(fixture)
      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        sessionId: CHILD_STORED_SESSION_ID,
        update: { sessionUpdate: 'available_commands_update' },
      })
    } finally {
      fixture.close()
    }
  })

  it('refuses a fork while the parent has a turn in flight', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openParent(fixture)
      fixture.gateway.setResult('promptSubmit', { status: 'streaming' })
      const pending = fixture.client.request(acp.methods.agent.session.prompt, {
        sessionId: PARENT_STORED_SESSION_ID,
        prompt: [{ type: 'text', text: 'summarize the repo' }],
      })
      await waitForGatewayCall(fixture.gateway, 'promptSubmit')
      fixture.gateway.clearRecordedCalls()

      // Branching mid-turn would race the in-flight history write, and the
      // gateway's own session.branch has no running check to catch it.
      await expect(
        fixture.client.request(acp.methods.agent.session.fork, {
          sessionId: PARENT_STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining('already has a turn in flight'),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])

      fixture.gateway.emit({
        type: 'message.complete',
        session_id: PARENT_GATEWAY_SESSION_ID,
        payload: { status: 'complete' },
      })
      await expect(pending).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('refuses a fork while the parent is being closed', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openParent(fixture)
      // Held open so the fork lands while the teardown is in flight — past the
      // `closing` flag, which is set before the close's first await.
      let releaseClose!: (result: SessionCloseResult) => void
      fixture.gateway.setResult(
        'sessionClose',
        new Promise<SessionCloseResult>((resolve) => {
          releaseClose = resolve
        }),
      )
      const closing = fixture.client.request(acp.methods.agent.session.close, {
        sessionId: PARENT_STORED_SESSION_ID,
      })
      await waitForGatewayCall(fixture.gateway, 'sessionClose')

      await expect(
        fixture.client.request(acp.methods.agent.session.fork, {
          sessionId: PARENT_STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining('being closed'),
      })
      expect(fixture.gateway.recordedCalls().some((call) => call.method === 'sessionBranch')).toBe(false)

      releaseClose({ closed: true })
      await expect(closing).resolves.toEqual({})
    } finally {
      fixture.close()
    }
  })

  it('rejects a fork of an untracked session without touching the gateway', async () => {
    const fixture = createAcpTestFixture()
    try {
      // Consistent with every other session-scoped method: the gateway could
      // branch a stored id it knows, but this adapter has no record to hang the
      // child's parent state (cwd, live id) off.
      await expect(
        fixture.client.request(acp.methods.agent.session.fork, {
          sessionId: 'never-seen',
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('unknown session'),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('rejects a fork whose cwd disagrees with the parent', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openParent(fixture)

      // The gateway roots the child at the parent's cwd, so the request is
      // asking for something the fork cannot deliver.
      await expect(
        fixture.client.request(acp.methods.agent.session.fork, {
          sessionId: PARENT_STORED_SESSION_ID,
          cwd: '/somewhere/else',
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('/somewhere/else'),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('rejects mcpServers before touching the gateway', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openParent(fixture)

      // The same fast reject `session/new` makes: MCP passthrough is not
      // implemented, and a fork request carrying servers fails identically.
      await expect(
        fixture.client.request(acp.methods.agent.session.fork, {
          sessionId: PARENT_STORED_SESSION_ID,
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
      await openParent(fixture)

      await expect(
        fixture.client.request(acp.methods.agent.session.fork, {
          sessionId: PARENT_STORED_SESSION_ID,
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

  it('surfaces a gateway session.branch failure with its code', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openParent(fixture)
      fixture.gateway.setFailure(
        'sessionBranch',
        new GatewayRpcError('nothing to branch — send a message first', GATEWAY_CODE_NOTHING_TO_BRANCH),
      )

      await expect(
        fixture.client.request(acp.methods.agent.session.fork, {
          sessionId: PARENT_STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        data: { gatewayCode: GATEWAY_CODE_NOTHING_TO_BRANCH },
        message: expect.stringContaining('gateway method session.branch failed: nothing to branch'),
      })
      // Nothing was registered around the failed branch.
      expect(fixture.server.session(CHILD_STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('fails the request and closes the child when session.branch carries no stored_session_id', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openParent(fixture)
      // The stored key anchors the ACP sessionId namespace list/resume/delete
      // share, so a branch without one is a gateway contract violation and no
      // child may be fabricated around it.
      fixture.gateway.setResult('sessionBranch', { session_id: CHILD_GATEWAY_SESSION_ID })
      fixture.gateway.setResult('sessionClose', { closed: true })

      await expect(
        fixture.client.request(acp.methods.agent.session.fork, {
          sessionId: PARENT_STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('stored_session_id'),
      })
      // The branch had already built the child on the gateway, so it is closed
      // rather than left running with no record pointing at it.
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'sessionBranch', args: [{ session_id: PARENT_GATEWAY_SESSION_ID, name: '' }] },
        { method: 'sessionClose', args: [CHILD_GATEWAY_SESSION_ID] },
      ])
      // Nothing was registered: no record, and no establishment tail ran (the
      // child's commands update is what would prove one did).
      expect(fixture.server.session(CHILD_STORED_SESSION_ID)).toBeUndefined()
      expect(recordedUpdates(fixture)).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('fails and discards the child when the gateway branched it at a different cwd', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openParent(fixture)
      // The parent's LIVE cwd can move after it was opened (a terminal tool
      // settling in a sibling worktree, a project switch), and the child
      // inherits the moved one; registering it under the parent's stale cwd
      // would persist a directory the child is not running in.
      fixture.gateway.setResult('sessionBranch', {
        ...branchResult,
        info: { ...childSessionInfo, cwd: '/somewhere/else' },
      })
      fixture.gateway.setResult('sessionClose', { closed: true })

      await expect(
        fixture.client.request(acp.methods.agent.session.fork, {
          sessionId: PARENT_STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('/somewhere/else'),
      })

      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'sessionBranch', args: [{ session_id: PARENT_GATEWAY_SESSION_ID, name: '' }] },
        { method: 'sessionClose', args: [CHILD_GATEWAY_SESSION_ID] },
      ])
      expect(fixture.server.session(CHILD_STORED_SESSION_ID)).toBeUndefined()
      expect(fixture.sessionDirectory.get(CHILD_STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('refuses a prompt on the parent while the branch is in flight', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openParent(fixture)
      // Held open so the prompt lands inside the branch round-trip — the window
      // the `activeTurn` check alone cannot cover, since upstream copies the
      // history and builds the child's agent before it answers.
      const { release } = pendingBranch(fixture)
      const forking = fixture.client.request(acp.methods.agent.session.fork, {
        sessionId: PARENT_STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })
      await waitForGatewayCall(fixture.gateway, 'sessionBranch')

      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: PARENT_STORED_SESSION_ID,
          prompt: [{ type: 'text', text: 'summarize the repo' }],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining('being forked'),
      })
      // The refused prompt never reached the gateway, so nothing was submitted
      // into the history the branch is snapshotting.
      expect(fixture.gateway.recordedCalls().some((call) => call.method === 'promptSubmit')).toBe(false)

      release(branchResult)
      expect((await forking).sessionId).toBe(CHILD_STORED_SESSION_ID)
      // The claim ended with the fork: the parent takes prompts again.
      expect(fixture.server.session(PARENT_STORED_SESSION_ID)?.forking).toBe(false)
    } finally {
      fixture.close()
    }
  })

  it('refuses a second fork of the same parent while the first is in flight', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openParent(fixture)
      const { release } = pendingBranch(fixture)
      const first = fixture.client.request(acp.methods.agent.session.fork, {
        sessionId: PARENT_STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })
      await waitForGatewayCall(fixture.gateway, 'sessionBranch')

      await expect(
        fixture.client.request(acp.methods.agent.session.fork, {
          sessionId: PARENT_STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining('already has a fork in flight'),
      })
      // The loser never reached the gateway: both children would have been
      // branched from the same head.
      expect(fixture.gateway.recordedCalls().filter((call) => call.method === 'sessionBranch')).toHaveLength(1)

      release(branchResult)
      expect((await first).sessionId).toBe(CHILD_STORED_SESSION_ID)
    } finally {
      fixture.close()
    }
  })

  it('refuses a close of the parent while the branch is in flight', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openParent(fixture)
      // The teardown half of the same race: `session.branch` runs in the
      // gateway's long-handler pool, so a close committed alongside it either
      // fails the fork or strands a child parented to a session being closed.
      const { release } = pendingBranch(fixture)
      const forking = fixture.client.request(acp.methods.agent.session.fork, {
        sessionId: PARENT_STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })
      await waitForGatewayCall(fixture.gateway, 'sessionBranch')

      await expect(
        fixture.client.request(acp.methods.agent.session.close, { sessionId: PARENT_STORED_SESSION_ID }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining('being forked'),
      })
      expect(fixture.gateway.recordedCalls().some((call) => call.method === 'sessionClose')).toBe(false)

      release(branchResult)
      expect((await forking).sessionId).toBe(CHILD_STORED_SESSION_ID)
      expect(fixture.server.session(PARENT_STORED_SESSION_ID)?.forking).toBe(false)
    } finally {
      fixture.close()
    }
  })

  it('refuses a delete of the parent while the branch is in flight', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openParent(fixture)
      const { release } = pendingBranch(fixture)
      const forking = fixture.client.request(acp.methods.agent.session.fork, {
        sessionId: PARENT_STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })
      await waitForGatewayCall(fixture.gateway, 'sessionBranch')

      await expect(
        fixture.client.request(acp.methods.agent.session.delete, { sessionId: PARENT_STORED_SESSION_ID }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining('being forked'),
      })
      // Refused before the teardown AND before the delete: the row the branch
      // is copying from must still be there when it lands.
      expect(fixture.gateway.recordedCalls().some((call) => call.method === 'sessionClose')).toBe(false)
      expect(fixture.gateway.recordedCalls().some((call) => call.method === 'sessionDelete')).toBe(false)

      release(branchResult)
      expect((await forking).sessionId).toBe(CHILD_STORED_SESSION_ID)
    } finally {
      fixture.close()
    }
  })

  it('releases the parent when a fork fails, so a later fork still works', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openParent(fixture)
      // A branch that fails the contract check, past the point where the claim
      // was taken: without the clearing `finally`, the parent would be wedged
      // unforkable and unpromptable for the rest of its life.
      fixture.gateway.setResult('sessionBranch', { session_id: CHILD_GATEWAY_SESSION_ID })
      fixture.gateway.setResult('sessionClose', { closed: true })
      await expect(
        fixture.client.request(acp.methods.agent.session.fork, {
          sessionId: PARENT_STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({ code: acp.RequestError.internalError().code })
      expect(fixture.server.session(PARENT_STORED_SESSION_ID)?.forking).toBe(false)

      fixture.gateway.setResult('sessionBranch', branchResult)
      const response = await fixture.client.request(acp.methods.agent.session.fork, {
        sessionId: PARENT_STORED_SESSION_ID,
        cwd: TEST_CWD,
        mcpServers: [],
      })

      expect(response.sessionId).toBe(CHILD_STORED_SESSION_ID)
      expect(fixture.server.session(CHILD_STORED_SESSION_ID)).toMatchObject({
        gatewaySessionId: CHILD_GATEWAY_SESSION_ID,
        forking: false,
      })
    } finally {
      fixture.close()
    }
  })
})
