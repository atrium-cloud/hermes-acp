/**
 * Pure builders for the two client round-trips a Hermes turn can demand: the
 * `approval` server request → ACP `session/request_permission`, and the
 * `clarify` server request → ACP elicitation.
 *
 * Everything here is a total function of its input, like `mappers.ts`. The
 * round-trip state — which requests are still unanswered, which tool call an
 * approval belongs to, whether the turn ended first — lives on TurnHandler.
 *
 * Wire semantics both mappings are pinned to (Hermes 0.21.3, see docs/refs.md):
 *   - the `approval` response's `choice` is relayed verbatim to
 *     `resolve_gateway_approval` (tools/approval.py), and the approval gate
 *     blocks only on the literal "deny": every other resolved choice approves
 *     the action. An option whose choice string this adapter does not recognize
 *     is therefore dropped rather than offered — relaying it back would read as
 *     consent.
 *   - `clarify` takes one free-text `answer` per question (the response for a
 *     single question, `clarify.lock` per question of a batch), so every
 *     question maps to a one-field elicitation form.
 */

import type {
  ClientCapabilities,
  CreateElicitationRequest,
  ElicitationPropertySchema,
  PermissionOption,
  PermissionOptionKind,
  SessionUpdate,
} from '@agentclientprotocol/sdk'

import {
  APPROVAL_CHOICE_ALWAYS,
  APPROVAL_CHOICE_DENY,
  APPROVAL_CHOICE_ONCE,
  APPROVAL_CHOICE_SESSION,
  APPROVAL_GATE_TOOL_CALL_PREFIX,
  CLARIFY_ANSWER_FIELD,
  DEFAULT_APPROVAL_CHOICES,
} from '../constants.js'
import type { ApprovalServerRequest } from '../gateway/types.js'

/** The `approval` request's params, minus the routing field. */
export type ApprovalPrompt = ApprovalServerRequest['params']

// ── Client capability probes ────────────────────────────────────────────────

/**
 * Whether the client can render the one-field forms this adapter uses for
 * elicitation (clarify questions, expensive-model confirmation). The SDK nests
 * the capability optionally, so a missing object reads as unsupported.
 */
export function clientSupportsFormElicitation(capabilities: ClientCapabilities | null): boolean {
  return capabilities?.elicitation?.form != null
}

// ── Approvals ───────────────────────────────────────────────────────────────

/** How each gateway choice string is presented to the ACP client. */
const APPROVAL_OPTION_BY_CHOICE: Readonly<Record<string, { readonly name: string; readonly kind: PermissionOptionKind }>> = {
  [APPROVAL_CHOICE_ONCE]: { name: 'Allow once', kind: 'allow_once' },
  // Both persistent scopes map to `allow_always`: ACP has no third kind, and
  // ACP's own reference adapters treat a session-scoped grant the same way.
  [APPROVAL_CHOICE_SESSION]: { name: 'Allow for this session', kind: 'allow_always' },
  [APPROVAL_CHOICE_ALWAYS]: { name: 'Allow and remember', kind: 'allow_always' },
  [APPROVAL_CHOICE_DENY]: { name: 'Deny', kind: 'reject_once' },
}

export interface ApprovalOptions {
  readonly options: readonly PermissionOption[]
  /** Choices the gateway offered that have no ACP presentation, for logging. */
  readonly unknownChoices: readonly string[]
}

/**
 * Build the ACP permission options for a gateway approval.
 *
 * The option ids are the gateway choice strings themselves, so the selected
 * option needs no translation table on the way back into the response.
 */
export function approvalOptions(payload: ApprovalPrompt): ApprovalOptions {
  const offered = payload.choices !== undefined && payload.choices.length > 0 ? payload.choices : DEFAULT_APPROVAL_CHOICES

  const options: PermissionOption[] = []
  const unknownChoices: string[] = []
  for (const choice of offered) {
    // `allow_permanent: false` means Hermes will not persist a grant past this
    // session; the gateway already omits "always" then, and this is the guard
    // for an emit site that does not.
    if (choice === APPROVAL_CHOICE_ALWAYS && payload.allow_permanent === false) {
      continue
    }
    if (!Object.hasOwn(APPROVAL_OPTION_BY_CHOICE, choice)) {
      unknownChoices.push(choice)
      continue
    }
    const presentation = APPROVAL_OPTION_BY_CHOICE[choice]!
    options.push({ optionId: choice, name: presentation.name, kind: presentation.kind })
  }

  return { options, unknownChoices }
}

/** Deterministic id for the gate row opened when nothing is in flight. */
export function approvalGateToolCallId(requestId: string): string {
  return `${APPROVAL_GATE_TOOL_CALL_PREFIX}${requestId}`
}

/**
 * The tool call an approval is attached to when no gateway tool call is in
 * flight. It stands for the approval gate itself, not for a Hermes tool: the
 * gateway's approval payload carries no tool id, and inventing one for a tool
 * the client never saw start is exactly the dangling-id defect this adapter
 * exists to fix.
 */
export function approvalGateToolCall(payload: ApprovalPrompt, toolCallId: string): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId,
    title: payload.description !== '' ? payload.description : payload.command,
    kind: 'execute',
    status: 'pending',
    content: [{ type: 'content', content: { type: 'text', text: payload.command } }],
  }
}

/** Closes the gate row: an approval that was answered is a gate that ran. */
export function approvalGateResolved(toolCallId: string, allowed: boolean): SessionUpdate {
  return { sessionUpdate: 'tool_call_update', toolCallId, status: allowed ? 'completed' : 'failed' }
}

// ── Clarify ─────────────────────────────────────────────────────────────────

export interface ClarifyFormRequest {
  readonly sessionId: string
  readonly question: string
  readonly choices?: readonly string[] | null | undefined
  readonly multiSelect?: boolean
  /** The in-flight `clarify` tool call, when the client has seen one. */
  readonly toolCallId?: string
}

/**
 * One question as a one-field elicitation form.
 *
 * The field is required so a conforming client cannot accept the form without
 * an answer; an accept that carries none anyway is treated as a non-answer by
 * `clarifyAnswer`, never as an empty answer.
 */
export function clarifyElicitation(request: ClarifyFormRequest): CreateElicitationRequest {
  return {
    sessionId: request.sessionId,
    ...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
    mode: 'form',
    message: request.question,
    requestedSchema: {
      type: 'object',
      properties: { [CLARIFY_ANSWER_FIELD]: clarifyProperty(request) },
      required: [CLARIFY_ANSWER_FIELD],
    },
  }
}

function clarifyProperty(request: ClarifyFormRequest): ElicitationPropertySchema {
  const choices = request.choices
  if (choices === undefined || choices === null || choices.length === 0) {
    return { type: 'string', title: request.question }
  }
  if (request.multiSelect === true) {
    return { type: 'array', title: request.question, items: { type: 'string', enum: [...choices] } }
  }
  return { type: 'string', title: request.question, enum: [...choices] }
}

/**
 * The answer string a `clarify` response (or `clarify.lock`) takes, or null
 * when the client accepted the form without filling the field in.
 *
 * A multi-select answer is serialized as a JSON array: Hermes' parser
 * (`tools/clarify_tool.py _parse_multi_select_response`) tries JSON before
 * falling back to splitting on commas, and a choice containing a comma would
 * be torn in two by that fallback.
 */
export function clarifyAnswer(value: unknown): string | null {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && item !== '')
    return items.length > 0 ? JSON.stringify(items) : null
  }
  if (typeof value === 'string') {
    return value !== '' ? value : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}
