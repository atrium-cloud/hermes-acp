/**
 * Model selection and session modes: ACP option/mode sets in, gateway
 * `config.set` calls out, and the `session.info` frames the gateway answers
 * with translated back into `config_option_update` / `current_mode_update`.
 *
 * The model-switch hardening cases from docs/todos.md section 2 live here —
 * same model, cross-provider, bogus id, deferred mid-turn pick, and both
 * branches of the expensive-model confirmation.
 */

import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { PROTOCOL_VERSION } from '../constants.js'
import { GatewayRpcError } from '../gateway/GatewayClient.js'
import type { ConfigSetResult, SessionInfo } from '../gateway/types.js'
import { modelSwitchParams, modelValueId, parseModelValueId } from '../turn/configOptions.js'
import type { AcpTestFixture } from './acpTestFixture.js'
import { createAcpTestFixture, scriptSessionSettings, TEST_GATEWAY_BUILD_IDENTITY } from './acpTestFixture.js'

// ── Constants ───────────────────────────────────────────────────────────────

const TEST_CWD = '/tmp/hermes-acp-session-config'
// Live gateway id (events, session-scoped config.set calls); the ACP
// sessionId is the stored key below, distinct on purpose.
const SESSION_ID = 'gw-session-1'
const STORED_SESSION_ID = 'stored-1'

const CURRENT_MODEL_VALUE = 'nous/hermes-4-70b'
const OTHER_MODEL_VALUE = 'nous/hermes-4-405b'
const CROSS_PROVIDER_VALUE = 'openrouter/deepseek/deepseek-v4-flash'

/** tui_gateway rejects an unknown model id under this code (server.py ~12030). */
const BOGUS_MODEL_MESSAGE = "unknown model 'not-a-model'; run /model to list available models"
const BOGUS_MODEL_CODE = 5001

const CONFIRM_MESSAGE = 'gpt-5-pro costs $15.00 per million input tokens. Switch anyway?'

/** `_session_info` always reports the full record; these are its defaults. */
function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
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
    running: false,
    title: '',
    stored_session_id: STORED_SESSION_ID,
    turn_started_at: null,
    ...TEST_GATEWAY_BUILD_IDENTITY,
    ...overrides,
  }
}

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

/** Let anything already scheduled run, so "nothing further happened" is a real
 * assertion rather than one made before the work could have happened. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

async function openSession(fixture: AcpTestFixture, supportsElicitation = true): Promise<void> {
  // Scripted before initialize: the auth-method build reads the model catalog
  // too, and leaving it unscripted only produces a stderr line, not a failure.
  fixture.gateway.setResult('sessionCreate', { session_id: SESSION_ID, stored_session_id: STORED_SESSION_ID })
  scriptSessionSettings(fixture.gateway)
  await fixture.client.request(acp.methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: supportsElicitation ? { elicitation: { form: {} } } : {},
  })
  await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
  fixture.gateway.clearRecordedCalls()
  fixture.clearTranscript()
}

/** The session updates the client received, in order. */
function updates(fixture: AcpTestFixture): unknown[] {
  return fixture
    .transcript()
    .filter((entry) => entry.method === acp.methods.client.session.update)
    .map((entry) => (entry.params as { update: unknown }).update)
}

/** Emit a session.info and wait for the update channel to drain it. */
async function emitSessionInfo(fixture: AcpTestFixture, info: SessionInfo): Promise<void> {
  fixture.gateway.emit({ type: 'session.info', session_id: SESSION_ID, payload: info })
  const record = fixture.server.session(STORED_SESSION_ID)
  if (!record) {
    throw new Error(`session ${STORED_SESSION_ID} is not open`)
  }
  await record.updates.drained()
}

