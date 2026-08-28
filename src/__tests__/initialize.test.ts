import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import {
  AGENT_NAME,
  AGENT_TITLE,
  AUTH_METHOD_SETUP_ID,
  MODEL_OPTIONS_TIMEOUT_MS,
  AUTH_SETUP_FLAG,
  PROTOCOL_VERSION,
} from '../constants.js'
import type { ModelOptionsResult } from '../gateway/types.js'
import { createAcpTestFixture, TEST_MODEL_CATALOG } from './acpTestFixture.js'

/**
 * A Hermes whose configured provider has no usable key. Under the flags this
 * adapter passes, upstream simply omits such a provider and no row is current
 * at all; the `authenticated: false` current row modeled here is the
 * `include_unconfigured` shape, kept as the stricter of the two — a catalog
 * that says outright it is not authenticated must not be advertised either.
 */
const UNAUTHENTICATED_CATALOG: ModelOptionsResult = {
  model: 'hermes-4-70b',
  provider: 'nous',
  providers: [
    {
      slug: 'nous',
      name: 'Nous Research',
      models: ['hermes-4-70b'],
      total_models: 1,
      is_current: true,
      authenticated: false,
      auth_type: 'api_key',
      key_env: 'NOUS_API_KEY',
    },
  ],
}

const TERMINAL_AUTH_CLIENT: acp.ClientCapabilities = { auth: { terminal: true } }

describe('initialize', () => {
  it('negotiates protocol v1 with honest capabilities', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('modelOptions', TEST_MODEL_CATALOG)
      const response = await fixture.client.request(acp.methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      })

      expect(response.protocolVersion).toBe(PROTOCOL_VERSION)
      expect(response.agentInfo?.name).toBe(AGENT_NAME)
      expect(response.agentInfo?.title).toBe(AGENT_TITLE)
      // Exact, not a superset: `audio` must stay absent, and any capability
      // added here without an implementation is a lie to the client.
      expect(response.agentCapabilities).toEqual({
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, fork: {} },
        promptCapabilities: { image: true, embeddedContext: true },
      })
      // The only gateway call initialize makes: the provider catalog the auth
      // advertisement is derived from, on a budget short enough that a slow
      // provider probe cannot hold the handshake open.
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'modelOptions', args: [{}, MODEL_OPTIONS_TIMEOUT_MS] },
      ])
    } finally {
      fixture.close()
    }
  })

  it('advertises the resolved provider and, for a terminal-capable client, the setup method', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('modelOptions', TEST_MODEL_CATALOG)
      const response = await fixture.client.request(acp.methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: TERMINAL_AUTH_CLIENT,
      })

      expect(response.authMethods).toEqual([
        {
          id: 'nous',
          name: 'nous runtime credentials',
          description: 'Authenticate Hermes using the nous runtime credentials it is already configured with.',
        },
        {
          type: 'terminal',
          id: AUTH_METHOD_SETUP_ID,
          name: 'Configure Hermes provider',
          description:
            "Open Hermes' interactive model and provider setup in a terminal. Use this when Hermes has no usable provider credentials on this machine.",
          args: [AUTH_SETUP_FLAG],
        },
      ])
    } finally {
      fixture.close()
    }
  })

  it('withholds the terminal method from a client that cannot run one', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('modelOptions', TEST_MODEL_CATALOG)
      const response = await fixture.client.request(acp.methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      })

      // ACP requires the client to opt in via `auth.terminal` before an agent
      // may offer a terminal method.
      expect(response.authMethods).toEqual([
        {
          id: 'nous',
          name: 'nous runtime credentials',
          description: 'Authenticate Hermes using the nous runtime credentials it is already configured with.',
        },
      ])
    } finally {
      fixture.close()
    }
  })

  it('advertises no provider method when the configured provider has no usable credentials', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('modelOptions', UNAUTHENTICATED_CATALOG)
      const response = await fixture.client.request(acp.methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: TERMINAL_AUTH_CLIENT,
      })

      expect(response.authMethods?.map((method) => method.id)).toEqual([AUTH_METHOD_SETUP_ID])
    } finally {
      fixture.close()
    }
  })

  it('degrades to the setup method alone when the catalog read exceeds its budget', async () => {
    const fixture = createAcpTestFixture()
    try {
      // What a hung provider probe produces: GatewayClient rejects the call at
      // MODEL_OPTIONS_TIMEOUT_MS rather than the client-wide RPC budget,
      // and the handshake completes on the terminal method alone.
      fixture.gateway.setFailure(
        'modelOptions',
        new Error(`gateway request timed out after ${MODEL_OPTIONS_TIMEOUT_MS}ms: model.options`),
      )
      const response = await fixture.client.request(acp.methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: TERMINAL_AUTH_CLIENT,
      })

      expect(response.protocolVersion).toBe(PROTOCOL_VERSION)
      expect(response.authMethods?.map((method) => method.id)).toEqual([AUTH_METHOD_SETUP_ID])
    } finally {
      fixture.close()
    }
  })

  it('degrades to the setup method alone when the provider catalog cannot be read', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setFailure('modelOptions')
      const response = await fixture.client.request(acp.methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: TERMINAL_AUTH_CLIENT,
      })

      // Initialize still succeeds: an adapter that cannot read its credential
      // state must not claim one is authenticated, but interactive setup is
      // exactly what a broken credential state needs.
      expect(response.protocolVersion).toBe(PROTOCOL_VERSION)
      expect(response.authMethods?.map((method) => method.id)).toEqual([AUTH_METHOD_SETUP_ID])
    } finally {
      fixture.close()
    }
  })
})

