import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { GATEWAY_SESSION_SOURCE, MODEL_OPTIONS_TIMEOUT_MS } from '../constants.js'
import { GatewayRpcError } from '../gateway/GatewayClient.js'
import type { ModelOptionsResult, SessionCreateResult, SessionInfo } from '../gateway/types.js'
import type { GatewayRequestMethod, ScriptedGateway } from './acpTestFixture.js'
import {
  createAcpTestFixture,
  scriptSessionSettings,
  TEST_GATEWAY_COMPATIBILITY,
  TEST_MODEL_CATALOG,
} from './acpTestFixture.js'

const TEST_CWD = '/tmp/hermes-acp-session-new'
const GATEWAY_SESSION_ID = 'gw-session-1'
// The ACP sessionId: the stored session key, deliberately distinct from the
// live gateway id so a test always proves which namespace a value came from.
const STORED_SESSION_ID = 'stored-1'

const CALL_POLL_INTERVAL_MS = 1
const CALL_POLL_ATTEMPTS = 500

/**
 * The registration window opens only once `session/new` has reached the gateway,
 * so an event emitted before the call lands would test nothing.
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

// The FULL info shape: session.create's own snapshot is the lazy partial one
// upstream, but this object doubles as the session.info event payload, which
// is complete. Assignability into the lazy field comes for free.
const sessionInfo: SessionInfo = {
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
  title: '',
  stored_session_id: STORED_SESSION_ID,
  turn_started_at: null,
  ...TEST_GATEWAY_COMPATIBILITY,
}

// `info` is present here because every real gateway session.create returns it:
// omitting it would skip the cwd comparison entirely and leave the branch
// production always takes — the paths agree — untested.
const sessionCreateResult: SessionCreateResult = {
  session_id: GATEWAY_SESSION_ID,
  stored_session_id: STORED_SESSION_ID,
  message_count: 0,
  messages: [],
  info: sessionInfo,
}

describe('session/new', () => {
  it('creates a gateway session tagged with the adapter source and returns its id', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', sessionCreateResult)
      scriptSessionSettings(fixture.gateway)

      const response = await fixture.client.request(acp.methods.agent.session.new, {
        cwd: TEST_CWD,
        mcpServers: [],
      })

      expect(response.sessionId).toBe(STORED_SESSION_ID)
      expect(response.modes).toEqual({
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'dont_ask', name: "Don't ask" },
        ],
      })
      // The current model comes from the catalog, not from session.create's
      // lazy `info`, and its value id carries the provider it has to be
      // reversed into on the way back to config.set.
      expect(response.configOptions).toEqual([
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'nous/hermes-4-70b',
          options: [
            {
              group: 'nous',
              name: 'Nous Research',
              options: [
                { value: 'nous/hermes-4-70b', name: 'hermes-4-70b' },
                { value: 'nous/hermes-4-405b', name: 'hermes-4-405b' },
              ],
            },
            {
              group: 'openrouter',
              name: 'OpenRouter',
              options: [{ value: 'openrouter/deepseek/deepseek-v4-flash', name: 'deepseek/deepseek-v4-flash' }],
            },
          ],
        },
        {
          id: 'approval_mode',
          name: 'Approval mode (global)',
          type: 'select',
          currentValue: 'manual',
          options: [
            { value: 'manual', name: 'Manual' },
            { value: 'smart', name: 'Smart' },
            { value: 'off', name: 'Off' },
          ],
        },
      ])

      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'sessionCreate', args: [{ cwd: TEST_CWD, source: GATEWAY_SESSION_SOURCE }] },
        // No `refresh`: it busts every cache and probes every custom provider
        // endpoint, which has no business in a session open.
        { method: 'modelOptions', args: [{ session_id: GATEWAY_SESSION_ID }, MODEL_OPTIONS_TIMEOUT_MS] },
        { method: 'configGet', args: [{ key: 'approval_mode', session_id: GATEWAY_SESSION_ID }] },
        // Slash commands are snapshotted per session; this test scripts no
        // catalog, so the read fails and the session opens without commands.
        { method: 'commandsCatalog', args: [] },
      ])
      // toMatchObject, not toEqual: the record also carries the session's live
      // update channel, whose internals are not part of this assertion.
      expect(fixture.server.session(STORED_SESSION_ID)).toMatchObject({
        storedSessionId: STORED_SESSION_ID,
        gatewaySessionId: GATEWAY_SESSION_ID,
        cwd: TEST_CWD,
        activeTurn: null,
        activePrompt: null,
      })
      // The cwd cache learned the session, which is how a later process's
      // session/list will resolve it.
      expect(fixture.sessionDirectory.get(STORED_SESSION_ID)?.cwd).toBe(TEST_CWD)
    } finally {
      fixture.close()
    }
  })

  it('keeps a session.info that lands while the settings reads are still in flight', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', sessionCreateResult)
      // Held open so the event lands inside the registration window, which is
      // exactly where a `--yolo`-frozen gateway's first session.info arrives.
      let releaseCatalog!: (catalog: ModelOptionsResult) => void
      fixture.gateway.setResult(
        'modelOptions',
        new Promise<ModelOptionsResult>((resolve) => {
          releaseCatalog = resolve
        }),
      )
      fixture.gateway.setResult('configGet', { value: 'manual' })

      const pending = fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
      await waitForGatewayCall(fixture.gateway, 'modelOptions')
      fixture.gateway.emit({
        type: 'session.info',
        session_id: GATEWAY_SESSION_ID,
        payload: { ...sessionInfo, yolo: true },
      })
      releaseCatalog(TEST_MODEL_CATALOG)

      // The event wins over the reads it raced: the session really is bypassing
      // approvals, and the response is the client's first and only word on it.
      const response = await pending
      expect(response.modes?.currentModeId).toBe('dont_ask')
      expect(fixture.server.session(STORED_SESSION_ID)?.settings).toEqual({
        modelValueId: 'test-provider/test-model',
        approvalMode: 'manual',
        modeId: 'dont_ask',
      })

      // And the baseline moved with it: an identical session.info after
      // registration is not a transition and emits nothing.
      fixture.clearTranscript()
      fixture.gateway.emit({
        type: 'session.info',
        session_id: GATEWAY_SESSION_ID,
        payload: { ...sessionInfo, yolo: true },
      })
      await fixture.server.session(STORED_SESSION_ID)?.updates.drained()
      // One more tick for the in-process client to run its notification handler,
      // or an update that was sent would not be recorded yet.
      await new Promise((resolve) => setTimeout(resolve, CALL_POLL_INTERVAL_MS))
      expect(fixture.transcript()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('discards the registration when a settings read fails', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', sessionCreateResult)
      fixture.gateway.setFailure('configGet')
      fixture.gateway.setResult('modelOptions', TEST_MODEL_CATALOG)
      fixture.gateway.setResult('sessionClose', { closed: true })

      await expect(
        fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] }),
      ).rejects.toThrow('config.get')
      // The gateway session was closed, so no record may be left pointing at it.
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('rejects mcpServers before touching the gateway', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', sessionCreateResult)

      await expect(
        fixture.client.request(acp.methods.agent.session.new, {
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
      fixture.gateway.setResult('sessionCreate', sessionCreateResult)

      await expect(
        fixture.client.request(acp.methods.agent.session.new, {
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

  it('rejects a relative cwd before touching the gateway', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', sessionCreateResult)

      await expect(
        fixture.client.request(acp.methods.agent.session.new, { cwd: 'relative/dir', mcpServers: [] }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('absolute'),
      })

      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('fails and discards the session when the gateway resolves a different cwd', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', {
        ...sessionCreateResult,
        info: { ...sessionInfo, cwd: '/somewhere/else' },
      })
      fixture.gateway.setResult('sessionClose', { closed: true })

      await expect(
        fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('/somewhere/else'),
      })

      expect(fixture.gateway.recordedCalls().map((call) => call.method)).toEqual([
        'sessionCreate',
        'sessionClose',
      ])
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('frames a non-RPC gateway failure with the failed method', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setFailure('sessionCreate', new Error('gateway transport: request timed out'))

      await expect(
        fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('gateway method session.create failed: gateway transport: request timed out'),
      })
    } finally {
      fixture.close()
    }
  })

  it('propagates a gateway session.create failure instead of fabricating a session', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setFailure('sessionCreate', new GatewayRpcError('create failed: no provider credential', 5000))

      await expect(
        fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('gateway method session.create failed: create failed: no provider credential'),
      })

      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'sessionCreate', args: [{ cwd: TEST_CWD, source: GATEWAY_SESSION_SOURCE }] },
      ])
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('fails the request when session.create carries no stored_session_id', async () => {
    const fixture = createAcpTestFixture()
    try {
      // The stored key anchors the ACP sessionId namespace list/resume/delete
      // share, so a create without it is a gateway contract violation, not a
      // client error — and no session may be fabricated around it.
      fixture.gateway.setResult('sessionCreate', { session_id: GATEWAY_SESSION_ID })

      await expect(
        fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('stored_session_id'),
      })

      expect(fixture.server.session(GATEWAY_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })
})
