/**
 * `session/close` and `session/delete`: teardown of tracked sessions
 * (in-flight turn included) and deletion straight off `session/list`.
 * Scripted gateway, no real Hermes.
 */

import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { GatewayRpcError } from '../gateway/GatewayClient.js'
import type { AcpTestFixture, GatewayRequestMethod, ScriptedGateway } from './acpTestFixture.js'
import { createAcpTestFixture, scriptSessionSettings } from './acpTestFixture.js'

const TEST_CWD = '/tmp/hermes-acp-session-close'
const GATEWAY_SESSION_ID = 'gw-session-1'
// The ACP sessionId: the stored session key, deliberately distinct from the
// live gateway id so a test always proves which namespace a value came from.
const STORED_SESSION_ID = 'stored-1'

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

async function openSession(fixture: AcpTestFixture): Promise<void> {
  fixture.gateway.setResult('sessionCreate', {
    session_id: GATEWAY_SESSION_ID,
    stored_session_id: STORED_SESSION_ID,
  })
  scriptSessionSettings(fixture.gateway)
  await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
  fixture.gateway.clearRecordedCalls()
  fixture.clearTranscript()
}

function recordedUpdates(fixture: AcpTestFixture): readonly unknown[] {
  return fixture
    .transcript(['sessionId'])
    .filter((entry) => entry.method === acp.methods.client.session.update)
    .map((entry) => (entry.params as { update: unknown }).update)
}

describe('session/close', () => {
  it('rejects an unknown session without touching the gateway', async () => {
    const fixture = createAcpTestFixture()
    try {
      await expect(
        fixture.client.request(acp.methods.agent.session.close, { sessionId: 'never-seen' }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('unknown session'),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('closes the live gateway session and forgets the record, but keeps the cwd cache', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('sessionClose', { closed: true })

      const response = await fixture.client.request(acp.methods.agent.session.close, {
        sessionId: STORED_SESSION_ID,
      })

      expect(response).toEqual({})
      // session.close takes the LIVE id, not the stored key the client sent.
      expect(fixture.gateway.recordedCalls()).toEqual([{ method: 'sessionClose', args: [GATEWAY_SESSION_ID] }])
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
      // The stored session still exists, so session/list must keep resolving
      // its cwd; only session/delete removes the entry.
      expect(fixture.sessionDirectory.get(STORED_SESSION_ID)?.cwd).toBe(TEST_CWD)
    } finally {
      fixture.close()
    }
  })

  it('settles an in-flight prompt as cancelled before closing', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('promptSubmit', { status: 'streaming' })
      const pending = fixture.client.request(acp.methods.agent.session.prompt, {
        sessionId: STORED_SESSION_ID,
        prompt: [{ type: 'text', text: 'summarize the repo' }],
      })
      await waitForGatewayCall(fixture.gateway, 'promptSubmit')
      fixture.gateway.clearRecordedCalls()
      fixture.gateway.setResult('sessionInterrupt', { status: 'interrupting' })
      fixture.gateway.setResult('sessionClose', { closed: true })
      let promptAnswered = false
      void pending.then(() => {
        promptAnswered = true
      })

      const response = await fixture.client.request(acp.methods.agent.session.close, {
        sessionId: STORED_SESSION_ID,
      })

      expect(response).toEqual({})
      // The pending prompt resolved rather than hanging on a terminal frame
      // nobody is waiting for anymore — and before the close answered, so the
      // client never hears from a session it was told is gone.
      expect(promptAnswered).toBe(true)
      await expect(pending).resolves.toEqual({ stopReason: 'cancelled' })
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'sessionInterrupt', args: [GATEWAY_SESSION_ID] },
        { method: 'sessionClose', args: [GATEWAY_SESSION_ID] },
      ])
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('refuses a prompt that arrives while the close is still in flight', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      let releaseClose!: (result: { closed: boolean }) => void
      fixture.gateway.setResult(
        'sessionClose',
        new Promise<{ closed: boolean }>((resolve) => {
          releaseClose = resolve
        }),
      )
      const closing = fixture.client.request(acp.methods.agent.session.close, { sessionId: STORED_SESSION_ID })
      await waitForGatewayCall(fixture.gateway, 'sessionClose')

      // The record is still registered but no longer promptable: a turn
      // installed now would never be abandoned, and its event routing comes
      // down with the teardown — the prompt would pend indefinitely.
      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [{ type: 'text', text: 'summarize the repo' }],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining('being closed'),
      })
      expect(fixture.gateway.recordedCalls().filter((call) => call.method === 'promptSubmit')).toEqual([])
      // Same window, same refusal for the config surface: a config.set against
      // a session being closed would land on a gateway session about to go.
      await expect(
        fixture.client.request(acp.methods.agent.session.setMode, { sessionId: STORED_SESSION_ID, modeId: 'dont_ask' }),
      ).rejects.toMatchObject({ message: expect.stringContaining('being closed') })
      await expect(
        fixture.client.request(acp.methods.agent.session.setConfigOption, {
          sessionId: STORED_SESSION_ID,
          configId: 'approval_mode',
          value: 'manual',
        }),
      ).rejects.toMatchObject({ message: expect.stringContaining('being closed') })
      expect(fixture.gateway.recordedCalls().filter((call) => call.method === 'configSet')).toEqual([])

      releaseClose({ closed: true })
      await expect(closing).resolves.toEqual({})
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('refuses a load that arrives while the close is still in flight', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      let releaseClose!: (result: { closed: boolean }) => void
      fixture.gateway.setResult(
        'sessionClose',
        new Promise<{ closed: boolean }>((resolve) => {
          releaseClose = resolve
        }),
      )
      const closing = fixture.client.request(acp.methods.agent.session.close, { sessionId: STORED_SESSION_ID })
      await waitForGatewayCall(fixture.gateway, 'sessionClose')

      // A tracked load answered from the record would replay into a channel
      // the teardown is about to close.
      await expect(
        fixture.client.request(acp.methods.agent.session.load, {
          sessionId: STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining('being closed'),
      })
      expect(fixture.gateway.recordedCalls().filter((call) => call.method === 'sessionHistory')).toEqual([])

      releaseClose({ closed: true })
      await expect(closing).resolves.toEqual({})
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('surfaces a session.close failure and keeps the record registered', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setFailure('sessionClose')

      await expect(
        fixture.client.request(acp.methods.agent.session.close, { sessionId: STORED_SESSION_ID }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('gateway method session.close failed'),
      })

      // The gateway session may still be live, so the record pointing at it
      // stays: dropping it would strand events and block a retry.
      expect(fixture.server.session(STORED_SESSION_ID)).toBeDefined()
      // And it is promptable again — the closing flag lives only while the
      // teardown is in flight, so a failed close lifts it.
      expect(fixture.server.session(STORED_SESSION_ID)?.closing).toBe(false)

      // And its update channel is still open — a close that failed before
      // committing must not leave a record that silently swallows updates.
      fixture.gateway.emit({
        type: 'session.title',
        session_id: GATEWAY_SESSION_ID,
        payload: { title: 'still here' },
      })
      await fixture.server.session(STORED_SESSION_ID)?.updates.drained()
      // One more tick for the in-process client to run its notification handler.
      await new Promise((resolve) => setTimeout(resolve, CALL_POLL_INTERVAL_MS))
      expect(recordedUpdates(fixture)).toEqual([{ sessionUpdate: 'session_info_update', title: 'still here' }])
    } finally {
      fixture.close()
    }
  })
})

