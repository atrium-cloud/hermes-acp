/**
 * Pure gateway-event → ACP-update mappers.
 *
 * Every function here is a total function of its input: no adapter state, no
 * dedup, no ordering. The per-turn state (which tool calls have started, which
 * plan was last sent, whether the turn was cancelled) lives in TurnHandler.
 *
 * The tool-name → ToolKind table and the tool-failure heuristic are ported
 * from Hermes' own ACP adapter (`acp_adapter/tools.py`, pinned Hermes 0.21.3)
 * so both adapters classify the same tool the same way. Every name in the
 * table was re-verified against the tool registry in the pinned snapshot.
 */

import type {
  PlanEntry,
  PlanEntryPriority,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  Usage as AcpUsage,
} from '@agentclientprotocol/sdk'

import {
  HISTORY_REPLAY_TOOL_CALL_PREFIX,
  SESSION_TITLE_MAX_CHARS,
  SKILL_INVOCATION_DISPLAY_KIND,
  TERMINAL_RESULT_ERROR_KEY,
  TERMINAL_RESULT_EXIT_CODE_KEY,
  TERMINAL_RESULT_NOTE_KEY,
  TERMINAL_RESULT_OUTPUT_KEY,
  TERMINAL_TOOL_NAME,
  TERMINAL_WORKDIR_ARG_KEY,
  TOOL_LOCATION_LINE_KEYS,
  TOOL_LOCATION_PATH_KEY,
} from '../constants.js'
import type { ToolCompleteEvent, ToolStartEvent, TodoItem, TranscriptMessage, Usage } from '../gateway/types.js'

// ── Constants ───────────────────────────────────────────────────────────────

/** Ported verbatim from `acp_adapter/tools.py` TOOL_KIND_MAP. */
export const TOOL_KIND_BY_NAME: Readonly<Record<string, ToolKind>> = {
  // File operations
  read_file: 'read',
  write_file: 'edit',
  patch: 'edit',
  search_files: 'search',
  // Terminal / execution
  terminal: 'execute',
  process: 'execute',
  execute_code: 'execute',
  // Session/meta tools
  todo: 'other',
  skill_view: 'read',
  skills_list: 'read',
  skill_manage: 'edit',
  // Web / fetch
  web_search: 'fetch',
  web_extract: 'fetch',
  // Browser
  browser_navigate: 'fetch',
  browser_click: 'execute',
  browser_type: 'execute',
  browser_snapshot: 'read',
  browser_vision: 'read',
  browser_scroll: 'execute',
  browser_press: 'execute',
  browser_back: 'execute',
  browser_get_images: 'read',
  // Agent internals
  delegate_task: 'execute',
  vision_analyze: 'read',
  image_generate: 'execute',
  text_to_speech: 'execute',
  // Thinking / meta
  _thinking: 'think',
}

export const DEFAULT_TOOL_KIND: ToolKind = 'other'

/**
 * Ported from `acp_adapter/tools.py` _POLISHED_TOOLS: first-party tools whose
 * results are structured enough that a bare `{"error": ...}` payload is a real
 * tool-level failure. Unknown/plugin tools stay conservative — see
 * `toolResultFailed`.
 */
const POLISHED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'todo', 'memory', 'session_search', 'delegate_task',
  'read_file', 'write_file', 'patch', 'search_files', 'terminal', 'process', 'execute_code',
  'skill_view', 'skills_list', 'skill_manage', 'web_search', 'web_extract',
  'browser_navigate', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll',
  'browser_back', 'browser_snapshot', 'browser_console', 'browser_get_images', 'browser_vision',
  'vision_analyze', 'image_generate', 'text_to_speech',
  'cronjob', 'send_message', 'clarify', 'discord', 'discord_admin',
  'ha_list_entities', 'ha_get_state', 'ha_list_services', 'ha_call_service',
  'feishu_doc_read', 'feishu_drive_list_comments', 'feishu_drive_list_comment_replies',
  'feishu_drive_reply_comment', 'feishu_drive_add_comment',
  'kanban_create', 'kanban_show', 'kanban_comment', 'kanban_complete',
  'kanban_block', 'kanban_request_review', 'kanban_request_changes',
  'kanban_link', 'kanban_heartbeat',
  'yb_query_group_info', 'yb_query_group_members', 'yb_search_sticker',
  'yb_send_dm', 'yb_send_sticker',
])

