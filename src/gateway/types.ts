/**
 * Typed surface of the Hermes tui_gateway JSON-RPC API.
 *
 * Hand-written from the Hermes source (tui_gateway/server.py,
 * methods_prompt.py, methods_session.py, methods_config.py,
 * methods_complete.py, methods_tools.py) and pinned to Hermes 0.20.6
 * (tag v2026.8.27; see docs/refs.md). There is no codegen: this file is the
 * compile-time tripwire — every Hermes bump must re-verify these shapes
 * against upstream (docs/todos.md "Known limits").
 *
 * The wire is trusted once types are pinned: frames are parsed and asserted
 * to `GatewayEvent` / result types without runtime validation. Unknown event
 * types are dropped with a logged line instead of guessed at.
 */

// ── Shared payload shapes ───────────────────────────────────────────────────

/** From tui_gateway/server.py `_session_info`; fields the adapter consumes. */
export interface SessionInfo {
  readonly model: string
  readonly provider: string
  readonly reasoning_effort: string
  readonly service_tier: string
  readonly fast: boolean
  readonly yolo: boolean
  readonly approval_mode: string
  readonly tools: Record<string, string[]>
  readonly cwd: string
  readonly running: boolean
  readonly title: string
  readonly stored_session_id: string
  readonly turn_started_at: number | null
  /** `hermes_cli.__version__`, or `""` when that import failed — upstream
   * seeds both version fields empty and swallows the ImportError
   * (server.py ~5770). The gateway has no version method, so this is the only
   * place a Hermes version is reported at all. */
  readonly version: string
  readonly release_date: string
  /** `DESKTOP_BACKEND_CONTRACT` (6 on the reference build, server.py 5631):
   * the capability count Hermes' own desktop client gates on. Unlike
   * `version` it rides the lazy skeleton too. Typed because it is on the
   * wire; this adapter reads neither field (docs/refs.md). */
  readonly desktop_contract: number
}

/**
 * The info snapshot `session.create`/`session.resume` return for a session
 * whose agent is not built yet: `_lazy_resume_info` (server.py ~8356) carries
 * cwd, branch, project, model, empty tools/skills, `lazy: true`, and provider
 * only when the stored session overrode it — none of the runtime fields the
 * full `session.info` event reports, and no title (a stored session's title
 * lives only on `session.list` rows).
 */
export type LazySessionInfo = Partial<SessionInfo> & { readonly lazy?: boolean }

/**
 * Whether a `session.info` frame is the full `_session_info` record. One emit
 * site sends a skeleton instead — `_apply_project_workspace` (server.py ~7894)
 * emits `{cwd, branch, project, lazy: true}` when the agent's own `project_*`
 * tools move the workspace before the agent is built — and that frame carries
 * no settings to apply.
 */
export function isFullSessionInfo(info: LazySessionInfo): info is SessionInfo {
  return info.lazy !== true && typeof info.model === 'string' && typeof info.provider === 'string'
}

/** From tui_gateway/server.py `_get_usage` (+ context gauge fields). */
export interface Usage {
  readonly model: string
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly prompt: number
  readonly completion: number
  readonly total: number
  readonly calls: number
  readonly context_used?: number
  readonly context_percent?: number
  readonly context_max?: number
}

/** From tools/todo_tool.py VALID_STATUSES — note `cancelled` is a real
 * status upstream and must not be remapped to `completed` (see docs/todos.md
 * section 2, plan events). */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoItem {
  readonly id: string
  readonly content: string
  readonly status: TodoStatus
}

/** Transcript row shape shared by create/resume/branch/history responses —
 * the `_history_to_messages` projection (server.py ~7669). Rows with
 * `display_kind: "hidden"` are already filtered upstream; any other
 * `display_kind` marks a metadata row (model_switch, auto_continue, …), not
 * user/agent content. */
export interface TranscriptMessage {
  readonly role: 'assistant' | 'system' | 'tool' | 'user'
  readonly text?: string
  readonly name?: string
  readonly context?: string
  /** Tool rows only: the parsed call arguments, when the call had any. Tool
   * rows carry no `text` — the projection keeps the call, not the result. */
  readonly args?: Record<string, unknown>
  /** Unix seconds; display-only, never model-facing. */
  readonly timestamp?: number
  /** Durable state.db row id, stamped when the history read included it. */
  readonly row_id?: string | number
  readonly display_kind?: string
  readonly display_metadata?: unknown
  /** Assistant rows only: reasoning/thinking content the provider returned. */
  readonly reasoning?: string
  readonly reasoning_content?: string
}

