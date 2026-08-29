import { PROTOCOL_VERSION as ACP_PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

// Static JSON import (not createRequire): `bun build --compile` produces a
// filesystem-less binary, so a runtime `require('../package.json')` dies on
// startup. esbuild and Bun both inline this import at build time.
import pkg from '../package.json'

export const AGENT_NAME = pkg.name
export const AGENT_VERSION = pkg.version
/** `agentInfo.title`: the user-facing name (ACP's `name` is the package id). */
export const AGENT_TITLE = 'Hermes Agent'

// The only ACP protocol version this adapter speaks. Pinned as a literal; the
// assertion below fails the build if the SDK's default PROTOCOL_VERSION leaves 1
// (e.g. a v2 upgrade), forcing a human to confirm real v2 support first.
export const PROTOCOL_VERSION = 1
const _acpProtocolVersionPin: 1 = ACP_PROTOCOL_VERSION
void _acpProtocolVersionPin

// `source` tag on every gateway session this adapter creates. Hermes stores it
// verbatim on the state.db row (`_resolve_session_source` in server.py, applied
// by session.create in methods_session.py, only defaults an empty value), so
// sessions created here stay attributable; session.list deny-lists only the
// internal "kanban"/"tool" sources and surfaces everything else. A literal, not
// the package name: renaming the package (as the hermes-acp → hermes-agent-acp
// rename did) must not orphan the sessions already recorded under this tag.
export const GATEWAY_SESSION_SOURCE = 'hermes-acp'

// ── Gateway transport selection ─────────────────────────────────────────────
//
// The adapter reaches the Hermes tui_gateway over its WebSocket (ndjson
// JSON-RPC on /api/ws), in one of two modes:
//   serve  (default) — spawn `hermes serve` as a managed child and discover
//                      its port from the HERMES_BACKEND_READY stdout sentinel.
//   attach           — connect to an already-running gateway WebSocket.

export const ENV_GATEWAY_MODE = 'HERMES_ACP_MODE'
export const GATEWAY_MODE_SERVE = 'serve'
export const GATEWAY_MODE_ATTACH = 'attach'
export const DEFAULT_GATEWAY_MODE = GATEWAY_MODE_SERVE

// Attach mode: WebSocket URL of the running gateway, e.g. ws://127.0.0.1:9119/api/ws.
export const ENV_GATEWAY_URL = 'HERMES_ACP_GATEWAY_URL'

// Serve mode: `hermes` console script to spawn (default: resolved from PATH).
export const ENV_HERMES_BIN = 'HERMES_ACP_HERMES_BIN'
export const DEFAULT_HERMES_BIN = 'hermes'

// Hermes' own home variable (hermes_constants.py `_hermes_home_from_env`),
// read for the session-cwd cache location. Not adapter-namespaced: the cache
// must sit under the home the GATEWAY uses, and the gateway child inherits
// this variable from the adapter's environment.
export const ENV_HERMES_HOME = 'HERMES_HOME'

// ── Session lifecycle (session/list, resume, load, close, delete) ───────────
//
// `session.list` upstream has no cursor/cwd params and projects no cwd, so
// both pagination and cwd filtering are adapter-side: one fetch bounded by
// the cap, filtered, then paged by a decimal-offset cursor. Offset drift when
// sessions are created mid-pagination is accepted (docs/caveats.md).
export const SESSION_LIST_FETCH_CAP = 1_000
export const SESSION_LIST_PAGE_SIZE = 50

// The persisted stored-id → cwd cache (src/session/sessionDirectory.ts),
// at <hermes-home>/<dir>/<file>. Hermes' session.list does not report a cwd,
// so this cache is the only source of truthful cwds for sessions this adapter
// created in earlier processes. A literal like GATEWAY_SESSION_SOURCE: the
// directory predates the hermes-agent-acp rename and moving it would orphan
// every cwd recorded so far.
export const SESSION_DIRECTORY_DIRNAME = 'hermes-acp'
export const SESSION_DIRECTORY_FILENAME = 'sessions.json'

// Tool-call id prefix for history rows replayed on session/load that carry no
// durable `row_id`; the row's index in the replayed transcript completes it.
export const HISTORY_REPLAY_TOOL_CALL_PREFIX = 'replay-'

// The one `display_kind` that marks real user content rather than chrome: a
// skill-invoked user turn keeps its visible invocation text (server.py
// `_history_to_messages`), so it replays like any other user row.
export const SKILL_INVOCATION_DISPLAY_KIND = 'skill_invocation'

// Session titles are LLM-generated upstream (`title_generation`, up to 1024
// tokens) and emitted verbatim, so they are flattened to one line and capped
// before reaching a client's session list or tab.
export const SESSION_TITLE_MAX_CHARS = 256

// Tool-argument keys Hermes' own adapter reads for ACP `locations`
// (`acp_adapter/tools.py` extract_locations).
export const TOOL_LOCATION_PATH_KEY = 'path'
export const TOOL_LOCATION_LINE_KEYS = ['offset', 'line'] as const

// ── Managed serve mode details ──────────────────────────────────────────────
//
// `hermes serve` binds loopback with `--port 0` so the OS assigns a free port;
// the real port is announced on stdout as `HERMES_BACKEND_READY port=<n>`.
// `/api/ws` requires a session token via `?token=<token>` even on loopback;
// the adapter mints or passes `HERMES_DASHBOARD_SESSION_TOKEN` in the child env
// and connects to `/api/ws?token=<token>`. `--isolated` pins a dedicated server
// instead of routing to a machine-level one, which would make our child exit
// (and open a browser) when one is already running.

export const SERVE_HOST = '127.0.0.1'
export const SERVE_AUTO_PORT = '0'
export const SERVE_READY_PATTERN = /^HERMES_BACKEND_READY port=(\d+)$/
export const GATEWAY_WS_PATH = '/api/ws'
export const ENV_SESSION_TOKEN = 'HERMES_ACP_SESSION_TOKEN'
export const ENV_DASHBOARD_SESSION_TOKEN = 'HERMES_DASHBOARD_SESSION_TOKEN'
// Env var `hermes serve` reads to arm its parent-death watchdog, so a crashed
// adapter cannot leak the backend it spawned.
export const ENV_SERVE_PARENT_PID = 'HERMES_PARENT_PID'

// ── Timeouts and teardown ───────────────────────────────────────────────────

// Covers Python import + uvicorn bind (serve), the WebSocket connect, and the
// initial gateway.ready event.
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
export const ENV_STARTUP_TIMEOUT_MS = 'HERMES_ACP_STARTUP_TIMEOUT_MS'

// Per-RPC budget; mirrors Hermes' own gateway client default. prompt.submit
// returns as soon as the turn is streaming, so this bounds metadata calls
// (model.options can hit provider /v1/models endpoints), not turns.
export const DEFAULT_RPC_TIMEOUT_MS = 120_000
export const ENV_RPC_TIMEOUT_MS = 'HERMES_ACP_RPC_TIMEOUT_MS'

// Node clamps setTimeout delays above 2^31-1 to 1ms, which would silently
// invert an oversized timeout into an instant one; reject past this bound.
export const MAX_TIMEOUT_MS = 2_147_483_647

// Grace between SIGTERM and SIGKILL when tearing down a spawned child.
export const KILL_GRACE_MS = 2_000

// ── Approvals ───────────────────────────────────────────────────────────────
//
// Choice strings `approval.respond` forwards verbatim to
// `tools/approval.py resolve_gateway_approval`. Only "deny" blocks the action:
// upstream approves on every other resolved choice
// (`if not resolved or choice is None or choice == "deny"`), which is why an
// unrecognized choice must never be relayed — it would read as consent.

export const APPROVAL_CHOICE_ONCE = 'once'
export const APPROVAL_CHOICE_SESSION = 'session'
export const APPROVAL_CHOICE_ALWAYS = 'always'
export const APPROVAL_CHOICE_DENY = 'deny'

// The gateway fills `choices` itself whenever the approval payload carries an
// `allow_permanent` flag (`_approval_request_payload`). This is the floor for
// the payloads that carry neither: the two choices every approval surface
// upstream supports.
export const DEFAULT_APPROVAL_CHOICES: readonly string[] = [APPROVAL_CHOICE_ONCE, APPROVAL_CHOICE_DENY]

// Prefix for the tool-call row the adapter opens when an approval arrives with
// no gateway tool call in flight to attach it to. A dangling toolCallId is the
// upstream defect this adapter exists to fix, so the row is announced as a real
// `tool_call` before it is referenced.
export const APPROVAL_GATE_TOOL_CALL_PREFIX = 'hermes-agent-acp-approval-'

// ── Clarify ─────────────────────────────────────────────────────────────────

// Hermes' clarify tool, whose `tool.start` the gateway emits even with tool
// progress off (`_tool_lifecycle_required_for_ui`), so a clarify elicitation
// can always be tied to the tool call the client already sees.
export const CLARIFY_TOOL_NAME = 'clarify'

// Single-property elicitation form: Hermes takes one free-text answer string
// per question, so the schema never needs more than one field.
export const CLARIFY_ANSWER_FIELD = 'answer'

// ── Session modes ───────────────────────────────────────────────────────────
//
// Exactly two modes, both backed by the gateway's per-session `yolo` flag
// (config.set key "yolo", scope "session"). Hermes has no edit-approval gate of
// its own — ordinary file edits never prompt — so an `accept_edits` mode would
// advertise a distinction the gateway cannot make.

export const SESSION_MODE_DEFAULT = 'default'
export const SESSION_MODE_DONT_ASK = 'dont_ask'
export const SESSION_MODE_DEFAULT_NAME = 'Default'
export const SESSION_MODE_DONT_ASK_NAME = "Don't ask"

// config.set key and scope for the per-session approval bypass.
export const CONFIG_KEY_YOLO = 'yolo'
export const CONFIG_SCOPE_SESSION = 'session'
export const CONFIG_VALUE_ON = 'on'
export const CONFIG_VALUE_OFF = 'off'

// ── Session config options ──────────────────────────────────────────────────
//
// Option ids and value-id grammar. A model value id splits on the FIRST "/":
// provider slug, then the model id, which may itself contain slashes
// (`openrouter/nousresearch/hermes-4-70b`). The id reverses into the
// gateway's config.set value, `"<model> --provider <slug>"`.

export const CONFIG_OPTION_MODEL = 'model'
export const CONFIG_OPTION_MODEL_NAME = 'Model'
export const CONFIG_OPTION_MODEL_CATEGORY = 'model'
export const MODEL_VALUE_SEPARATOR = '/'
export const CONFIG_KEY_MODEL = 'model'
export const MODEL_PROVIDER_FLAG = '--provider'

// Deliberately not id "mode" nor category "mode": both are the session-mode
// lane in ACP clients, and this option is the gateway's GLOBAL approval policy
// (config.yaml `approvals.mode`), not a per-session mode.
export const CONFIG_OPTION_APPROVAL_MODE = 'approval_mode'
export const CONFIG_OPTION_APPROVAL_MODE_NAME = 'Approval mode (global)'
export const CONFIG_KEY_APPROVAL_MODE = 'approval_mode'

/** `_APPROVAL_MODES` in tui_gateway/server.py. */
export const APPROVAL_MODE_MANUAL = 'manual'
export const APPROVAL_MODE_SMART = 'smart'
export const APPROVAL_MODE_OFF = 'off'
export const APPROVAL_MODE_NAMES: Readonly<Record<string, string>> = {
  [APPROVAL_MODE_MANUAL]: 'Manual',
  [APPROVAL_MODE_SMART]: 'Smart',
  [APPROVAL_MODE_OFF]: 'Off',
}

// Elicitation form field for the expensive-model confirmation.
export const MODEL_CONFIRM_FIELD = 'confirm'
export const MODEL_CONFIRM_YES = 'Yes'
export const MODEL_CONFIRM_NO = 'No'

// ── Slash commands ──────────────────────────────────────────────────────────
//
// Invocation grammar, mirroring codex-acp's `parseCommand`: only the FIRST
// prompt content block can start a command, it must be text, and after
// trimming it must begin with this prefix; the first whitespace-delimited
// token (lowercased) is the command name and the trimmed remainder is its
// single unstructured argument.

export const COMMAND_PREFIX = '/'

// Commands `commands.catalog` lists that an ACP client cannot act on.
//
// Upstream already drops `_TUI_HIDDEN` and `gateway_only` commands, but the
// catalog is built for Hermes' own terminal UI, so it still carries commands
// whose entire effect is on that UI.
//
// The first three are `_TUI_EXTRA` entries (server.py ~13320) that the gateway
// does not implement at all — frontend affordances the TUI handles itself, so
// invoking them can only fail. The next group toggles terminal display state
// (verbosity, theme, status bar, activity indicator, pane focus) that this
// adapter has no surface for: they would execute and change nothing the user
// can see. `/sessions` is different — it is a real registry command
// (hermes_cli/commands.py ~240, which is why the `_TUI_EXTRA` entry of the
// same name is deduped away) — but session switching belongs to the ACP
// client, which owns which session it is talking to; an agent-side switcher
// would move Hermes out from under it.
export const EXCLUDED_COMMANDS: ReadonlySet<string> = new Set([
  '/density',
  '/logs',
  '/mouse',
  '/focus',
  '/verbose',
  '/theme',
  '/statusbar',
  '/indicator',
  '/skin',
  '/sessions',
])

// Rendered into an AvailableCommand's `input.hint` when the catalog lists
// subcommands for it, so a client's completion UI can show what follows.
export const COMMAND_SUBCOMMAND_HINT_SEPARATOR = '|'

// `slash.exec` refuses skill commands and `/snapshot restore` with this code
// and a message pointing at `command.dispatch` (methods_tools.py ~1196,
// ~1170). It is the signal to re-issue the command on the dispatch method,
// not an error to surface.
export const GATEWAY_CODE_USE_COMMAND_DISPATCH = 4018

// ── Auth ────────────────────────────────────────────────────────────────────
//
// Mirrors `acp_adapter/auth.py`: at most two methods, neither of which moves a
// credential over ACP. The provider method is a statement that Hermes already
// has working credentials; the terminal method re-runs this adapter's own
// binary with `--setup` so the user can create them.

// RPC budget for every client-facing `model.options` read. Far below
// DEFAULT_RPC_TIMEOUT_MS because all three call sites block a round-trip the
// user is waiting on: `initialize` blocks the ACP handshake, `authenticate`
// blocks a sign-in affordance, and `session/new` blocks session creation. The
// read probes the current custom provider's endpoint even with `refresh` off,
// so a slow or hanging provider is the case this bounds. Consequences differ
// by site: the auth reads degrade to the terminal setup method alone, while
// `session/new` fails the request — a session that cannot report its catalog
// cannot advertise `configOptions` honestly, and failing at ten seconds beats
// failing at two minutes.
export const MODEL_OPTIONS_TIMEOUT_MS = 10_000

export const AUTH_METHOD_SETUP_ID = 'hermes-setup'
export const AUTH_METHOD_SETUP_NAME = 'Configure Hermes provider'
export const AUTH_METHOD_SETUP_DESCRIPTION =
  "Open Hermes' interactive model and provider setup in a terminal. Use this when Hermes has no usable provider credentials on this machine."
// ACP terminal auth has no `command` field: the client re-runs the agent
// invocation it already has, with these args appended. index.ts implements the
// flag by handing off to the Hermes CLI's interactive picker.
export const AUTH_SETUP_FLAG = '--setup'
export const AUTH_SETUP_HERMES_ARGS: readonly string[] = ['model']

/** Suffix on the provider auth method's display name (upstream's wording). */
export const AUTH_METHOD_PROVIDER_NAME_SUFFIX = 'runtime credentials'

// ── Diagnostics ─────────────────────────────────────────────────────────────

// Bounded child-stderr tail appended to startup-failure errors, so "wrong
// python", "missing dep", and "config parse failure" are distinguishable.
export const STDERR_TAIL_LINES = 20
export const STDERR_LINE_MAX_CHARS = 4_096
// Bound on malformed-frame excerpts quoted in diagnostics.
export const FRAME_PREVIEW_MAX_CHARS = 200