/**
 * Prefix Hermes' tool executor wraps around a raised exception. It cannot
 * legitimately appear in well-behaved tool output, so it is a reliable
 * failure marker (`acp_adapter/tools.py` _tool_result_failed).
 */
const TOOL_EXECUTOR_ERROR_PREFIX = "Error executing tool '"

/**
 * Hermes todos carry no priority and ACP requires one on every plan entry.
 * A uniform middle priority is the only honest projection: inventing a
 * high/low split would encode an ordering Hermes never expressed.
 */
const PLAN_ENTRY_PRIORITY: PlanEntryPriority = 'medium'

// ── Content chunks ──────────────────────────────────────────────────────────

export function agentMessageChunk(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
}

export function agentThoughtChunk(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }
}

export function userMessageChunk(text: string): SessionUpdate {
  return { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }
}

// ── Tool calls ──────────────────────────────────────────────────────────────

export function toolKindForName(name: string): ToolKind {
  // Own-property lookup: `TOOL_KIND_BY_NAME["constructor"]` would otherwise
  // return a function where a ToolKind is typed.
  return Object.hasOwn(TOOL_KIND_BY_NAME, name) ? TOOL_KIND_BY_NAME[name]! : DEFAULT_TOOL_KIND
}

/**
 * `context` is the gateway's own 80-char display preview of the invocation
 * (`tui_gateway/server.py` _tool_ctx); the bare tool name is the fallback
 * Hermes' adapter also uses when no preview can be rendered.
 */
export function toolCallTitle(payload: ToolStartEvent['payload']): string {
  return payload.context ?? payload.name
}

/**
 * File locations a call touches, from its arguments — the same `path` plus
 * `offset`/`line` projection as `acp_adapter/tools.py` extract_locations. The
 * arguments are untyped upstream, so each field is checked, not trusted.
 */
export function toolCallLocations(args: Record<string, unknown> | undefined): readonly ToolCallLocation[] {
  const path = args?.[TOOL_LOCATION_PATH_KEY]
  if (typeof path !== 'string' || path === '') {
    return []
  }
  const line = TOOL_LOCATION_LINE_KEYS.map((key) => args?.[key]).find((value) => typeof value === 'number')
  return [typeof line === 'number' ? { path, line } : { path }]
}

/** The optional call-detail fields, present only when the gateway sent arguments. */
function toolCallDetails(args: Record<string, unknown> | undefined): Pick<ToolCallStartFields, 'rawInput' | 'locations'> {
  const locations = toolCallLocations(args)
  return {
    ...(args !== undefined ? { rawInput: args } : {}),
    ...(locations.length > 0 ? { locations: [...locations] } : {}),
  }
}

type ToolCallStartFields = Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>

export function toolCallStart(payload: ToolStartEvent['payload'], sessionCwd: string): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: payload.tool_id,
    title: toolCallTitle(payload),
    name: payload.name,
    kind: toolKindForName(payload.name),
    status: 'in_progress',
    ...toolCallDetails(payload.args),
    ...(payload.name === TERMINAL_TOOL_NAME
      ? { content: terminalContent(payload.tool_id), _meta: terminalInfoMeta(payload.tool_id, payload.args, sessionCwd) }
      : {}),
  }
}

// ── Terminal entries ────────────────────────────────────────────────────────
//
// A `terminal` call is announced as a terminal the client renders itself: a
// `terminal` content item plus the `_meta` keys carrying the terminal's cwd,
// its output, and its exit. See the constants block for why `_meta` rather
// than the `terminal/*` client methods.

/**
 * Where the command ran. Hermes' terminal tool takes an optional `workdir` and
 * otherwise runs in the session's directory, which the gateway never reports
 * per call, so the ACP session cwd is the honest fallback.
 */
function terminalCwd(args: Record<string, unknown> | undefined, sessionCwd: string): string {
  const workdir = args?.[TERMINAL_WORKDIR_ARG_KEY]
  return typeof workdir === 'string' && workdir !== '' ? workdir : sessionCwd
}

function terminalContent(toolId: string): ToolCallContent[] {
  return [{ type: 'terminal', terminalId: toolId }]
}

function terminalInfoMeta(
  toolId: string,
  args: Record<string, unknown> | undefined,
  sessionCwd: string,
): Record<string, unknown> {
  return { terminal_info: { terminal_id: toolId, cwd: terminalCwd(args, sessionCwd) } }
}