// ── Events ──────────────────────────────────────────────────────────────────
//
// Envelope on the wire: {"jsonrpc":"2.0","method":"event","params":{...}} —
// params carries `type`, an optional `session_id` (the live gateway session
// id), and an optional `payload`.

export interface GatewayReadyEvent {
  readonly type: 'gateway.ready'
  /** Absent: the frame is hand-built (entry.py, ws.py) with no session_id. */
  readonly session_id?: string
  readonly payload?: { readonly skin?: unknown; readonly change_events?: boolean }
}

/**
 * `running: false` on a full record is a turn's settled bookend: the turn
 * thread's `finally` clears the flag (server.py ~13047) before
 * `_emit_settled_session_info` (~13081) emits this, so nothing further is
 * coming for that turn. It is the only such marker on the paths that return out
 * of the turn body without a `message.complete` (see GatewayErrorEvent).
 */
export interface SessionInfoEvent {
  readonly type: 'session.info'
  readonly session_id?: string
  /** Usually the full record; see isFullSessionInfo for the one skeleton. */
  readonly payload: LazySessionInfo
}

export interface SessionTitleEvent {
  readonly type: 'session.title'
  readonly session_id?: string
  /** payload.session_id is the stored session key, not the wire session id. */
  readonly payload: { readonly session_id?: string; readonly title: string }
}

export interface SessionUsageEvent {
  readonly type: 'session.usage'
  readonly session_id?: string
  readonly payload?: { readonly usage?: Usage }
}

export interface MessageStartEvent {
  readonly type: 'message.start'
  readonly session_id?: string
  readonly payload?: undefined
}

export interface MessageDeltaEvent {
  readonly type: 'message.delta'
  readonly session_id?: string
  readonly payload?: { readonly rendered?: string; readonly text?: string }
}

/**
 * Assistant text emitted alongside tool calls, or an attempted final answer
 * before a verify-on-stop nudge (server.py `_interim_assistant_cb`, on by
 * default). `message.complete.text` carries only the final response, so when
 * `already_streamed` is false this is the only delivery of that text.
 */
export interface MessageInterimEvent {
  readonly type: 'message.interim'
  readonly session_id?: string
  readonly payload?: { readonly text?: string; readonly already_streamed?: boolean }
}

export type MessageCompleteStatus = 'complete' | 'error' | 'interrupted'

export interface MessageCompleteEvent {
  readonly type: 'message.complete'
  readonly session_id?: string
  readonly payload?: {
    readonly text?: string
    readonly status?: MessageCompleteStatus
    readonly error?: string
    readonly partial?: boolean
    readonly recoverable?: boolean
    readonly reasoning?: string
    readonly usage?: Usage
  }
}

export interface ThinkingDeltaEvent {
  readonly type: 'thinking.delta'
  readonly session_id?: string
  readonly payload?: { readonly text?: string }
}

export interface ReasoningDeltaEvent {
  readonly type: 'reasoning.delta'
  readonly session_id?: string
  readonly payload?: { readonly text?: string; readonly verbose?: boolean }
}

export interface ToolStartEvent {
  readonly type: 'tool.start'
  readonly session_id?: string
  readonly payload: {
    readonly tool_id: string
    readonly name: string
    readonly args?: Record<string, unknown>
    readonly args_text?: string
    readonly context?: string
  }
}

export interface ToolCompleteEvent {
  readonly type: 'tool.complete'
  readonly session_id?: string
  readonly payload: {
    readonly tool_id: string
    readonly name: string
    readonly args?: Record<string, unknown>
    /** Parsed JSON of the tool result when it parses, else the raw string. */
    readonly result?: unknown
    readonly result_text?: string
    readonly summary?: string
    readonly duration_s?: number
    readonly inline_diff?: string
    /** Full todo list from the `todo` tool result — the source for ACP plan updates. */
    readonly todos?: readonly TodoItem[]
  }
}

export interface ApprovalRequestEvent {
  readonly type: 'approval.request'
  readonly session_id?: string
  readonly payload: {
    readonly request_id: string
    readonly command: string
    readonly description: string
    readonly choices?: readonly string[]
    readonly allow_permanent?: boolean
    readonly smart_denied?: boolean
    readonly pattern_keys?: readonly string[]
  }
}

export interface ClarifyQuestion {
  readonly qid: string
  readonly question: string
  readonly choices?: readonly string[] | null
  readonly multi_select?: boolean
}