function currentModelValue(fixture: AcpTestFixture, response: acp.SetSessionConfigOptionResponse): string {
  const option = response.configOptions.find((entry) => entry.id === 'model')
  if (!option || option.type !== 'select') {
    throw new Error('response carried no model select option')
  }
  return option.currentValue
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('session/set_config_option: model', () => {
  it('reverses a value id into the gateway model switch, provider flag and all', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('configSet', { key: 'model', value: 'deepseek/deepseek-v4-flash' })

      await fixture.client.request(acp.methods.agent.session.setConfigOption, {
        sessionId: STORED_SESSION_ID,
        configId: 'model',
        value: CROSS_PROVIDER_VALUE,
      })

      // Only the first "/" separates provider from model: the model id keeps
      // the slash it carries on aggregator providers.
      expect(fixture.gateway.recordedCalls()).toEqual([
        {
          method: 'configSet',
          args: [
            {
              key: 'model',
              value: 'deepseek/deepseek-v4-flash --provider openrouter',
              session_id: SESSION_ID,
            },
          ],
        },
      ])
    } finally {
      fixture.close()
    }
  })

  it('switches to the model already selected without special-casing it', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('configSet', { key: 'model', value: 'hermes-4-70b' })

      const response = await fixture.client.request(acp.methods.agent.session.setConfigOption, {
        sessionId: STORED_SESSION_ID,
        configId: 'model',
        value: CURRENT_MODEL_VALUE,
      })

      expect(fixture.gateway.recordedCalls()).toEqual([
        {
          method: 'configSet',
          args: [{ key: 'model', value: 'hermes-4-70b --provider nous', session_id: SESSION_ID }],
        },
      ])
      expect(currentModelValue(fixture, response)).toBe(CURRENT_MODEL_VALUE)
      // The session did not move, so the gateway's echoed info says nothing new.
      await emitSessionInfo(fixture, sessionInfo())
      expect(updates(fixture)).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('surfaces a rejected model id as a JSON-RPC error carrying the gateway message', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setFailure('configSet', new GatewayRpcError(BOGUS_MODEL_MESSAGE, BOGUS_MODEL_CODE))

      await expect(
        fixture.client.request(acp.methods.agent.session.setConfigOption, {
          sessionId: STORED_SESSION_ID,
          configId: 'model',
          value: 'nous/not-a-model',
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining(`gateway method config.set failed: ${BOGUS_MODEL_MESSAGE}`),
        data: { gatewayCode: BOGUS_MODEL_CODE },
      })

      // Nothing was announced to the client: the switch did not happen.
      expect(updates(fixture)).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('reports a deferred mid-turn pick as current and stays silent when session.info echoes it', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('configSet', {
        key: 'model',
        value: 'hermes-4-405b',
        deferred: true,
        confirm_required: false,
      })

      const response = await fixture.client.request(acp.methods.agent.session.setConfigOption, {
        sessionId: STORED_SESSION_ID,
        configId: 'model',
        value: OTHER_MODEL_VALUE,
      })

      // A queued pick emits no session.info of its own, so the response is the
      // only place the client can learn the switch was accepted.
      expect(currentModelValue(fixture, response)).toBe(OTHER_MODEL_VALUE)
      expect(updates(fixture)).toEqual([])

      // Upstream reports the pending pick as the session's model until it
      // lands; that must not read as a second change.
      await emitSessionInfo(fixture, sessionInfo({ model: 'hermes-4-405b', running: true }))
      expect(updates(fixture)).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('emits config_option_update when session.info reports a different model', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await emitSessionInfo(fixture, sessionInfo({ model: 'hermes-4-405b' }))

      expect(updates(fixture)).toEqual([
        {
          sessionUpdate: 'config_option_update',
          configOptions: expect.arrayContaining([
            expect.objectContaining({ id: 'model', currentValue: OTHER_MODEL_VALUE }),
          ]),
        },
      ])
    } finally {
      fixture.close()
    }
  })

  it('keeps the last known model when session.info arrives before the agent has one', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await emitSessionInfo(fixture, sessionInfo({ model: '', provider: '' }))

      expect(updates(fixture)).toEqual([])
      expect(fixture.server.session(STORED_SESSION_ID)?.settings.modelValueId).toBe(CURRENT_MODEL_VALUE)
    } finally {
      fixture.close()
    }
  })

  it('offers the session model even when the catalog does not list it', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await emitSessionInfo(fixture, sessionInfo({ model: 'local-llama', provider: 'custom:lmstudio' }))

      const update = updates(fixture)[0] as { configOptions: acp.SessionConfigOption[] }
      const option = update.configOptions.find((entry) => entry.id === 'model')
      expect(option).toMatchObject({ currentValue: 'custom:lmstudio/local-llama' })
      // A select whose currentValue names no option is malformed, so the live
      // model is added rather than dropped.
      expect(JSON.stringify(option)).toContain('custom:lmstudio/local-llama')
    } finally {
      fixture.close()
    }
  })
})

