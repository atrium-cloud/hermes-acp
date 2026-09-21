/**
 * Pure builders for the session's ACP `configOptions` and `modes`, plus the
 * translation back into the gateway's `config.set` vocabulary.
 *
 * Everything here is a total function of (catalog, session info) — the
 * change-detection state that decides whether a `config_option_update` or
 * `current_mode_update` is worth sending lives on the session record in
 * HermesAcpServer, the same split `mappers.ts` and TurnHandler use.
 *
 * Wire semantics these mappings are pinned to (Hermes 0.21.3, docs/refs.md):
 *   - `config.set {key: "model", value: "<model> --provider <slug>"}` is the
 *     only model switch. There is no `provider` key: the provider rides in the
 *     value's flags (`parse_model_switch_args`, server.py ~11990), which is why
 *     a value id has to carry both halves and reverse cleanly.
 *   - `config.set {key: "yolo", value: "on"|"off", scope: "session"}` toggles
 *     only this session's approval bypass and re-emits `session.info`
 *     (server.py ~12234).
 *   - `config.set {key: "approval_mode", value: "manual"|"smart"|"off"}` writes
 *     config.yaml and re-emits `session.info` to EVERY live session
 *     (server.py ~12218) — global, and labelled as such.
 */

import type {
  CreateElicitationRequest,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionMode,
  SessionModeState,
} from '@agentclientprotocol/sdk'

import {
  APPROVAL_MODE_MANUAL,
  APPROVAL_MODE_NAMES,
  APPROVAL_MODE_OFF,
  APPROVAL_MODE_SMART,
  CONFIG_KEY_APPROVAL_MODE,
  CONFIG_KEY_MODEL,
  CONFIG_KEY_YOLO,
  CONFIG_OPTION_APPROVAL_MODE,
  CONFIG_OPTION_APPROVAL_MODE_NAME,
  CONFIG_OPTION_MODEL,
  CONFIG_OPTION_MODEL_CATEGORY,
  CONFIG_OPTION_MODEL_NAME,
  CONFIG_SCOPE_SESSION,
  CONFIG_VALUE_OFF,
  CONFIG_VALUE_ON,
  MODEL_CONFIRM_FIELD,
  MODEL_CONFIRM_NO,
  MODEL_CONFIRM_YES,
  MODEL_PROVIDER_FLAG,
  MODEL_VALUE_SEPARATOR,
  PROVIDER_ENTRY_SEPARATOR,
  PROVIDER_SLUG_CUSTOM,
  SESSION_MODE_DEFAULT,
  SESSION_MODE_DEFAULT_NAME,
  SESSION_MODE_DONT_ASK,
  SESSION_MODE_DONT_ASK_NAME,
} from '../constants.js'
import type { ConfigSetParams, ModelOptionsResult, SessionInfo } from '../gateway/types.js'

/** Group a synthesized current model lands in when its provider is unknown. */
const UNGROUPED_PROVIDER_ID = 'current'
const UNGROUPED_PROVIDER_NAME = 'Current'

// ── Derived session settings ────────────────────────────────────────────────

/**
 * Everything the ACP mode/config surface is derived from, reduced to the three
 * values that can change. The session record keeps this instead of the raw
 * `SessionInfo` so a `session.info` event can be compared against what the
 * client was last told, and only a real transition emits an update.
 */
export interface SessionSettings {
  /** `"<provider>/<model>"`, or `""` while the gateway reports no model yet. */
  readonly modelValueId: string
  readonly approvalMode: string
  readonly modeId: string
}

export function settingsFromInfo(info: SessionInfo): SessionSettings {
  return {
    modelValueId: info.model === '' ? '' : modelValueId(info.provider, info.model),
    approvalMode: normalizeApprovalMode(info.approval_mode),
    modeId: modeFromInfo(info),
  }
}

/**
 * Settings for a session that has no agent yet, so no `session.info` to read:
 * the model comes from the catalog and the approval mode from `config.get`.
 *
 * The mode is derived from the global approval policy alone, because those are
 * the only two bypass sources a brand-new session can have — nothing has
 * enabled its per-session flag yet. The third (`_YOLO_MODE_FROZEN`, a gateway
 * started with `--yolo`) is invisible to both calls and is corrected by the
 * first `session.info`.
 */
export function settingsFromConfig(model: string, provider: string, approvalMode: string): SessionSettings {
  const mode = normalizeApprovalMode(approvalMode)
  return {
    modelValueId: model === '' ? '' : modelValueId(provider, model),
    approvalMode: mode,
    modeId: mode === APPROVAL_MODE_OFF ? SESSION_MODE_DONT_ASK : SESSION_MODE_DEFAULT,
  }
}

// ── Model value ids ─────────────────────────────────────────────────────────

/**
 * `"<provider-slug>/<model>"`, or the bare model when the gateway reports no
 * provider (a deferred mid-turn pick made without an explicit `--provider`
 * carries an empty `display_provider`).
 */