export interface ClarifyRequestEvent {
  readonly type: 'clarify.request'
  readonly session_id?: string
  readonly payload: {
    readonly request_id: string
    readonly question?: string
    readonly choices?: readonly string[] | null
    /** Single-question form only; emitted only when true (server.py ~4650). */
    readonly multi_select?: boolean
    readonly questions?: readonly ClarifyQuestion[]
    readonly answers?: Record<string, string>
  }
}

/**
 * Diagnostic in most places, terminal in two, neither of which is followed by a
 * `message.complete`:
 *
 * - the pending-agent path (methods_prompt.py `run_after_agent_ready`) emits
 *   only this and returns when the turn is cancelled or the session stops
 *   before the agent is built, so a turn that sees it before any
 *   `message.start` is over;
 * - the `@`-context refusal (server.py `_run_prompt_submit` ~12366, raised when
 *   injected references exceed half the context window) emits it and returns
 *   from the turn body after `message.start`, leaving the settled
 *   `session.info` as the only marker that the turn ended (SessionInfoEvent).
 */
export interface GatewayErrorEvent {
  readonly type: 'error'
  readonly session_id?: string
  readonly payload?: { readonly message?: string }
}

export type GatewayEvent =
  | GatewayReadyEvent
  | SessionInfoEvent
  | SessionTitleEvent
  | SessionUsageEvent
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageInterimEvent
  | MessageCompleteEvent
  | ThinkingDeltaEvent
  | ReasoningDeltaEvent
  | ToolStartEvent
  | ToolCompleteEvent
  | ApprovalRequestEvent
  | ClarifyRequestEvent
  | GatewayErrorEvent

// Completeness-checked registry of the event types above: a missing or
// misspelled key here is a compile error, and dispatch uses it to separate
// known events (delivered to subscribers) from unknown ones (logged, dropped).
const KNOWN_EVENT_TYPES: Record<GatewayEvent['type'], true> = {
  'gateway.ready': true,
  'session.info': true,
  'session.title': true,
  'session.usage': true,
  'message.start': true,
  'message.delta': true,
  'message.interim': true,
  'message.complete': true,
  'thinking.delta': true,
  'reasoning.delta': true,
  'tool.start': true,
  'tool.complete': true,
  'approval.request': true,
  'clarify.request': true,
  error: true,
}

export function isKnownGatewayEventType(type: string): type is GatewayEvent['type'] {
  // Own-property check: `in` would also admit Object.prototype keys
  // ("toString", "constructor", …) into the typed event surface.
  return Object.hasOwn(KNOWN_EVENT_TYPES, type)
}

// ── Method params and results ───────────────────────────────────────────────

export interface SessionCreateParams {
  readonly session_id?: string
  readonly cwd?: string
  readonly cols?: number
  readonly title?: string
  readonly model?: string
  readonly provider?: string
  readonly source?: string
}

export interface SessionCreateResult {
  readonly session_id: string
  /** The stored session key. Optional on the wire (it predates the lazily
   * created DB row), but this adapter treats it as a hard contract: it is the
   * ACP sessionId, so a create without it fails `session/new`. */
  readonly stored_session_id?: string
  readonly message_count?: number
  readonly messages?: readonly TranscriptMessage[]
  readonly info?: LazySessionInfo
}

export interface PromptSubmitParams {
  readonly session_id: string
  readonly text: string
}

/**
 * `voice_stopped` is the one non-turn answer: with voice mode on in the gateway
 * environment, a prompt that is exactly a configured stop phrase ends the voice
 * chat and starts no turn (methods_prompt.py ~305).
 */
export type PromptSubmitResult = { readonly status: 'streaming' } | { readonly voice_stopped: true }

// ── Prompt attachments ──────────────────────────────────────────────────────
//
// Attachments are pre-staged, not passed to `prompt.submit`: image.attach_bytes
// pushes a path onto the session's `attached_images` list, and the NEXT submit
// drains it into the turn (server.py `_run_prompt_submit`). file.attach is the
// other half — it materializes the file in the session workspace and returns a
// `@file:` ref for the caller to splice into the prompt text; it never touches
// `attached_images`.

/** tui_gateway/methods_prompt.py `image.attach_bytes`. The `data` alias exists
 * upstream for older desktop builds and is deliberately not modeled. */
export interface ImageAttachBytesParams {
  readonly session_id: string
  /** Base64 image bytes; a `data:image/...;base64,` prefix is accepted. */
  readonly content_base64: string
  /** Extension hint. Without it, magic bytes decide, falling back to `.png`. */
  readonly filename?: string
  readonly ext?: string
}

/** Metadata `_image_meta` adds to every attach result. The dimensions are
 * absent when PIL cannot open the file — upstream swallows that failure. */
