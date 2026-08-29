import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ENV_DASHBOARD_SESSION_TOKEN, ENV_GATEWAY_MODE, ENV_HERMES_BIN, ENV_SESSION_TOKEN } from '../constants.js'
import { expandHome, gatewayOptionsFromEnv, parseEnvMilliseconds } from '../gateway/options.js'

describe('gatewayOptionsFromEnv', () => {
  it('defaults to serve mode with no overrides', () => {
    const options = gatewayOptionsFromEnv({})
    expect(options.mode).toBe('serve')
    expect(options.gatewayUrl).toBeUndefined()
  })

  it('selects attach mode with a URL and rejects a URL in other modes', () => {
    const attach = gatewayOptionsFromEnv({
      [ENV_GATEWAY_MODE]: 'attach',
      HERMES_ACP_GATEWAY_URL: 'ws://127.0.0.1:9119/api/ws',
    })
    expect(attach.mode).toBe('attach')
    expect(attach.gatewayUrl).toBe('ws://127.0.0.1:9119/api/ws')

    expect(() =>
      gatewayOptionsFromEnv({
        [ENV_GATEWAY_MODE]: 'serve',
        HERMES_ACP_GATEWAY_URL: 'ws://127.0.0.1:9119/api/ws',
      }),
    ).toThrow(/HERMES_ACP_GATEWAY_URL only applies when HERMES_ACP_MODE=attach/)
  })

  it('requires a URL for attach mode', () => {
    expect(() => gatewayOptionsFromEnv({ [ENV_GATEWAY_MODE]: 'attach' })).toThrow(
      /HERMES_ACP_GATEWAY_URL is required when HERMES_ACP_MODE=attach/,
    )
  })

  it('rejects contradictory mode options', () => {
    expect(() =>
      gatewayOptionsFromEnv({
        [ENV_GATEWAY_MODE]: 'attach',
        HERMES_ACP_GATEWAY_URL: 'ws://127.0.0.1:9119/api/ws',
        [ENV_HERMES_BIN]: '/usr/local/bin/hermes',
      }),
    ).toThrow(/HERMES_ACP_HERMES_BIN only applies when HERMES_ACP_MODE=serve/)
  })

  it('prefers the adapter-owned session token over the ambient Hermes one', () => {
    expect(gatewayOptionsFromEnv({ [ENV_DASHBOARD_SESSION_TOKEN]: 'ambient-token' }).sessionToken).toBe('ambient-token')
    expect(
      gatewayOptionsFromEnv({ [ENV_SESSION_TOKEN]: 'own-token', [ENV_DASHBOARD_SESSION_TOKEN]: 'ambient-token' }).sessionToken,
    ).toBe('own-token')
  })

  it('rejects invalid modes and non-positive timeouts', () => {
    expect(() => gatewayOptionsFromEnv({ [ENV_GATEWAY_MODE]: 'carrier-pigeon' })).toThrow(
      /HERMES_ACP_MODE must be one of serve\|attach/,
    )
    expect(() => gatewayOptionsFromEnv({ HERMES_ACP_STARTUP_TIMEOUT_MS: '0' })).toThrow(
      /HERMES_ACP_STARTUP_TIMEOUT_MS must be a positive integer/,
    )
    expect(() => gatewayOptionsFromEnv({ HERMES_ACP_RPC_TIMEOUT_MS: 'soon' })).toThrow(
      /HERMES_ACP_RPC_TIMEOUT_MS must be a positive integer/,
    )
  })
})

describe('expandHome', () => {
  it('expands ~ and ~/ paths using homedir() and leaves absolute paths alone', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/.hermes/hermes-agent')).toBe(resolve(homedir(), '.hermes/hermes-agent'))
    expect(expandHome('~/custom/path')).toBe(resolve(homedir(), 'custom/path'))
    expect(expandHome('/absolute/path')).toBe('/absolute/path')
  })
})

describe('parseEnvMilliseconds', () => {
  it('parses valid positive integer milliseconds', () => {
    expect(parseEnvMilliseconds('TEST_MS', '5000', 1000)).toBe(5000)
    expect(parseEnvMilliseconds('TEST_MS', undefined, 1000)).toBe(1000)
    expect(parseEnvMilliseconds('TEST_MS', '   ', 1000)).toBe(1000)
    expect(parseEnvMilliseconds('TEST_MS', ' 2500 ', 1000)).toBe(2500)
  })

  it('strictly rejects trailing garbage, floats, and non-positive numbers', () => {
    expect(() => parseEnvMilliseconds('TEST_MS', '5s', 1000)).toThrow(/must be a positive integer/)
    expect(() => parseEnvMilliseconds('TEST_MS', '5.5', 1000)).toThrow(/must be a positive integer/)
    expect(() => parseEnvMilliseconds('TEST_MS', '-5', 1000)).toThrow(/must be a positive integer/)
    expect(() => parseEnvMilliseconds('TEST_MS', '0', 1000)).toThrow(/must be a positive integer/)
    expect(() => parseEnvMilliseconds('TEST_MS', 'abc', 1000)).toThrow(/must be a positive integer/)
  })

  it('rejects values above the 32-bit timer bound Node would clamp to 1ms', () => {
    expect(parseEnvMilliseconds('TEST_MS', '2147483647', 1000)).toBe(2_147_483_647)
    expect(() => parseEnvMilliseconds('TEST_MS', '2147483648', 1000)).toThrow(/must be at most 2147483647ms/)
    expect(() => parseEnvMilliseconds('TEST_MS', '99999999999999', 1000)).toThrow(/must be at most 2147483647ms/)
  })
})
