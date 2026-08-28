/**
 * Gateway version enforcement: the coarse `desktop_contract` gate that can
 * fail an open synchronously, and the `version` gate that arrives too late to
 * fail one and marks the session instead. Scripted gateway, no real Hermes.
 */

import * as acp from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ENV_SKIP_VERSION_CHECK,
  SUPPORTED_DESKTOP_CONTRACT,
  SUPPORTED_HERMES_MIN,
} from '../constants.js'
import type {
  ModelOptionsResult,
  SessionBranchResult,
  SessionCreateResult,
  SessionInfo,
} from '../gateway/types.js'
import type { AcpTestFixture, GatewayRequestMethod } from './acpTestFixture.js'
import {
  createAcpTestFixture,
  scriptSessionSettings,
  TEST_GATEWAY_COMPATIBILITY,
  TEST_MODEL_CATALOG,
} from './acpTestFixture.js'

const TEST_CWD = '/tmp/hermes-acp-gateway-compat'
const GATEWAY_SESSION_ID = 'gw-session-1'
const STORED_SESSION_ID = 'stored-1'
const CHILD_GATEWAY_SESSION_ID = 'gw-child-1'
const CHILD_STORED_SESSION_ID = 'stored-child-1'

// A Hermes older than the supported floor, and a backend that guarantees less
// than this adapter needs — the two ways the gateway can be out of range.
const OLD_HERMES_VERSION = '0.19.9'
const OLDER_CONTRACT = SUPPORTED_DESKTOP_CONTRACT - 1
// A contract ABOVE the floor is not out of range: it guarantees strictly more.
const NEWER_CONTRACT = SUPPORTED_DESKTOP_CONTRACT + 1

const UPDATE_TICK_MS = 1
const CALL_POLL_ATTEMPTS = 500

/** Events route only once the call that installs the turn has landed. */
async function waitForGatewayCall(fixture: AcpTestFixture, method: GatewayRequestMethod): Promise<void> {
  for (let attempt = 0; attempt < CALL_POLL_ATTEMPTS; attempt += 1) {
    if (fixture.gateway.recordedCalls().some((call) => call.method === method)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, UPDATE_TICK_MS))
  }
  throw new Error(`scripted gateway: ${method}() was never called`)
}

/** The full `_session_info` a built agent reports, compatible by default. */
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
    ...TEST_GATEWAY_COMPATIBILITY,
    ...overrides,
  }
}

/** `session.create`'s own info is the LAZY skeleton: `desktop_contract` but no
 * version, which is exactly why the two gates have different timing. */
function createResult(desktopContract: number = SUPPORTED_DESKTOP_CONTRACT): SessionCreateResult {
  return {
    session_id: GATEWAY_SESSION_ID,
    stored_session_id: STORED_SESSION_ID,
    message_count: 0,
    messages: [],
    info: { model: 'hermes-4-70b', tools: {}, cwd: TEST_CWD, lazy: true, desktop_contract: desktopContract },
  }
}

async function openSession(fixture: AcpTestFixture): Promise<void> {
  fixture.gateway.setResult('sessionCreate', createResult())
  scriptSessionSettings(fixture.gateway)
  await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
  fixture.gateway.clearRecordedCalls()
  fixture.clearTranscript()
}

/** Deliver a `session.info` and let the record apply it. */
async function emitSessionInfo(fixture: AcpTestFixture, info: SessionInfo): Promise<void> {
  fixture.gateway.emit({ type: 'session.info', session_id: GATEWAY_SESSION_ID, payload: info })
  await fixture.server.session(STORED_SESSION_ID)?.updates.drained()
  await new Promise((resolve) => setTimeout(resolve, UPDATE_TICK_MS))
}