export interface AttachedImageMeta {
  readonly name: string
  readonly width?: number
  readonly height?: number
  readonly token_estimate?: number
}

export type ImageAttachBytesResult = AttachedImageMeta & {
  readonly attached: boolean
  /** Gateway-side path of the staged image; the handle `image.detach` takes. */
  readonly path: string
  /** Number of images staged on the session after this call. */
  readonly count: number
  readonly remainder: string
  /** Upstream composer marker, `[User attached image: <name>]`. */
  readonly text: string
  readonly bytes: number
}

/** tui_gateway/methods_prompt.py `file.attach`. `path` is only useful when the
 * gateway can see it; this adapter always uploads `data_url` bytes because an
 * ACP client's paths are its own.
 *
 * PDFs come through here too, not through `pdf.attach`: the rasterizing path
 * caps at 25 pages and needs poppler on the host, while Hermes' read tool
 * extracts a workspace PDF's text itself and warns the agent to OCR whatever it
 * could not cover. */
export interface FileAttachParams {
  readonly session_id: string
  readonly data_url: string
  readonly name?: string
  readonly path?: string
}

export interface FileAttachResult {
  readonly attached: boolean
  readonly name: string
  readonly path: string
  readonly ref_path: string
  /** `@file:<ref_path>` — the text the caller splices into the prompt so
   * Hermes' context references resolve the staged file. */
  readonly ref_text: string
  readonly uploaded: boolean
}

/** tui_gateway/methods_prompt.py `image.detach`. Takes the `path` an attach
 * returned and drops it from the session's staged list. */
export interface ImageDetachParams {
  readonly session_id: string
  readonly path: string
}

export interface ImageDetachResult {
  /** False when the path was not staged (already drained by a submit). */
  readonly detached: boolean
  readonly count: number
}

export interface SessionInterruptResult {
  readonly status: string
  readonly turn_isolation?: boolean
}

export interface SessionSteerResult {
  readonly status: 'queued' | 'rejected'
  readonly text: string
}

export interface SessionBranchParams {
  readonly session_id: string
  /** Truncate the branched history to the first `count` visible messages
   * (breakpoint fork; tui_gateway/methods_session.py `session.branch`). */
  readonly count?: number
  readonly name?: string
}

export interface SessionBranchResult {
  readonly session_id: string
  readonly stored_session_id?: string
  readonly title?: string
  readonly parent?: string
  readonly message_count?: number
  readonly messages?: readonly TranscriptMessage[]
  readonly info?: SessionInfo
}

export interface SessionListParams {
  readonly limit?: number
  readonly include_hidden?: boolean
  readonly title?: string
}

export interface SessionListItem {
  readonly id: string
  readonly title: string
  readonly preview: string
  readonly started_at: number
  readonly message_count: number
  readonly source?: string
}

export interface SessionListResult {
  readonly sessions: readonly SessionListItem[]
}

export interface SessionResumeParams {
  readonly session_id: string
  readonly cols?: number
  /** Suppress the transcript copy in the response (methods_session.py ~373);
   * set by callers that only need the live session, not its history. */
  readonly omit_messages?: boolean
}

export interface SessionResumeResult {
  readonly session_id: string
  readonly session_key?: string
  readonly resumed?: string
  readonly started_at?: number
  readonly status?: 'idle' | 'starting' | 'waiting' | 'working' | 'streaming' | 'resuming'
  readonly running?: boolean
  readonly message_count?: number
  readonly messages: readonly TranscriptMessage[]
  readonly info?: LazySessionInfo
}

export interface SessionHistoryResult {
  readonly count: number
  readonly messages: readonly TranscriptMessage[]
}

export interface SessionCloseResult {
  readonly closed?: boolean
}

export interface SessionDeleteResult {
  readonly deleted?: string
}

export interface ApprovalRespondParams {
  readonly session_id: string
  readonly choice: string
  readonly request_id?: string
  readonly all?: boolean
}

export interface ApprovalRespondResult {
  readonly resolved?: number
}

export interface ClarifyRespondParams {
  readonly request_id: string
  /** Single-question clarify answer. */
  readonly answer?: string
  /** Batch clarify: lock one question's answer by qid. */
  readonly question_id?: string
}

/** Shared result of the `*.respond` prompt methods (clarify.respond, …),
 * all served by tui_gateway's `_respond`. */
export interface PromptRespondResult {
  readonly status: 'ok' | 'expired'
  readonly remaining?: readonly string[]
}

export interface ModelOptionsParams {
  readonly session_id?: string
  readonly refresh?: boolean
}