describe('session/set_config_option: expensive-model confirmation', () => {
  it('re-sends the switch with the confirm flag once the user accepts', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('configSet', {
        key: 'model',
        value: '',
        confirm_required: true,
        confirm_message: CONFIRM_MESSAGE,
      })
      fixture.setElicitationResponse(() => {
        // The confirmed re-send is a second call with a different answer, which
        // the scripted gateway models by re-scripting between the two.
        fixture.gateway.setResult('configSet', { key: 'model', value: 'hermes-4-405b' })
        return { action: 'accept', content: { confirm: 'Yes' } }
      })

      await fixture.client.request(acp.methods.agent.session.setConfigOption, {
        sessionId: STORED_SESSION_ID,
        configId: 'model',
        value: OTHER_MODEL_VALUE,
      })

      expect(fixture.gateway.recordedCalls()).toEqual([
        {
          method: 'configSet',
          args: [{ key: 'model', value: 'hermes-4-405b --provider nous', session_id: SESSION_ID }],
        },
        {
          method: 'configSet',
          args: [
            {
              key: 'model',
              value: 'hermes-4-405b --provider nous',
              session_id: SESSION_ID,
              confirm_expensive_model: true,
            },
          ],
        },
      ])
      // The gateway's own wording is what the user was asked to accept.
      const elicitation = fixture.transcript().find((entry) => entry.kind === 'request')
      expect(elicitation?.params).toMatchObject({ message: CONFIRM_MESSAGE })
    } finally {
      fixture.close()
    }
  })

  it('never applies the switch when the request is cancelled while the card is open', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('configSet', {
        key: 'model',
        value: '',
        confirm_required: true,
        confirm_message: CONFIRM_MESSAGE,
      })

      // The card the user leaves open: it is answered only after the request
      // that opened it has been cancelled.
      let answerCard: (response: acp.CreateElicitationResponse) => void = () => undefined
      fixture.setElicitationResponse(
        () =>
          new Promise<acp.CreateElicitationResponse>((resolve) => {
            answerCard = resolve
          }),
      )

      const cancellation = new AbortController()
      const pending = fixture.client.request(
        acp.methods.agent.session.setConfigOption,
        { sessionId: STORED_SESSION_ID, configId: 'model', value: OTHER_MODEL_VALUE },
        { cancellationSignal: cancellation.signal },
      )
      await waitFor(
        () => fixture.transcript().some((entry) => entry.method === acp.methods.client.elicitation.create),
        'the confirmation card',
      )

      cancellation.abort()
      await expect(pending).rejects.toThrow()

      // A late "Yes" must not resume the switch: ACP cancellation is
      // cooperative, so nothing stops the client from answering afterwards.
      answerCard({ action: 'accept', content: { confirm: 'Yes' } })
      await settle()

      const switches = fixture.gateway.recordedCalls().filter((call) => call.method === 'configSet')
      expect(switches).toHaveLength(1)
      expect(switches[0]?.args[0]).not.toMatchObject({ confirm_expensive_model: true })
    } finally {
      fixture.close()
    }
  })

  it('fails the option set and never confirms when the user declines', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('configSet', {
        key: 'model',
        value: '',
        confirm_required: true,
        confirm_message: CONFIRM_MESSAGE,
      })
      fixture.setElicitationResponse({ action: 'decline' })

      await expect(
        fixture.client.request(acp.methods.agent.session.setConfigOption, {
          sessionId: STORED_SESSION_ID,
          configId: 'model',
          value: OTHER_MODEL_VALUE,
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining(CONFIRM_MESSAGE),
      })

      // Exactly one config.set: the unconfirmed one, which upstream did not apply.
      expect(fixture.gateway.recordedCalls()).toHaveLength(1)
    } finally {
      fixture.close()
    }
  })

  it('fails immediately against a client that cannot ask for confirmation', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture, false)
      fixture.gateway.setResult('configSet', {
        key: 'model',
        value: '',
        confirm_required: true,
        confirm_message: CONFIRM_MESSAGE,
      })

      await expect(
        fixture.client.request(acp.methods.agent.session.setConfigOption, {
          sessionId: STORED_SESSION_ID,
          configId: 'model',
          value: OTHER_MODEL_VALUE,
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidRequest().code,
        message: expect.stringContaining(CONFIRM_MESSAGE),
      })

      expect(fixture.gateway.recordedCalls()).toHaveLength(1)
      // No elicitation was attempted against a client that cannot answer one.
      expect(fixture.transcript()).toEqual([])
    } finally {
      fixture.close()
    }
  })
})

