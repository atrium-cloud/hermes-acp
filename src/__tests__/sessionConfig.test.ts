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
import type { ConfigSetResult, ModelOptionsResult, SessionInfo } from '../gateway/types.js'
import { canonicalModelValueId, modelSwitchParams, modelValueId, parseModelValueId } from '../turn/configOptions.js'
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

// A session pointed at a named `providers:` entry of the custom lane
// (config.yaml `model.provider: custom:acps-managed`). `model.options`
// advertises the lane as one `custom` row while `session.info` reports the
// qualified entry reference, so both spellings describe this one selection.
const CUSTOM_MODEL = 'z-ai/glm-5.3-flash'
const CUSTOM_ENTRY_PROVIDER = 'custom:acps-managed'
const CUSTOM_MODEL_VALUE = 'custom/z-ai/glm-5.3-flash'
const CUSTOM_LANE_CATALOG: ModelOptionsResult = {
  model: CUSTOM_MODEL,
  // The catalog's top level reports config.yaml's `model.provider` while its
  // rows carry lane slugs. The qualified spelling is used here because it is
  // the harder of the two the top level can carry; the live repro opened with
  // the bare lane, which is the same path every native provider takes.
  provider: CUSTOM_ENTRY_PROVIDER,
  providers: [
    { slug: 'nous', name: 'Nous Research', models: ['hermes-4-70b', 'hermes-4-405b'], authenticated: true },
    { slug: 'custom', name: 'Custom', models: [CUSTOM_MODEL], is_current: true, authenticated: true },
  ],
}

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

async function openSession(
  fixture: AcpTestFixture,
  supportsElicitation = true,
  catalog?: ModelOptionsResult,
): Promise<void> {
  // Scripted before initialize: the auth-method build reads the model catalog
  // too, and leaving it unscripted only produces a stderr line, not a failure.
  fixture.gateway.setResult('sessionCreate', { session_id: SESSION_ID, stored_session_id: STORED_SESSION_ID })
  scriptSessionSettings(fixture.gateway, catalog ? { catalog } : {})
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

/** Every value the model select advertises, groups flattened away. */
function advertisedModelValues(configOptions: acp.SessionConfigOption[] | null | undefined): string[] {
  const option = configOptions?.find((entry) => entry.id === 'model')
  if (!option || option.type !== 'select') {
    throw new Error('response carried no model select option')
  }
  const entries: readonly (acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup)[] = option.options
  return entries.flatMap((entry) => ('group' in entry ? entry.options.map((choice) => choice.value) : [entry.value]))
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
      // The catalog this session opened on carries no custom row at all, so the
      // lane is synthesized — under its own spelling, not the entry's.
      expect(option).toMatchObject({ currentValue: 'custom/local-llama' })
      // A select whose currentValue names no option is malformed, so the live
      // model is added rather than dropped.
      expect(advertisedModelValues(update.configOptions)).toContain('custom/local-llama')
    } finally {
      fixture.close()
    }
  })
})

