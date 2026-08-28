/**
 * Hermes gateway version and desktop-contract support gating.
 *
 * The gateway splits its version surface across two carriers with different
 * timing — `desktop_contract` on the lazy skeleton, `version` on the full info —
 * and this module owns both checks. Refusing a request on an unsupported gateway
 * (`refuseWhileUnsupported`) stays in sessionSetup, where SessionRecord lives.
 */

import { RequestError } from '@agentclientprotocol/sdk'

import {
  ENV_SKIP_VERSION_CHECK,
  SUPPORTED_DESKTOP_CONTRACT,
  SUPPORTED_HERMES_MIN,
} from '../constants.js'
import { versionCheckSkipped } from '../gateway/options.js'
import type { LazySessionInfo } from '../gateway/types.js'

// ── Constants ───────────────────────────────────────────────────────────────

const VERSION_PART_COUNT = 3

/** Versions already reported on stderr. `session.info` is re-emitted on every
 * model and approval-policy change, so without this the same warning would
 * repeat for the life of the session. */
const warnedGatewayVersions = new Set<string>()

// ── Version checks ──────────────────────────────────────────────────────────

function warnAboutGatewayVersion(version: string, message: string): void {
  if (warnedGatewayVersions.has(version)) {
    return
  }
  warnedGatewayVersions.add(version)
  console.error(`[hermes-acp] ${message}`)
}

function parseVersion(raw: string): readonly number[] | null {
  const parts = raw.trim().split('.')
  if (parts.length !== VERSION_PART_COUNT) {
    return null
  }
  const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : Number.NaN))
  return numbers.some((value) => Number.isNaN(value)) ? null : numbers
}

/** Numeric `major.minor.patch` ordering, or null when either side is not a
 * version (string comparison would put "0.20.10" before "0.20.4"). */
function compareVersions(left: string, right: string): number | null {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  if (leftParts === null || rightParts === null) {
    return null
  }
  for (let index = 0; index < VERSION_PART_COUNT; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

/**
 * Why the Hermes build behind a session info snapshot is unsupported, or null
 * when it is fine (or unverifiable, or the operator disarmed the check).
 *
 * One helper for both channels, because the gateway splits the version surface
 * across two carriers with different timing: `desktop_contract` rides the lazy
 * skeleton and so can fail an open request synchronously, while `version`
 * arrives only on the full info — for a fresh session, the deferred agent
 * build's `session.info` event, long after `session/new` answered. Callers
 * decide what to do with the reason; this function only ever warns.
 *
 * Only a floor is enforced: an older Hermes is missing methods this adapter
 * calls, while a newer one is untested rather than known-broken (see the
 * constants for why there is no upper bound). An empty or unparseable version
 * is "not reported" — upstream seeds the field empty and swallows a failed
 * version import (server.py ~5770) — so it warns and leaves the contract check
 * as the only gate.
 */
export function checkGatewayCompatibility(info: LazySessionInfo | undefined): string | null {
  if (info === undefined || versionCheckSkipped(process.env)) {
    return null
  }

  // A floor, not an equality: the contract counts capabilities the backend
  // guarantees, so a HIGHER one still provides everything this adapter uses
  // (upstream's own desktop client gates the same way, `(contract ?? 0) >=
  // REQUIRED_BACKEND_CONTRACT`).
  const contract = info.desktop_contract
  if (contract !== undefined && contract < SUPPORTED_DESKTOP_CONTRACT) {
    return `the gateway reports desktop_contract ${contract}, below the ${SUPPORTED_DESKTOP_CONTRACT} this adapter requires (Hermes ${SUPPORTED_HERMES_MIN}); set ${ENV_SKIP_VERSION_CHECK}=1 to run against it anyway`
  }

  const version = info.version
  if (version === undefined) {
    // The lazy skeleton carries no version at all; the contract check above is
    // the whole gate until the full info arrives.
    return null
  }
  if (version === '') {
    warnAboutGatewayVersion(
      version,
      `the gateway reports no Hermes version (its version import failed); only its desktop_contract (${contract ?? 'not reported'}) could be checked`,
    )
    return null
  }

  const belowMinimum = compareVersions(version, SUPPORTED_HERMES_MIN)
  if (belowMinimum === null) {
    warnAboutGatewayVersion(
      version,
      `the gateway reports an unparseable Hermes version ${JSON.stringify(version)}; only its desktop_contract (${contract ?? 'not reported'}) could be checked`,
    )
    return null
  }
  if (belowMinimum < 0) {
    return `the gateway runs Hermes ${version}, older than the supported ${SUPPORTED_HERMES_MIN}; set ${ENV_SKIP_VERSION_CHECK}=1 to run against it anyway`
  }
  return null
}

/** The failure any refusal takes when its gateway is out of range.
 * internalError, not invalidParams or invalidRequest: nothing about the
 * request is wrong — the backend is. */
export function unsupportedGatewayError(acpMethod: string, reason: string): RequestError {
  return RequestError.internalError(
    undefined,
    `ACP ${acpMethod}: the Hermes gateway is not supported by this adapter: ${reason}`,
  )
}