describe('session/set_config_option: approval mode', () => {
  it('applies the global approval mode without a session id', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('configSet', { key: 'approvals.mode', value: 'smart' })

      await fixture.client.request(acp.methods.agent.session.setConfigOption, {
        sessionId: STORED_SESSION_ID,
        configId: 'approval_mode',
        value: 'smart',
      })

      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'configSet', args: [{ key: 'approval_mode', value: 'smart' }] },
      ])
    } finally {
      fixture.close()
    }
  })

  it('rejects an approval mode the gateway does not accept', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await expect(
        fixture.client.request(acp.methods.agent.session.setConfigOption, {
          sessionId: STORED_SESSION_ID,
          configId: 'approval_mode',
          value: 'yolo',
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('unknown approval mode'),
      })

      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('reports a global flip to off as both a config option and a mode change', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      // approvals.mode = off is one of the three sources `_session_info` ORs
      // into `yolo`, so the effective mode moves with it.
      await emitSessionInfo(fixture, sessionInfo({ approval_mode: 'off', yolo: true }))

      expect(updates(fixture)).toEqual([
        { sessionUpdate: 'current_mode_update', currentModeId: 'dont_ask' },
        {
          sessionUpdate: 'config_option_update',
          configOptions: expect.arrayContaining([
            expect.objectContaining({ id: 'approval_mode', currentValue: 'off' }),
          ]),
        },
      ])
    } finally {
      fixture.close()
    }
  })

  it('rejects an unknown config option', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await expect(
        fixture.client.request(acp.methods.agent.session.setConfigOption, {
          sessionId: STORED_SESSION_ID,
          configId: 'reasoning_effort',
          value: 'high',
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('unknown config option'),
      })

      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })
})

describe('session.info skeleton', () => {
  it('ignores the workspace-move frame that carries no settings', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      const before = fixture.server.session(STORED_SESSION_ID)?.settings

      // `_apply_project_workspace` emits only {cwd, branch, project, lazy}
      // before the agent is built (server.py ~7894).
      fixture.gateway.emit({
        type: 'session.info',
        session_id: SESSION_ID,
        payload: { cwd: '/elsewhere', lazy: true },
      })
      await settle()

      expect(fixture.server.session(STORED_SESSION_ID)?.settings).toBe(before)
      expect(updates(fixture)).toEqual([])
    } finally {
      fixture.close()
    }
  })
})

describe('session/set_mode', () => {
  it("toggles only this session's approval bypass", async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('configSet', { key: 'yolo', value: '1', scope: 'session' })

      await fixture.client.request(acp.methods.agent.session.setMode, {
        sessionId: STORED_SESSION_ID,
        modeId: 'dont_ask',
      })

      expect(fixture.gateway.recordedCalls()).toEqual([
        {
          method: 'configSet',
          args: [{ key: 'yolo', value: 'on', scope: 'session', session_id: SESSION_ID }],
        },
      ])
    } finally {
      fixture.close()
    }
  })

  it('turns the bypass back off for the default mode', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('configSet', { key: 'yolo', value: '0', scope: 'session' })

      await fixture.client.request(acp.methods.agent.session.setMode, {
        sessionId: STORED_SESSION_ID,
        modeId: 'default',
      })

      expect(fixture.gateway.recordedCalls()).toEqual([
        {
          method: 'configSet',
          args: [{ key: 'yolo', value: 'off', scope: 'session', session_id: SESSION_ID }],
        },
      ])
    } finally {
      fixture.close()
    }
  })

  it('corrects the client when the gateway keeps the session in dont_ask despite the switch', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      await emitSessionInfo(fixture, sessionInfo({ yolo: true }))
      fixture.clearTranscript()
      // A global `approvals.mode: off` keeps the effective bypass on: the
      // switch's own session.info (emitted before the config.set answers)
      // still reports yolo, and it is no delta against the previous state.
      let answerConfigSet!: (result: ConfigSetResult) => void
      fixture.gateway.setResult(
        'configSet',
        new Promise<ConfigSetResult>((resolve) => {
          answerConfigSet = resolve
        }),
      )
      const switching = fixture.client.request(acp.methods.agent.session.setMode, {
        sessionId: STORED_SESSION_ID,
        modeId: 'default',
      })
      await waitFor(() => fixture.gateway.recordedCalls().some((call) => call.method === 'configSet'), 'config.set')
      fixture.gateway.emit({ type: 'session.info', session_id: SESSION_ID, payload: sessionInfo({ yolo: true }) })
      answerConfigSet({ key: 'yolo', value: '0', scope: 'session' })
      await switching
      await settle()

      expect(updates(fixture)).toEqual([{ sessionUpdate: 'current_mode_update', currentModeId: 'dont_ask' }])
    } finally {
      fixture.close()
    }
  })

  it('emits nothing when no session.info answers the switch', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      await emitSessionInfo(fixture, sessionInfo({ yolo: true }))
      fixture.clearTranscript()
      // The agent is still building, so the gateway flips the flag silently;
      // there is no effective state to correct toward and no lie to tell.
      fixture.gateway.setResult('configSet', { key: 'yolo', value: '0', scope: 'session' })

      await fixture.client.request(acp.methods.agent.session.setMode, {
        sessionId: STORED_SESSION_ID,
        modeId: 'default',
      })
      await settle()

      expect(updates(fixture)).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('emits current_mode_update from the session.info the switch triggers, once', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await emitSessionInfo(fixture, sessionInfo({ yolo: true }))
      await emitSessionInfo(fixture, sessionInfo({ yolo: true }))

      expect(updates(fixture)).toEqual([{ sessionUpdate: 'current_mode_update', currentModeId: 'dont_ask' }])
    } finally {
      fixture.close()
    }
  })

  it('rejects an unknown mode id', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await expect(
        fixture.client.request(acp.methods.agent.session.setMode, { sessionId: STORED_SESSION_ID, modeId: 'accept_edits' }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('unknown mode'),
      })

      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })
})