describe('named custom provider entries', () => {
  it('reports the session model under the lane spelling session/new advertised', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', { session_id: SESSION_ID, stored_session_id: STORED_SESSION_ID })
      scriptSessionSettings(fixture.gateway, { catalog: CUSTOM_LANE_CATALOG })

      const response = await fixture.client.request(acp.methods.agent.session.new, {
        cwd: TEST_CWD,
        mcpServers: [],
      })
      const option = response.configOptions?.find((entry) => entry.id === 'model')
      expect(option).toMatchObject({ currentValue: CUSTOM_MODEL_VALUE })
      expect(advertisedModelValues(response.configOptions)).toContain(CUSTOM_MODEL_VALUE)

      // The gateway's own report of the same selection names the entry rather
      // than the lane. That is the same model, so it is not a transition and
      // must not restate the current value in a spelling no option carries.
      fixture.clearTranscript()
      await emitSessionInfo(fixture, sessionInfo({ model: CUSTOM_MODEL, provider: CUSTOM_ENTRY_PROVIDER }))
      expect(updates(fixture)).toEqual([])
      expect(fixture.server.session(STORED_SESSION_ID)?.settings.modelValueId).toBe(CUSTOM_MODEL_VALUE)
    } finally {
      fixture.close()
    }
  })

  it('echoes the value that was set after the gateway confirms it as the entry', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture, true, CUSTOM_LANE_CATALOG)
      fixture.gateway.setResult('configSet', { key: 'model', value: CUSTOM_MODEL })

      const response = await fixture.client.request(acp.methods.agent.session.setConfigOption, {
        sessionId: STORED_SESSION_ID,
        configId: 'model',
        value: CUSTOM_MODEL_VALUE,
      })

      // The lane resolves back to the configured entry gateway-side, so the
      // bare slug is what the switch carries.
      expect(fixture.gateway.recordedCalls()).toEqual([
        {
          method: 'configSet',
          args: [{ key: 'model', value: `${CUSTOM_MODEL} --provider custom`, session_id: SESSION_ID }],
        },
      ])
      expect(currentModelValue(fixture, response)).toBe(CUSTOM_MODEL_VALUE)

      await emitSessionInfo(fixture, sessionInfo({ model: CUSTOM_MODEL, provider: CUSTOM_ENTRY_PROVIDER }))
      expect(updates(fixture)).toEqual([])
      expect(fixture.server.session(STORED_SESSION_ID)?.settings.modelValueId).toBe(CUSTOM_MODEL_VALUE)
    } finally {
      fixture.close()
    }
  })

  it('canonicalizes a deferred pick that arrived under the entry spelling', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture, true, CUSTOM_LANE_CATALOG)
      fixture.gateway.setResult('configSet', { key: 'model', value: CUSTOM_MODEL, deferred: true })

      // A client echoing back a value some older build reported: the same
      // selection, spelled as the entry rather than as the lane.
      const response = await fixture.client.request(acp.methods.agent.session.setConfigOption, {
        sessionId: STORED_SESSION_ID,
        configId: 'model',
        value: `${CUSTOM_ENTRY_PROVIDER}/${CUSTOM_MODEL}`,
      })

      expect(currentModelValue(fixture, response)).toBe(CUSTOM_MODEL_VALUE)
      // The queued pick is what later session.info frames are compared against,
      // so it has to be held in the spelling those frames reduce to.
      await emitSessionInfo(fixture, sessionInfo({ model: CUSTOM_MODEL, provider: CUSTOM_ENTRY_PROVIDER }))
      expect(updates(fixture)).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('leaves the unqualified custom lane and native lanes spelled as reported', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture, true, CUSTOM_LANE_CATALOG)

      // A config without a named entry reports the lane itself, which is
      // already the spelling the options carry.
      await emitSessionInfo(fixture, sessionInfo({ model: CUSTOM_MODEL, provider: 'custom' }))
      expect(updates(fixture)).toEqual([])

      await emitSessionInfo(fixture, sessionInfo({ model: 'hermes-4-405b', provider: 'nous' }))
      const update = updates(fixture)[0] as { configOptions: acp.SessionConfigOption[] }
      expect(update.configOptions.find((entry) => entry.id === 'model')).toMatchObject({
        currentValue: OTHER_MODEL_VALUE,
      })
      expect(advertisedModelValues(update.configOptions)).toContain(OTHER_MODEL_VALUE)
    } finally {
      fixture.close()
    }
  })

  it('offers a qualified reference to some other lane under its own spelling', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture, true, CUSTOM_LANE_CATALOG)

      // Only the custom lane's entry qualifier is dropped. Anything else is
      // reported as it arrived, and the synthesized option carries the same
      // value, so the select still names its own current value.
      await emitSessionInfo(fixture, sessionInfo({ model: 'some-model', provider: 'bespoke:endpoint' }))

      const update = updates(fixture)[0] as { configOptions: acp.SessionConfigOption[] }
      expect(update.configOptions.find((entry) => entry.id === 'model')).toMatchObject({
        currentValue: 'bespoke:endpoint/some-model',
      })
      expect(advertisedModelValues(update.configOptions)).toContain('bespoke:endpoint/some-model')
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

  it('spells a named custom entry as the lane, and reverses into the lane', () => {
    expect(modelValueId(CUSTOM_ENTRY_PROVIDER, CUSTOM_MODEL)).toBe(CUSTOM_MODEL_VALUE)
    expect(modelValueId('Custom:ACPS-Managed', CUSTOM_MODEL)).toBe(CUSTOM_MODEL_VALUE)
    expect(parseModelValueId(CUSTOM_MODEL_VALUE)).toEqual({ provider: 'custom', model: CUSTOM_MODEL })
    expect(modelSwitchParams(SESSION_ID, CUSTOM_MODEL_VALUE, false)).toEqual({
      key: 'model',
      value: `${CUSTOM_MODEL} --provider custom`,
      session_id: SESSION_ID,
    })
    expect(canonicalModelValueId(`${CUSTOM_ENTRY_PROVIDER}/${CUSTOM_MODEL}`)).toBe(CUSTOM_MODEL_VALUE)
    // The lane's own slug is a fixed point, and no other lane is rewritten.
    expect(modelValueId('custom', CUSTOM_MODEL)).toBe(CUSTOM_MODEL_VALUE)
    expect(modelValueId('bespoke:endpoint', 'some-model')).toBe('bespoke:endpoint/some-model')
    expect(canonicalModelValueId(CROSS_PROVIDER_VALUE)).toBe(CROSS_PROVIDER_VALUE)
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