export function modelValueId(provider: string, model: string): string {
  // Lowercased because the two sides of the comparison come from different
  // places: catalog rows carry normalized slugs, while `session.info` and
  // `model.options`' top-level `provider` report config.yaml's value verbatim.
  // A `provider: OpenRouter` in config would otherwise leave the current value
  // matching no option and synthesize a duplicate group. Upstream resolves
  // provider names case-insensitively, so the lowercased slug is also what the
  // value reverses into on the way back to `config.set`.
  const slug = normalizeProviderSlug(provider)
  return slug === '' ? model : `${slug}${MODEL_VALUE_SEPARATOR}${model}`
}

/**
 * The provider slug a value id is spelled with.
 *
 * The custom lane has two spellings upstream: `model.options` advertises the
 * whole lane as the bare slug `custom`, while a session configured against a
 * named `providers:` entry reports the qualified reference (`custom:<entry>`)
 * in `session.info.provider`. Both name the same lane, so the entry qualifier
 * is dropped and the catalog's own spelling wins — otherwise a value derived
 * from session info would match no advertised option and a re-set of the model
 * already selected would look like a change. `config.set` resolves the bare
 * lane back to the configured entry, which is what makes the reverse direction
 * work — observed live on Hermes 0.20.6 (docs/refs.md), not read out of a
 * server.py branch the way the rest of this file's wire notes are.
 *
 * The qualifier is dropped only for this lane. Any other colon-carrying
 * reference is left verbatim, so it still matches a catalog row spelled the
 * same way, and falls through to the synthesized group when it matches none.
 *
 * Distinct entries of the custom lane are not distinguishable in a value id.
 * Neither are they in the catalog, which advertises the lane once.
 */
function normalizeProviderSlug(provider: string): string {
  const slug = provider.trim().toLowerCase()
  return slug.startsWith(`${PROVIDER_SLUG_CUSTOM}${PROVIDER_ENTRY_SEPARATOR}`) ? PROVIDER_SLUG_CUSTOM : slug
}

export interface ModelSelection {
  readonly provider: string
  readonly model: string
}

/**
 * Split on the FIRST separator only: model ids carry slashes of their own
 * (`openrouter/nousresearch/hermes-4-70b`), so only the leading segment is
 * the provider slug.
 */
export function parseModelValueId(valueId: string): ModelSelection {
  const separator = valueId.indexOf(MODEL_VALUE_SEPARATOR)
  if (separator < 0) {
    return { provider: '', model: valueId }
  }
  // Normalized on the way out too, so a value id that reached the adapter in
  // some other spelling than the one it advertises — a client echoing back
  // what an older build reported — still names the lane the switch has to go
  // to, and still matches the catalog group it belongs in.
  return { provider: normalizeProviderSlug(valueId.slice(0, separator)), model: valueId.slice(separator + 1) }
}

/** A value id in the one spelling the option advertises it under. */
export function canonicalModelValueId(valueId: string): string {
  const selection = parseModelValueId(valueId)
  return modelValueId(selection.provider, selection.model)
}

/** The `config.set` params a model value id reverses into. */
export function modelSwitchParams(sessionId: string, valueId: string, confirmExpensive: boolean): ConfigSetParams {
  const selection = parseModelValueId(valueId)
  const value =
    selection.provider === ''
      ? selection.model
      : `${selection.model} ${MODEL_PROVIDER_FLAG} ${selection.provider}`
  return {
    key: CONFIG_KEY_MODEL,
    value,
    session_id: sessionId,
    ...(confirmExpensive ? { confirm_expensive_model: true } : {}),
  }
}

// ── Session modes ───────────────────────────────────────────────────────────

export const SESSION_MODES: readonly SessionMode[] = [
  { id: SESSION_MODE_DEFAULT, name: SESSION_MODE_DEFAULT_NAME },
  { id: SESSION_MODE_DONT_ASK, name: SESSION_MODE_DONT_ASK_NAME },
]

/**
 * The effective mode, which is exactly the gateway's effective bypass state:
 * `info.yolo` already ORs the frozen `--yolo` env, the global
 * `approvals.mode: off`, and the per-session flag (server.py `_session_info`).
 * Deriving the mode from the per-session flag alone would report "Default"
 * while every command was in fact auto-approved.
 */
export function modeFromInfo(info: SessionInfo): string {
  return info.yolo ? SESSION_MODE_DONT_ASK : SESSION_MODE_DEFAULT
}

export function sessionModeState(settings: SessionSettings): SessionModeState {
  return { currentModeId: settings.modeId, availableModes: [...SESSION_MODES] }
}

export function isKnownModeId(modeId: string): boolean {
  return SESSION_MODES.some((mode) => mode.id === modeId)
}

/** The `config.set` params a mode id reverses into. */
export function modeSwitchParams(sessionId: string, modeId: string): ConfigSetParams {
  return {
    key: CONFIG_KEY_YOLO,
    value: modeId === SESSION_MODE_DONT_ASK ? CONFIG_VALUE_ON : CONFIG_VALUE_OFF,
    scope: CONFIG_SCOPE_SESSION,
    session_id: sessionId,
  }
}