/**
 * Output and exit of a finished `terminal` call, read from the result JSON the
 * gateway already decoded (`tools/terminal_tool_result.py`).
 *
 * `exit_code` is absent or null when the command yielded to background, and the
 * whole object is missing when the result did not decode; either way no
 * `terminal_exit` is sent, since an invented code would claim an outcome Hermes
 * never reported. The row's own status still comes from `toolResultFailed`,
 * which reads the same `exit_code`.
 *
 * The row carries no text content of its own, so whatever explains the outcome
 * has to ride the terminal data or be visible nowhere: the failure envelope
 * (`_error_json`: timeout, executor crash, denied command) puts its explanation
 * in `error` next to an empty `output`, a background yield puts its "still
 * running" notice in `note`, and an undecoded result is the executor's
 * exception wrapper as raw text.
 */
function terminalResultMeta(payload: ToolCompleteEvent['payload']): Record<string, unknown> {
  const result = payload.result
  const fields =
    typeof result === 'object' && result !== null && !Array.isArray(result) ? (result as Record<string, unknown>) : undefined
  const exitCode = fields?.[TERMINAL_RESULT_EXIT_CODE_KEY]
  return {
    terminal_output: { terminal_id: payload.tool_id, data: terminalData(fields, result, payload.result_text) },
    ...(typeof exitCode === 'number' && Number.isInteger(exitCode)
      ? { terminal_exit: { terminal_id: payload.tool_id, exit_code: exitCode, signal: null } }
      : {}),
  }
}

function terminalData(fields: Record<string, unknown> | undefined, result: unknown, resultText: string | undefined): string {
  const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '')
  const reported = [stringOf(fields?.[TERMINAL_RESULT_OUTPUT_KEY]), stringOf(fields?.[TERMINAL_RESULT_NOTE_KEY])]
    .filter((text) => text !== '')
    .join('\n')
  if (reported !== '') {
    return reported
  }
  const error = stringOf(fields?.[TERMINAL_RESULT_ERROR_KEY])
  if (error !== '') {
    return error
  }
  return typeof result === 'string' ? result : (resultText ?? '')
}

/**
 * The finished call's fields for a `terminal` call: no text `content`, because
 * the terminal item from the opening `tool_call` is what renders the output,
 * and an `inline_diff` can never apply to a shell command.
 */
function terminalOutcome(
  payload: ToolCompleteEvent['payload'],
): Pick<ToolCallStartFields, 'status' | 'rawOutput' | '_meta'> {
  const status: ToolCallStatus = toolResultFailed(payload) ? 'failed' : 'completed'
  const rawOutput = payload.result ?? payload.result_text
  return {
    status,
    ...(rawOutput !== undefined ? { rawOutput } : {}),
    _meta: terminalResultMeta(payload),
  }
}

/**
 * Ported from `acp_adapter/tools.py` _tool_result_failed. Deliberately
 * conservative: plain text containing the word "error" is not a failure, only
 * a structured failure or the executor's exception wrapper is.
 *
 * The gateway pre-parses the tool result — `payload.result` is the decoded
 * JSON when it decoded, and the raw string when it did not.
 */
export function toolResultFailed(payload: ToolCompleteEvent['payload']): boolean {
  const rawText = typeof payload.result === 'string' ? payload.result : payload.result_text
  if (rawText !== undefined && rawText.startsWith(TOOL_EXECUTOR_ERROR_PREFIX)) {
    return true
  }

  const data = payload.result
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return false
  }
  const fields = data as Record<string, unknown>

  if (fields['success'] === false || fields['ok'] === false) {
    return true
  }

  const exitCode = fields['exit_code'] ?? fields['returncode']
  if (typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode !== 0) {
    return true
  }

  return POLISHED_TOOL_NAMES.has(payload.name) && Boolean(fields['error']) && !fields['content']
}

/**
 * Content for a finished tool call.
 *
 * `inline_diff` is the gateway's *rendered* edit diff (display text produced by
 * `agent/display.render_edit_diff_with_delta`), not a unified diff and not a
 * before/after pair. ACP's `diff` content block requires a path and the full
 * new file text, neither of which the rendered form carries, so it ships as
 * text rather than as a fabricated diff block.
 */
