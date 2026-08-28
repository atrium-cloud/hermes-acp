/**
 * The env gate for the live-Hermes tier.
 *
 * These suites spawn the BUILT adapter against a real Hermes install and spend
 * real provider tokens, so they never run under the default `bun run test`:
 * every suite here is registered through `describeE2E`, which skips unless
 * `RUN_HERMES_E2E=true` (the `test:e2e` script sets it after a build).
 *
 * Once gated in, a missing provider key is a FAILURE, not another skip — a
 * silent second skip is how an e2e tier rots into never running at all. The
 * throw lives in `requireEnv`, called from inside test bodies rather than at
 * module load, because `describe.skipIf` still evaluates module top level and
 * the describe factory during collection.
 */

import { describe } from 'vitest'

// ── Constants ───────────────────────────────────────────────────────────────

export const ENV_RUN_E2E = 'RUN_HERMES_E2E'
export const RUN_E2E_VALUE = 'true'

/** Provider credential for the pinned live model. Passed to the gateway child
 * through the environment only — never argv, which is world-readable in `ps`. */
// The variable NAME, never a value — the pre-commit secret scan cannot tell
// the difference, hence the marker.
export const ENV_PROVIDER_API_KEY = 'OPENROUTER_API_KEY' // pragma: allowlist secret

/** The live model these suites pin, per the repo testing rule (.rules): a
 * cheap, current model, selected through the adapter's OWN `configOptions`
 * model switch rather than by writing Hermes config behind its back. */
export const E2E_PROVIDER_SLUG = 'openrouter'
export const E2E_MODEL_ID = 'deepseek/deepseek-v4-flash-0731'
export const E2E_MODEL_VALUE_ID = `${E2E_PROVIDER_SLUG}/${E2E_MODEL_ID}`
/** The mid-session switch target: pinned, never picked from the catalog —
 * whatever sorts first there may be refused by the account's provider policy. */
export const E2E_SWITCH_MODEL_ID = 'z-ai/glm-5.3-flash'
export const E2E_SWITCH_MODEL_VALUE_ID = `${E2E_PROVIDER_SLUG}/${E2E_SWITCH_MODEL_ID}`

/** A live turn covers process spawn, Hermes boot, and a provider round-trip. */
export const E2E_TURN_TIMEOUT_MS = 180_000
/** Hermes' first boot in a fresh home builds config and probes providers. */
export const E2E_SETUP_TIMEOUT_MS = 240_000
/** Every e2e test boots its own scratch home, so a one-turn test budgets boot
 * plus the turn. */
export const E2E_BOOT_AND_TURN_TIMEOUT_MS = E2E_SETUP_TIMEOUT_MS + E2E_TURN_TIMEOUT_MS

export const RUN_HERMES_E2E = ['true', '1'].includes(process.env[ENV_RUN_E2E]?.trim().toLowerCase() ?? '')

/** `describe` for the live tier: registered always, executed only when gated
 * in, so the default suite reports these as skipped rather than missing. */
export const describeE2E = describe.skipIf(!RUN_HERMES_E2E)

/**
 * A required environment value, or a loud failure naming what to set. Call
 * from inside a test/hook body: at module scope it would break collection for
 * every contributor running the default suite.
 */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(
      `${name} must be set to run the live Hermes e2e tier (${ENV_RUN_E2E}=${RUN_E2E_VALUE}); export it or unset ${ENV_RUN_E2E}`,
    )
  }
  return value
}