// ── Config options ──────────────────────────────────────────────────────────

export const APPROVAL_MODE_VALUES: readonly string[] = [APPROVAL_MODE_MANUAL, APPROVAL_MODE_SMART, APPROVAL_MODE_OFF]

/** Upstream's own floor: `_get_approval_mode` falls back to "manual" for any
 * value outside the set, so an unrecognized one is reported the same way. */
export function normalizeApprovalMode(value: string): string {
  return APPROVAL_MODE_VALUES.includes(value) ? value : APPROVAL_MODE_MANUAL
}

/** The `config.set` params an approval-mode value id reverses into. */
export function approvalModeSwitchParams(valueId: string): ConfigSetParams {
  // No session_id: this key writes config.yaml and applies to every session.
  return { key: CONFIG_KEY_APPROVAL_MODE, value: valueId }
}

function modelGroups(catalog: ModelOptionsResult, currentValueId: string): SessionConfigSelectGroup[] {
  const groups: SessionConfigSelectGroup[] = []
  const optionsBySlug = new Map<string, SessionConfigSelectOption[]>()

  for (const provider of catalog.providers ?? []) {
    const models = provider.models ?? []
    if (models.length === 0) {
      continue
    }
    const options = models.map((model) => ({ value: modelValueId(provider.slug, model), name: model }))
    // Keyed the way the option values are spelled, so the append-below finds
    // the group whose options a synthesized entry would sit among.
    optionsBySlug.set(normalizeProviderSlug(provider.slug), options)
    groups.push({ group: provider.slug, name: provider.name, options })
  }

  // Nothing is selected yet (no model configured anywhere), so there is nothing
  // to synthesize — an option with an empty value and label would be a
  // selectable entry that means nothing.
  if (currentValueId === '') {
    return groups
  }
  if (groups.some((group) => group.options.some((option) => option.value === currentValueId))) {
    return groups
  }

  // The session's own model is not always in the catalog: a custom endpoint, a
  // provider row truncated to its featured models, or a deferred pick the
  // gateway reports before the switch lands. A select whose currentValue names
  // no option is malformed, so the live model is added rather than dropped.
  const selection = parseModelValueId(currentValueId)
  const existing = optionsBySlug.get(selection.provider)
  const option: SessionConfigSelectOption = { value: currentValueId, name: selection.model }
  if (existing) {
    existing.push(option)
    return groups
  }
  return [
    {
      group: selection.provider === '' ? UNGROUPED_PROVIDER_ID : selection.provider,
      name: selection.provider === '' ? UNGROUPED_PROVIDER_NAME : selection.provider,
      options: [option],
    },
    ...groups,
  ]
}

/**
 * The session's `configOptions`: the model select built from the gateway's
 * provider catalog, and the global approval mode.
 *
 * The catalog is a snapshot taken at `session/new` — `model.options` probes
 * provider endpoints, so it is never called from the event path; only the
 * current value moves as `session.info` arrives.
 */
export function buildConfigOptions(catalog: ModelOptionsResult, settings: SessionSettings): SessionConfigOption[] {
  return [
    {
      id: CONFIG_OPTION_MODEL,
      name: CONFIG_OPTION_MODEL_NAME,
      category: CONFIG_OPTION_MODEL_CATEGORY,
      type: 'select',
      currentValue: settings.modelValueId,
      options: modelGroups(catalog, settings.modelValueId),
    },
    {
      id: CONFIG_OPTION_APPROVAL_MODE,
      name: CONFIG_OPTION_APPROVAL_MODE_NAME,
      type: 'select',
      currentValue: settings.approvalMode,
      options: APPROVAL_MODE_VALUES.map((value) => ({ value, name: APPROVAL_MODE_NAMES[value] ?? value })),
    },
  ]
}

// ── Expensive-model confirmation ────────────────────────────────────────────

/**
 * The gateway's expensive-model gate as a yes/no elicitation. `confirm_message`
 * is relayed verbatim: it is the only description of the cost the user is being
 * asked to accept, and this adapter never confirms on their behalf.
 */
export function modelConfirmElicitation(sessionId: string, confirmMessage: string): CreateElicitationRequest {
  return {
    sessionId,
    mode: 'form',
    message: confirmMessage,
    requestedSchema: {
      type: 'object',
      properties: {
        [MODEL_CONFIRM_FIELD]: {
          type: 'string',
          title: confirmMessage,
          enum: [MODEL_CONFIRM_YES, MODEL_CONFIRM_NO],
        },
      },
      required: [MODEL_CONFIRM_FIELD],
    },
  }
}

/** Only an explicit "yes" confirms; every other value is a refusal. */
export function isModelConfirmed(value: unknown): boolean {
  return value === MODEL_CONFIRM_YES
}