export function toolCallContent(payload: ToolCompleteEvent['payload']): readonly ToolCallContent[] {
  const content: ToolCallContent[] = []
  const resultText = payload.result_text ?? payload.summary
  if (resultText !== undefined && resultText !== '') {
    content.push({ type: 'content', content: { type: 'text', text: resultText } })
  }
  if (payload.inline_diff !== undefined && payload.inline_diff !== '') {
    content.push({ type: 'content', content: { type: 'text', text: payload.inline_diff } })
  }
  return content
}

/** The finished call's status and output fields, shared by both completion shapes. */
function toolCallOutcome(payload: ToolCompleteEvent['payload']): Pick<ToolCallStartFields, 'status' | 'content' | 'rawOutput'> {
  const status: ToolCallStatus = toolResultFailed(payload) ? 'failed' : 'completed'
  const content = toolCallContent(payload)
  // `result` is the gateway's decoded JSON (or the raw string when it did not
  // decode); `result_text` is the only output some tools report.
  const rawOutput = payload.result ?? payload.result_text
  return {
    status,
    ...(content.length > 0 ? { content: [...content] } : {}),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
  }
}

export function toolCallComplete(payload: ToolCompleteEvent['payload']): SessionUpdate {
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: payload.tool_id,
    ...(payload.name === TERMINAL_TOOL_NAME ? terminalOutcome(payload) : toolCallOutcome(payload)),
  }
}

/**
 * A whole tool call from its completion alone. The gateway gates `tool.start`
 * on tool progress but always emits the completion of an edit that rendered a
 * diff (server.py `_tool_lifecycle_required_for_ui` vs the `inline_diff` gate),
 * so with progress off this is the only frame a file edit produces.
 */
export function toolCallFromComplete(payload: ToolCompleteEvent['payload'], sessionCwd: string): SessionUpdate {
  const base = {
    sessionUpdate: 'tool_call',
    toolCallId: payload.tool_id,
    title: payload.name,
    name: payload.name,
    kind: toolKindForName(payload.name),
    ...toolCallDetails(payload.args),
  } as const
  if (payload.name !== TERMINAL_TOOL_NAME) {
    return { ...base, ...toolCallOutcome(payload) }
  }
  // The only frame this row gets, so it carries the terminal's announcement as
  // well as its outcome; both `_meta` halves have to ride the same object.
  const outcome = terminalOutcome(payload)
  return {
    ...base,
    content: terminalContent(payload.tool_id),
    ...outcome,
    _meta: { ...terminalInfoMeta(payload.tool_id, payload.args, sessionCwd), ...outcome._meta },
  }
}

// ── Plan ────────────────────────────────────────────────────────────────────

/**
 * ACP v1 has no `cancelled` plan-entry status (verified against the released
 * schema, not just the installed SDK: PlanEntryStatus is pending | in_progress
 * | completed). Remapping a cancelled todo onto `completed` would claim work
 * succeeded that was abandoned, and onto `pending`/`in_progress` would claim
 * it is still coming. A client replaces the whole plan on every update, so
 * dropping the entry is well-defined.
 */
export function planFromTodos(todos: readonly TodoItem[]): SessionUpdate {
  const entries: PlanEntry[] = []
  for (const todo of todos) {
    switch (todo.status) {
      case 'pending':
      case 'in_progress':
      case 'completed':
        entries.push({ content: todo.content, priority: PLAN_ENTRY_PRIORITY, status: todo.status })
        continue
      case 'cancelled':
        continue
    }
    // A new upstream TodoStatus fails the build here rather than being dropped.
    todo.status satisfies never
  }
  return { sessionUpdate: 'plan', entries }
}

// ── Session-level updates ───────────────────────────────────────────────────

/**
 * ACP's `usage_update` is a context-window gauge: both `used` and `size` are
 * required. The gateway only attaches the context fields when it has them, so
 * a usage frame without them maps to nothing rather than to a zeroed gauge.
 */
export function usageGauge(usage: Usage | undefined): SessionUpdate | null {
  if (usage?.context_used === undefined || usage.context_max === undefined) {
    return null
  }
  return { sessionUpdate: 'usage_update', used: usage.context_used, size: usage.context_max }
}