export interface ModelOptionProvider {
  readonly name: string
  readonly slug: string
  readonly models?: readonly string[]
  readonly total_models?: number
  readonly is_current?: boolean
  readonly authenticated?: boolean
  readonly auth_type?: string
  readonly key_env?: string
  readonly warning?: string
}

export interface ModelOptionsResult {
  readonly model?: string
  readonly provider?: string
  readonly providers?: readonly ModelOptionProvider[]
}

/** tui_gateway/methods_config.py `config.get`. The keys are the same ones
 * `config.set` takes; each returns its own subset of the fields below. */
export interface ConfigGetParams {
  readonly key: string
  readonly session_id?: string
}

export interface ConfigGetResult {
  readonly value?: string
  readonly display?: string
  readonly home?: string
}

export interface ConfigSetParams {
  readonly key: string
  readonly value: string
  readonly session_id?: string
  /** `yolo` honors "session" (this session only) and "global" (config.yaml);
   * the model and approval_mode keys ignore it (server.py ~12234). */
  readonly scope?: string
  readonly confirm_expensive_model?: boolean
}

export interface ConfigSetResult {
  readonly key?: string
  readonly value?: string
  /** True when a mid-turn model switch is queued for the next turn start. */
  readonly deferred?: boolean
  /** Expensive-model gate: the pick was NOT applied and has to be re-sent with
   * `confirm_expensive_model: true` (server.py ~12024). */
  readonly confirm_required?: boolean
  readonly confirm_message?: string
  readonly warning?: string
  readonly scope?: string
  readonly info?: SessionInfo
}

/** One category bucket of `commands.catalog` (methods_tools.py ~354). The same
 * `[name, description]` pairs also appear flat in `pairs`; skills and aliases
 * appear in neither. */
export interface CommandsCatalogCategory {
  readonly name: string
  readonly pairs?: readonly (readonly [string, string])[]
}

/** `skills` entry, keyed by the skill's command key including its leading
 * slash (`"/work"`). Skill commands are listed in `pairs` but deliberately not
 * in `canon`, so recognizing one means consulting this map. */
export interface CommandsCatalogSkill {
  readonly usage?: number
  readonly origin?: string
}

/** tui_gateway/methods_tools.py `commands.catalog`. Every key is always
 * present upstream; each is optional here because a gateway that drops one
 * must surface as a missing value rather than a crash in the mapper. */
export interface CommandsCatalogResult {
  /** `[name, description]` for every listable command, name including its
   * leading slash. Registry commands, then the terminal-only `_TUI_EXTRA`
   * entries, then quick commands, then skill commands. */
  readonly pairs?: readonly (readonly [string, string])[]
  /** Lowercased input (including aliases) → canonical `/name`. */
  readonly canon?: Record<string, string>
  /** `/name` → subcommand list. Built over the WHOLE registry, so it carries
   * keys that never appear in `pairs`. */
  readonly sub?: Record<string, readonly string[]>
  readonly categories?: readonly CommandsCatalogCategory[]
  readonly skills?: Record<string, CommandsCatalogSkill>
  readonly skill_count?: number
  /** Empty string when nothing failed; a discovery failure message otherwise. */
  readonly warning?: string
}

export interface SlashExecParams {
  readonly session_id: string
  readonly command: string
}

export interface CommandDispatchParams {
  /** Command name WITHOUT its leading slash; upstream alias-resolves it. */
  readonly name: string
  readonly arg?: string
  readonly session_id?: string
}

/**
 * `command.dispatch` result (methods_tools.py ~432-1122).
 *
 * `output` variants are terminal text; `send`/`skill` hand back a `message`
 * the client is expected to submit as a user turn (`display` is what a UI
 * should show instead of the model-facing `message`); `prefill` hands back
 * text for the composer, NOT for submission; `alias` redirects to another
 * command name.
 */
export type CommandDispatchResult =
  | { readonly type: 'exec'; readonly output: string }
  | { readonly type: 'plugin'; readonly output: string }
  | { readonly type: 'alias'; readonly target: string }
  | { readonly type: 'send'; readonly message: string; readonly notice?: string; readonly display?: string }
  | { readonly type: 'skill'; readonly message: string; readonly name: string; readonly display?: string }
  | { readonly type: 'prefill'; readonly message: string; readonly notice?: string }

/**
 * `slash.exec` result. Direct execution answers `{output}` (never empty —
 * upstream coerces to `"(no output)"`), but pending-input commands and skill
 * bundles are rerouted to `command.dispatch` internally and come back with
 * that method's payload instead, which usually carries no `output` at all.
 */
export type SlashExecResult = { readonly output: string; readonly warning?: string } | CommandDispatchResult