describe('gateway compatibility', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('fails session/new when the gateway reports a desktop_contract below the floor', async () => {
    const fixture = createAcpTestFixture()
    try {
      // The coarse gate rides the lazy skeleton, so it is known before the
      // response is built and fails the request itself.
      fixture.gateway.setResult('sessionCreate', createResult(OLDER_CONTRACT))
      fixture.gateway.setResult('sessionClose', { closed: true })
      scriptSessionSettings(fixture.gateway)

      await expect(
        fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining(`desktop_contract ${OLDER_CONTRACT}`),
      })

      // The unsupported session was discarded rather than left running with no
      // record pointing at it, and the settings reads never happened.
      expect(fixture.gateway.recordedCalls().map((call) => call.method)).toEqual(['sessionCreate', 'sessionClose'])
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('opens a session on a gateway whose contract is ABOVE the floor', async () => {
    const fixture = createAcpTestFixture()
    try {
      // The contract counts capabilities the backend guarantees, so a newer
      // one provides everything this adapter uses. Refusing it would make a
      // routine Hermes bump a hard stop for a feature we do not even consume.
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
      fixture.gateway.setResult('sessionCreate', createResult(NEWER_CONTRACT))
      scriptSessionSettings(fixture.gateway)

      const response = await fixture.client.request(acp.methods.agent.session.new, {
        cwd: TEST_CWD,
        mcpServers: [],
      })

      expect(response.sessionId).toBe(STORED_SESSION_ID)
      expect(fixture.server.session(STORED_SESSION_ID)?.unsupported).toBeNull()
      // And silently: a newer contract always rides a newer version, which the
      // version channel reports on its own — two lines for one upgrade is just
      // double-logging.
      expect(warn.mock.calls.flat().join(' ')).not.toContain('desktop_contract')
    } finally {
      fixture.close()
    }
  })

  it('fails session/load on a below-floor contract, the same as session/new', async () => {
    const fixture = createAcpTestFixture()
    try {
      // The gate lives in the shared establishment tail, so resume and load
      // are covered by construction; this pins that they really are.
      fixture.gateway.setResult('sessionResume', {
        session_id: GATEWAY_SESSION_ID,
        resumed: STORED_SESSION_ID,
        messages: [],
        info: { cwd: TEST_CWD, lazy: true, desktop_contract: OLDER_CONTRACT },
      })
      fixture.gateway.setResult('sessionClose', { closed: true })
      scriptSessionSettings(fixture.gateway)

      await expect(
        fixture.client.request(acp.methods.agent.session.load, {
          sessionId: STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('session/load'),
      })
      expect(fixture.gateway.recordedCalls().map((call) => call.method)).toEqual(['sessionResume', 'sessionClose'])
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('marks a session whose info lands during registration and fails the open itself', async () => {
    const fixture = createAcpTestFixture()
    try {
      // The deferred agent build's first session.info — the only frame that
      // carries a version — usually arrives while the setup reads are still in
      // flight. session/new has not answered yet, so it must fail rather than
      // hand back a healthy-looking session whose next prompt is refused.
      fixture.gateway.setResult('sessionCreate', createResult())
      let releaseCatalog!: (catalog: ModelOptionsResult) => void
      fixture.gateway.setResult(
        'modelOptions',
        new Promise<ModelOptionsResult>((resolve) => {
          releaseCatalog = resolve
        }),
      )
      fixture.gateway.setResult('configGet', { value: 'manual' })
      fixture.gateway.setResult('sessionClose', { closed: true })

      const pending = fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
      await waitForGatewayCall(fixture, 'modelOptions')
      fixture.gateway.emit({
        type: 'session.info',
        session_id: GATEWAY_SESSION_ID,
        payload: sessionInfo({ version: OLD_HERMES_VERSION }),
      })
      releaseCatalog(TEST_MODEL_CATALOG)

      await expect(pending).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('session/new'),
      })
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
      expect(fixture.gateway.recordedCalls().some((call) => call.method === 'sessionClose')).toBe(true)
    } finally {
      fixture.close()
    }
  })

  it('names the bypass variable in the refusal', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', createResult(OLDER_CONTRACT))
      fixture.gateway.setResult('sessionClose', { closed: true })

      await expect(
        fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] }),
      ).rejects.toMatchObject({ message: expect.stringContaining(ENV_SKIP_VERSION_CHECK) })
    } finally {
      fixture.close()
    }
  })

  it('opens the session when the operator disarmed the check', async () => {
    const fixture = createAcpTestFixture()
    try {
      vi.stubEnv(ENV_SKIP_VERSION_CHECK, '1')
      fixture.gateway.setResult('sessionCreate', createResult(OLDER_CONTRACT))
      scriptSessionSettings(fixture.gateway)

      const response = await fixture.client.request(acp.methods.agent.session.new, {
        cwd: TEST_CWD,
        mcpServers: [],
      })

      expect(response.sessionId).toBe(STORED_SESSION_ID)
      // And the async channel stays disarmed too: an old version on the event
      // does not mark the record.
      await emitSessionInfo(fixture, sessionInfo({ version: OLD_HERMES_VERSION }))
      expect(fixture.server.session(STORED_SESSION_ID)?.unsupported).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('marks the session and fails the next prompt when session.info reports an old Hermes', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      // The version arrives only on the deferred agent build's event, after
      // session/new has already answered — so the open stands and the NEXT
      // request is what fails.
      await emitSessionInfo(fixture, sessionInfo({ version: OLD_HERMES_VERSION }))

      expect(fixture.server.session(STORED_SESSION_ID)?.unsupported).toContain(OLD_HERMES_VERSION)
      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [{ type: 'text', text: 'hello' }],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('unsupported Hermes gateway'),
      })
      expect(fixture.gateway.recordedCalls().some((call) => call.method === 'promptSubmit')).toBe(false)
    } finally {
      fixture.close()
    }
  })

  it('keeps close working on an unsupported session so the client can clean up', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      await emitSessionInfo(fixture, sessionInfo({ version: OLD_HERMES_VERSION }))
      fixture.gateway.setResult('sessionClose', { closed: true })

      // Cancel is a notification and must not throw either; close is the
      // request that actually has to succeed.
      await fixture.client.notify(acp.methods.agent.session.cancel, { sessionId: STORED_SESSION_ID })
      await expect(
        fixture.client.request(acp.methods.agent.session.close, { sessionId: STORED_SESSION_ID }),
      ).resolves.toEqual({})
      expect(fixture.server.session(STORED_SESSION_ID)).toBeUndefined()
    } finally {
      fixture.close()
    }
  })

  it('refuses a mode and config change on an unsupported session', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      await emitSessionInfo(fixture, sessionInfo({ version: OLD_HERMES_VERSION }))

      await expect(
        fixture.client.request(acp.methods.agent.session.setMode, {
          sessionId: STORED_SESSION_ID,
          modeId: 'dont_ask',
        }),
      ).rejects.toMatchObject({ code: acp.RequestError.internalError().code })
      await expect(
        fixture.client.request(acp.methods.agent.session.setConfigOption, {
          sessionId: STORED_SESSION_ID,
          configId: 'model',
          value: 'nous/hermes-4-70b',
        }),
      ).rejects.toMatchObject({ code: acp.RequestError.internalError().code })
      expect(fixture.gateway.recordedCalls().some((call) => call.method === 'configSet')).toBe(false)
    } finally {
      fixture.close()
    }
  })

  it('fails a fork synchronously when the branch response reports an old Hermes', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      // Unlike session.create, `session.branch` answers with the FULL info of
      // the child it built, so the fork gets a real version check in-request.
      const branchResult: SessionBranchResult = {
        session_id: CHILD_GATEWAY_SESSION_ID,
        stored_session_id: CHILD_STORED_SESSION_ID,
        info: sessionInfo({ version: OLD_HERMES_VERSION, stored_session_id: CHILD_STORED_SESSION_ID }),
      }
      fixture.gateway.setResult('sessionBranch', branchResult)
      fixture.gateway.setResult('sessionClose', { closed: true })

      await expect(
        fixture.client.request(acp.methods.agent.session.fork, {
          sessionId: STORED_SESSION_ID,
          cwd: TEST_CWD,
          mcpServers: [],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining(OLD_HERMES_VERSION),
      })

      // The child the branch had already built is closed, not leaked.
      expect(fixture.gateway.recordedCalls().map((call) => call.method)).toEqual(['sessionBranch', 'sessionClose'])
      expect(fixture.server.session(CHILD_STORED_SESSION_ID)).toBeUndefined()
      // The parent is untouched: only the child's gateway was out of range.
      expect(fixture.server.session(STORED_SESSION_ID)?.unsupported).toBeNull()
    } finally {
      fixture.close()
    }
  })

  // The warning dedup (`warnedGatewayVersions` in sessionSetup.ts) is
  // module-level and keyed by version string, so warn-asserting tests must
  // each use a distinct version key or the second one sees no warning.
  it('warns but proceeds when the gateway reports no version at all', async () => {
    const fixture = createAcpTestFixture()
    try {
      // Upstream seeds `version` empty and swallows a failed version import,
      // so an empty string is "not reported" — hard-failing on it would break
      // a Hermes whose only defect is a broken version import.
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
      await openSession(fixture)
      await emitSessionInfo(fixture, sessionInfo({ version: '' }))

      expect(fixture.server.session(STORED_SESSION_ID)?.unsupported).toBeNull()
      expect(warn.mock.calls.flat().join(' ')).toContain('no Hermes version')
    } finally {
      fixture.close()
    }
  })

  it('proceeds silently on a Hermes newer than the supported minimum', async () => {
    const fixture = createAcpTestFixture()
    try {
      // A newer Hermes is untested, not known-broken: there is no upper bound,
      // so an upgrade neither refuses nor warns. Drift is caught offline.
      const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
      const [major = 0, minor = 0] = SUPPORTED_HERMES_MIN.split('.').map(Number)
      const newerVersion = `${major}.${minor + 1}.0`
      await openSession(fixture)
      await emitSessionInfo(fixture, sessionInfo({ version: newerVersion }))

      expect(fixture.server.session(STORED_SESSION_ID)?.unsupported).toBeNull()
      expect(warn.mock.calls.flat().join(' ')).not.toContain(newerVersion)

      fixture.gateway.setResult('promptSubmit', { status: 'streaming' })
      const pending = fixture.client.request(acp.methods.agent.session.prompt, {
        sessionId: STORED_SESSION_ID,
        prompt: [{ type: 'text', text: 'hello' }],
      })
      // The turn is installed only once the submit lands; an event emitted
      // before that routes to nothing.
      await waitForGatewayCall(fixture, 'promptSubmit')
      fixture.gateway.emit({
        type: 'message.complete',
        session_id: GATEWAY_SESSION_ID,
        payload: { status: 'complete' },
      })
      await expect(pending).resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      fixture.close()
    }
  })

  it('rejects a malformed skip value instead of silently leaving the check armed', async () => {
    const fixture = createAcpTestFixture()
    try {
      vi.stubEnv(ENV_SKIP_VERSION_CHECK, 'yes-please')
      fixture.gateway.setResult('sessionCreate', createResult())
      fixture.gateway.setResult('sessionClose', { closed: true })
      scriptSessionSettings(fixture.gateway)

      await expect(
        fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] }),
        // A plain Error from the env layer, so the SDK ships the text in
        // `data.details` rather than as the message.
      ).rejects.toMatchObject({
        data: { details: expect.stringContaining(ENV_SKIP_VERSION_CHECK) },
      })
    } finally {
      fixture.close()
    }
  })

  it('accepts the pinned supported version', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      await emitSessionInfo(fixture, sessionInfo({ version: SUPPORTED_HERMES_MIN }))
      expect(fixture.server.session(STORED_SESSION_ID)?.unsupported).toBeNull()
    } finally {
      fixture.close()
    }
  })
})