describe('session/delete', () => {
  it('deletes an untracked stored session straight off session/list', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.sessionDirectory.remember(STORED_SESSION_ID, TEST_CWD)
      fixture.gateway.setResult('sessionDelete', { deleted: STORED_SESSION_ID })

      const response = await fixture.client.request(acp.methods.agent.session.delete, {
        sessionId: STORED_SESSION_ID,
      })

      expect(response).toEqual({})
      // Nothing was live in this process, so there is nothing to close;
      // session.delete takes the stored key.
      expect(fixture.gateway.recordedCalls()).toEqual([{ method: 'sessionDelete', args: [STORED_SESSION_ID] }])
      expect(fixture.sessionDirectory.get(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('tears a tracked session down before deleting it', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('sessionClose', { closed: true })
      fixture.gateway.setResult('sessionDelete', { deleted: STORED_SESSION_ID })

      const response = await fixture.client.request(acp.methods.agent.session.delete, {
        sessionId: STORED_SESSION_ID,
      })

      expect(response).toEqual({})
      // The gateway refuses to delete a session that is live in its process
      // (4023), so the live session is closed first.
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'sessionClose', args: [GATEWAY_SESSION_ID] },
        { method: 'sessionDelete', args: [STORED_SESSION_ID] },
      ])
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
      expect(fixture.sessionDirectory.get(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('surfaces the gateway 4023 when the session is live elsewhere', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setFailure(
        'sessionDelete',
        new GatewayRpcError('session is live in this gateway process', 4023),
      )

      await expect(
        fixture.client.request(acp.methods.agent.session.delete, { sessionId: STORED_SESSION_ID }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('gateway method session.delete failed'),
        data: { gatewayCode: 4023 },
      })
    } finally {
      fixture.close()
    }
  })
})