describe('authenticate', () => {
  it('accepts the method naming the currently resolved provider', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('modelOptions', TEST_MODEL_CATALOG)
      await expect(
        fixture.client.request(acp.methods.agent.authenticate, { methodId: 'nous' }),
      ).resolves.toEqual({})
      // The same short budget as initialize: authenticate is equally a
      // round-trip the user is sitting in front of.
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'modelOptions', args: [{}, MODEL_OPTIONS_TIMEOUT_MS] },
      ])
    } finally {
      fixture.close()
    }
  })

  it('accepts the setup method once a provider resolves', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('modelOptions', TEST_MODEL_CATALOG)
      await expect(
        fixture.client.request(acp.methods.agent.authenticate, { methodId: AUTH_METHOD_SETUP_ID }),
      ).resolves.toEqual({})
    } finally {
      fixture.close()
    }
  })

  it('rejects the setup method while no provider resolves', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('modelOptions', UNAUTHENTICATED_CATALOG)
      await expect(
        fixture.client.request(acp.methods.agent.authenticate, { methodId: AUTH_METHOD_SETUP_ID }),
      ).rejects.toThrow(/no usable credentials/)
    } finally {
      fixture.close()
    }
  })

  it('rejects a method that names a provider other than the current one', async () => {
    const fixture = createAcpTestFixture()
    try {
      // openrouter is in the catalog and authenticated, but it is not the
      // provider this Hermes runs on.
      fixture.gateway.setResult('modelOptions', TEST_MODEL_CATALOG)
      await expect(
        fixture.client.request(acp.methods.agent.authenticate, { methodId: 'openrouter' }),
      ).rejects.toThrow(/no usable credentials/)
    } finally {
      fixture.close()
    }
  })

  it('re-reads the catalog on every call rather than reusing the initialize snapshot', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('modelOptions', UNAUTHENTICATED_CATALOG)
      await fixture.client.request(acp.methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: TERMINAL_AUTH_CLIENT,
      })

      // The user came back from the terminal with working credentials.
      fixture.gateway.setResult('modelOptions', TEST_MODEL_CATALOG)
      await expect(
        fixture.client.request(acp.methods.agent.authenticate, { methodId: AUTH_METHOD_SETUP_ID }),
      ).resolves.toEqual({})
    } finally {
      fixture.close()
    }
  })
})
