/**
 * ACP auth advertisement, mirroring `acp_adapter/auth.py`.
 *
 * No credential ever crosses ACP. Hermes resolves provider credentials from
 * its own environment and config; the two methods advertised here are
 * statements about that state, and `authenticate` is a validation no-op that
 * re-reads it:
 *
 *   - a provider method, advertised only while Hermes has usable credentials
 *     for the provider it is currently configured to run on. Accepting it is
 *     the client's way of confirming the agent is already usable.
 *   - a terminal setup method, always available, which re-runs this adapter's
 *     own binary with `--setup` so the user can create credentials. ACP's
 *     terminal auth carries no command of its own — the client reproduces the
 *     agent invocation it already has and appends these args — which is why
 *     the flag has to be implemented in src/index.ts.
 *
 * Upstream resolves the provider in-process; this adapter is a separate
 * process from Hermes, so the gateway's `model.options` catalog stands in.
 * Its provider rows carry `is_current` and `authenticated`, which is enough:
 * under the flags this adapter passes, a current provider with no usable
 * credential is left out of `providers` entirely, so no row claims to be
 * current. `authenticated` is still checked because `include_unconfigured`
 * catalogs (and any future caller that asks for one) do carry such a row, and
 * a row that says it is not authenticated must never be advertised.
 */

import type { AuthMethod, ClientCapabilities } from '@agentclientprotocol/sdk'

import {
  AUTH_METHOD_PROVIDER_NAME_SUFFIX,
  AUTH_METHOD_SETUP_DESCRIPTION,
  AUTH_METHOD_SETUP_ID,
  AUTH_METHOD_SETUP_NAME,
  AUTH_SETUP_FLAG,
} from './constants.js'
import type { ModelOptionsResult } from './gateway/types.js'

/**
 * Whether the client can run this adapter's terminal `--setup` auth method.
 */
export function clientSupportsTerminalAuth(capabilities: ClientCapabilities | null): boolean {
  return capabilities?.auth?.terminal === true
}

/**
 * The slug of the provider Hermes is configured to run on AND has usable
 * credentials for, or null.
 *
 * `authenticated` upstream is row provenance rather than a live credential
 * check (`_apply_picker_hints` in hermes_cli/inventory.py): it is false
 * exactly for skeleton rows and for the `configured-current` row synthesized
 * when the current provider's key is missing. Both mean the same thing here —
 * a provider Hermes cannot actually call — which is the distinction this
 * needs.
 */
export function authenticatedProviderSlug(catalog: ModelOptionsResult): string | null {
  const current = (catalog.providers ?? []).find((provider) => provider.is_current === true)
  if (current === undefined || current.authenticated !== true || current.slug === '') {
    return null
  }
  return current.slug.toLowerCase()
}

/**
 * The auth methods to advertise at `initialize`.
 *
 * The terminal method is capability-gated: ACP requires the client to opt in
 * via `auth.terminal` before an agent may offer one, since only a client that
 * can reproduce the agent invocation in a real terminal can run it.
 *
 * A null catalog means the `model.options` read failed. The result is the
 * terminal method alone, which is honest and useful: an adapter that cannot
 * read its own provider state has no business claiming a provider is
 * authenticated, and interactive setup is the right thing to offer when the
 * credential state is broken or unknown.
 */
export function buildAuthMethods(
  catalog: ModelOptionsResult | null,
  clientCapabilities: ClientCapabilities | null,
): AuthMethod[] {
  const methods: AuthMethod[] = []

  const slug = catalog === null ? null : authenticatedProviderSlug(catalog)
  if (slug !== null) {
    // No `type` field: the agent variant is the one without a discriminant.
    methods.push({
      id: slug,
      name: `${slug} ${AUTH_METHOD_PROVIDER_NAME_SUFFIX}`,
      description: `Authenticate Hermes using the ${slug} runtime credentials it is already configured with.`,
    })
  }

  if (clientSupportsTerminalAuth(clientCapabilities)) {
    methods.push({
      type: 'terminal',
      id: AUTH_METHOD_SETUP_ID,
      name: AUTH_METHOD_SETUP_NAME,
      description: AUTH_METHOD_SETUP_DESCRIPTION,
      args: [AUTH_SETUP_FLAG],
    })
  }

  return methods
}

/**
 * Whether an `authenticate` call for `methodId` succeeds, given a freshly read
 * catalog.
 *
 * Upstream's semantics exactly: the setup method succeeds once any provider
 * resolves (the user came back from the terminal with working credentials),
 * and a provider method succeeds only while it names the provider that
 * currently resolves. Nothing is authenticated here — the call reports on
 * state Hermes established on its own.
 */
export function authenticationSucceeds(methodId: string, catalog: ModelOptionsResult): boolean {
  const slug = authenticatedProviderSlug(catalog)
  if (slug === null) {
    return false
  }
  const normalized = methodId.trim().toLowerCase()
  return normalized === AUTH_METHOD_SETUP_ID || normalized === slug
}