/**
 * ACP `PromptResponse.usage`: the tokens of one turn (the SDK documents the
 * field as "Token usage for this turn", and claude-agent-acp and codex-acp both
 * report per turn). The `Usage` type's own field descriptions still read
 * cumulatively ("across all turns"); the field's description wins, as the more
 * specific of the two. Hermes reports only running totals (see Usage), so the
 * turn's share is `end` minus `start`, the totals last reported before the
 * submit — null when none were, as an agent not yet built starts from zero.
 *
 * Read from `prompt`/`completion`/`total`, the trio with no fallback (total =
 * prompt + completion), not `input`, which can drop mid-session. The gateway
 * sends cache counts only as a rounded hit percentage, so `inputTokens`
 * counts cached and uncached input together and `cachedRead/WriteTokens` stay
 * unset. Any counter below `start` means Hermes rebuilt the agent during the turn,
 * which restarts every counter: the one mid-turn rebuild (a "Bot Chat"
 * capability sync, `_sync_bot_capabilities`) runs at turn start, before any
 * model call, so `end` alone is the turn's share. Undefined usage maps to
 * nothing.
 */
export function promptUsage(end: Usage | undefined, start: Usage | null): AcpUsage | undefined {
  if (end === undefined) {
    return undefined
  }
  const rebuilt =
    start !== null &&
    (end.calls < start.calls ||
      end.prompt < start.prompt ||
      end.completion < start.completion ||
      end.total < start.total ||
      end.reasoning < start.reasoning)
  const since = rebuilt ? null : start
  const reasoning = end.reasoning - (since?.reasoning ?? 0)
  return {
    totalTokens: end.total - (since?.total ?? 0),
    inputTokens: end.prompt - (since?.prompt ?? 0),
    outputTokens: end.completion - (since?.completion ?? 0),
    ...(reasoning !== 0 ? { thoughtTokens: reasoning } : {}),
  }
}

/** One line, capped: the gateway relays the model's title generation verbatim. */
export function sanitizeSessionTitle(title: string): string {
  // Sliced by code point so the cap cannot split a surrogate pair.
  return [...title.replace(/\s+/g, ' ').trim()].slice(0, SESSION_TITLE_MAX_CHARS).join('')
}

export function sessionTitle(title: string): SessionUpdate {
  return { sessionUpdate: 'session_info_update', title: sanitizeSessionTitle(title) }
}

// ── History replay ──────────────────────────────────────────────────────────
//
// Transcript rows (`_history_to_messages`, shared by resume/history) mapped
// for `session/load`'s synchronous replay. One row produces ZERO or more
// updates — the title `session_info_update` is the caller's, emitted first.

/**
 * One transcript row as replay updates.
 *
 * - `user` → one `user_message_chunk`.
 * - `assistant` → an `agent_thought_chunk` for its reasoning content (when
 *   present — a thinking-only turn is persisted with no text at all), then an
 *   `agent_message_chunk` for its text.
 * - `tool` → one already-`completed` `tool_call`: the row is history, there is
 *   no in-progress phase to stream. The id is the durable `row_id` when the
 *   history read stamped one, else the row's replay position. The projection
 *   keeps the call (`args`) but not the result, so the row has no output.
 * - `system` rows and any row carrying a `display_kind` are dropped: the TUI
 *   renders those as chrome lines (model switches, auto-continues), and ACP
 *   has no user/agent-content equivalent for them. The one exception is a
 *   skill-invoked user turn, whose text is the visible invocation.
 */
export function historyUpdateFromMessage(row: TranscriptMessage, index: number): readonly SessionUpdate[] {
  if (row.display_kind !== undefined && row.display_kind !== SKILL_INVOCATION_DISPLAY_KIND) {
    return []
  }
  switch (row.role) {
    case 'system':
      return []
    case 'user':
      return row.text === undefined || row.text === '' ? [] : [userMessageChunk(row.text)]
    case 'assistant': {
      const updates: SessionUpdate[] = []
      const reasoning = row.reasoning_content ?? row.reasoning
      if (reasoning !== undefined && reasoning !== '') {
        updates.push(agentThoughtChunk(reasoning))
      }
      if (row.text !== undefined && row.text !== '') {
        updates.push(agentMessageChunk(row.text))
      }
      return updates
    }
    case 'tool': {
      const name = row.name ?? 'tool'
      return [
        {
          sessionUpdate: 'tool_call',
          toolCallId: row.row_id !== undefined ? String(row.row_id) : `${HISTORY_REPLAY_TOOL_CALL_PREFIX}${index}`,
          title: row.context ?? name,
          name,
          kind: toolKindForName(name),
          status: 'completed',
          ...toolCallDetails(row.args),
        },
      ]
    }
  }
}