describe('config option shapes', () => {
  it('selects nothing rather than an empty option when no model is configured', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', { session_id: SESSION_ID, stored_session_id: STORED_SESSION_ID })
      scriptSessionSettings(fixture.gateway, {
        catalog: { providers: [{ slug: 'nous', name: 'Nous Research', models: ['hermes-4-70b'] }] },
      })

      const response = await fixture.client.request(acp.methods.agent.session.new, {
        cwd: TEST_CWD,
        mcpServers: [],
      })
      const option = response.configOptions?.find((entry) => entry.id === 'model')

      expect(option).toMatchObject({ type: 'select', currentValue: '' })
      // Nothing selectable stands for "no model": an option with an empty value
      // and an empty label would be a choice that means nothing.
      expect(JSON.stringify(option)).not.toContain('"value":""')
    } finally {
      fixture.close()
    }
  })

  it('matches a mixed-case configured provider against the catalog rows', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', { session_id: SESSION_ID, stored_session_id: STORED_SESSION_ID })
      // model.options reports config.yaml's `provider` verbatim while the rows
      // carry normalized slugs, so the two only meet after normalization.
      scriptSessionSettings(fixture.gateway, {
        catalog: {
          model: 'hermes-4-70b',
          provider: 'OpenRouter',
          providers: [{ slug: 'openrouter', name: 'OpenRouter', models: ['hermes-4-70b'] }],
        },
      })

      const response = await fixture.client.request(acp.methods.agent.session.new, {
        cwd: TEST_CWD,
        mcpServers: [],
      })
      const option = response.configOptions?.find((entry) => entry.id === 'model')

      expect(option).toMatchObject({ currentValue: 'openrouter/hermes-4-70b' })
      // One group, not a synthesized duplicate alongside the catalog's own.
      expect(option?.type === 'select' ? option.options : []).toHaveLength(1)
    } finally {
      fixture.close()
    }
  })
})

describe('model value ids', () => {
  it('round-trips a provider-qualified id through the gateway switch value', () => {
    expect(modelValueId('openrouter', 'deepseek/deepseek-v4-flash')).toBe(CROSS_PROVIDER_VALUE)
    expect(parseModelValueId(CROSS_PROVIDER_VALUE)).toEqual({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
    })
  })

  it('carries no provider flag when the gateway reports no provider', () => {
    // A pick queued mid-turn without an explicit --provider comes back with an
    // empty `display_provider`, so the id is the bare model and reverses into a
    // bare model — which is exactly what parse_model_switch_args accepts.
    expect(modelValueId('', 'hermes-4-70b')).toBe('hermes-4-70b')
    expect(modelSwitchParams(SESSION_ID, 'hermes-4-70b', false)).toEqual({
      key: 'model',
      value: 'hermes-4-70b',
      session_id: SESSION_ID,
    })
  })
})

describe('session/new settings read', () => {
  it('discards the gateway session when the model catalog cannot be read', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', { session_id: SESSION_ID, stored_session_id: STORED_SESSION_ID })
      fixture.gateway.setFailure('modelOptions', new GatewayRpcError('provider probe failed', 5033))
      fixture.gateway.setResult('sessionClose', { closed: true })

      await expect(
        fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('provider probe failed'),
      })

      expect(fixture.gateway.recordedCalls().map((call) => call.method)).toEqual([
        'sessionCreate',
        'modelOptions',
        'sessionClose',
      ])
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })
})
