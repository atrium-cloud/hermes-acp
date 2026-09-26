# References

## ACP v1 spec

- Repo: https://github.com/agentclientprotocol/agent-client-protocol
- Schema (latest release): https://github.com/agentclientprotocol/agent-client-protocol/releases/latest/download/schema.json
- Protocol docs: https://agentclientprotocol.com/protocol
- TypeScript SDK: `@agentclientprotocol/sdk` (generated types in `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`)
- `session/fork` is a first-class experimental method in SDK 1.4.0; this adapter implements head-only fork, with no breakpoint marker advertised (docs/todos.md section 2).

## Hermes Agent

- Repo: https://github.com/NousResearch/hermes-agent
- Floor: Hermes 0.21.4 (tag `v2026.9.21`), the oldest supported release. It added the `client.capabilities {server_requests: true}` handshake (`tui_gateway/methods_voice.py`): a WebSocket client that never sends it has every server→client request (approval, clarify) failed unsent (`tui_gateway/server_requests.py` `_unanswerable`). The adapter sends it at startup, and a gateway without the method fails startup with an error naming the floor. 0.21.3 had moved approvals and clarify onto server→client requests (commit ebe8cda8). The floor moves only when the adapter comes to depend on something older releases lack.
- Verified against: Hermes 0.21.5 (tag `v2026.9.24`), the release `src/gateway/types.ts` was last hand-verified against (payload shapes, method params/results, turn lifecycle, and the server→client request contracts, 2026-09-27), and the default target of `bun run test:e2e:sprite`. Each newer release is re-verified (`bun run drift`, its worklist, then the live e2e tier), then moves this line.
- Hermes is an external runtime dependency the way codex-acp's `@openai/codex` and claude-agent-acp's `@anthropic-ai/claude-agent-sdk` are, except it is a Python install (`install.sh`/uv) that cannot ride in the package or the release bundle: the user's `hermes` on PATH is used as-is, never locked to a version. Nothing compares versions at runtime — no version check, no `desktop_contract` gate; `_session_info.version`/`desktop_contract` stay typed because they are on the wire, unread.
- Verified against live Hermes in Fly.io sprite E2E: 0.21.5 and the 0.21.4 floor (2026-09-27, full tier 28/28 each, including live approvals); 0.21.3 (2026-09-21); 0.20.5 in a cloud Linux VM E2E (2026-08-24).
- Drift checker: `bun run drift` (`-- --tag`, `-- --root`) diffs consumed gateway method/event/server-request names against a release; payload shapes need hand-verification.
- E2E credentials: the provider key passes via child environment (`OPENROUTER_API_KEY`); the profile secret scope overlays `os.environ`, so no `<home>/.env` is written.

The agent we wrap; we build on its `tui_gateway`, not its own ACP adapter.

- `tui_gateway/server.py` — JSON-RPC dispatcher, the full method/event catalog, `_session_info`, the `_ask`/`_clarify_block`/`_emit_approval_request` bridges onto server requests, `_open_requests` for reconnect snapshots.
- `tui_gateway/server_requests.py` — server→client requests: `{id: "srq-…", method, params: {session_id, …}}` frames answered by a response frame on the same id; `request.cancel {id, method, reason}` withdraws one; `open_requests` on `session.resume`/`session.activate`; since 0.21.4 sent only to a connection that advertised `client.capabilities {server_requests: true}` (`advertise`, `_unanswerable`). Contracts (params/result shapes per method) in `tui_gateway/contracts/server_requests.py`; the whole wire registry in `tui_gateway/contracts/`.
- `tui_gateway/methods_prompt.py` — `prompt.submit`, attachments (`image.attach_bytes`, `file.attach`, `image.detach`; deliberately not rasterizing `pdf.attach`), `clarify.lock` (batch clarify answers, the last lock resolves the request), `approval.respond` (still served, unused here: the response frame resolves the queue entry).
- `tui_gateway/methods_session.py` — `session.create/resume/list/interrupt/steer/redirect/branch/compress/undo/history/usage`; `branch` takes the breakpoint `count`.
- `tui_gateway/methods_config.py`, `methods_complete.py` — `config.set` model/`approval_mode`/`yolo` switching; `model.options` catalog (`refresh` probes providers, stays off). The custom-endpoint lane has two spellings: the catalog advertises one row for the whole lane (`custom`), while a session configured against a named `providers:` entry in config.yaml reports the qualified reference (`custom:<entry>`) in `session.info.provider` and in the catalog's top-level `provider`. `config.set` resolves the bare lane back to the configured entry (observed live on Hermes 0.20.6), which is what lets value ids canonicalize on the catalog's spelling (`src/turn/configOptions.ts`).
- `tui_gateway/methods_tools.py` — `commands.catalog`, `slash.exec` (code 4018 means re-issue on `command.dispatch`), `command.dispatch` answering `exec|plugin|alias|send|skill|prefill`.
- `tui_gateway/server.py` `_get_usage`, `_start_usage_ticker`; `agent/turn_usage.py`, `agent/usage_pricing.py` `normalize_usage` — token usage: running totals per agent, restarted by agent rebuilds (`tools.configure` between turns, `model_switch.py` `_sync_bot_capabilities` at turn start); `prompt`/`total` include cached tokens, while `input` excludes them but falls back to `prompt` while it is zero; a once-a-second `session.usage` ticker stopped before `message.complete`; cache counts reach the wire only as `cache_hit_pct` (the contract's `cache_read`/`cache_write` are never filled).
- `tui_gateway/transport.py`, `ws.py` — ndjson stdio framing and the wire-compatible WebSocket variant.
- `hermes_cli/subcommands/dashboard.py`, `web_server.py` — `hermes serve`; `/api/ws` token auth, `HERMES_BACKEND_READY` sentinel, `HERMES_PARENT_PID` watchdog.
- `ui-tui/src/gatewayClient.ts`, `apps/shared` — Hermes' own TypeScript gateway clients; our client's template.
- `AGENTS.md` (~lines 467-540) — TUI/gateway process model, transport, desktop `hermes serve` fallback behavior.
- `acp_adapter/` — Hermes' own ACP adapter: behavior reference for tool mapping and auth, and the deviations we must not reproduce (chiefly turn errors masked as prose + clean `end_turn`).
- `gateway/platforms/api_server.py` — OpenAI-compatible HTTP server; secondary reference only.

### Terminal entries

The `terminal` tool renders as an ACP terminal entry via the Zed `_meta` convention (the one pi-acp and claude-agent-acp use), not the `terminal/*` client methods: those hand execution to the client, while Hermes runs the command in-process. Emitted unconditionally — without it the output reaches a client only in verbose tool-progress mode, though `payload.result` always carries it. Mappers in `src/turn/mappers.ts`, constants in `src/constants.ts`.

- `tool_call`: carries `content: [{ type: 'terminal', terminalId: <toolCallId> }]` and `_meta.terminal_info { terminal_id, cwd }`. Terminal id == tool call id; `cwd` is the call's `workdir` argument when it names one, else the ACP session cwd (the gateway reports no per-call cwd).
- `tool_call_update`: `_meta.terminal_output { terminal_id, data }` (full output, replace) and `_meta.terminal_exit { terminal_id, exit_code, signal }` (`signal` always null), read from the decoded result (`output`, `exit_code`: `tools/terminal_tool_result.py` `finalize_foreground_result` on success, `tools/terminal_tool.py` `_error_json` and the background-yield branch otherwise). The data falls back so the outcome is never invisible: `output` plus the yield `note`, else the failure envelope's `error`, else the raw text of a result that did not decode (the executor's exception wrapper). No text `content` — the terminal item renders the output — while `rawOutput` and the row's `completed`/`failed` status are unchanged.
- No output deltas: the gateway has no mid-run tool-output event (`tui_gateway/tool_progress.py` `_on_tool_progress` covers output_risk/reasoning/moa/subagent only), so a terminal fills in one frame at completion.
- `exit_code` is `-1` for an executor error and `124` for a timeout; it is null when the command yielded to background, and absent when the result did not decode, in which case `terminal_exit` is omitted rather than invented.
- Replayed history rows (`session/load`) stay plain tool calls: `_history_to_messages` keeps the call but not its result, so a terminal entry would render empty. `process` (background processes) keeps the plain `execute` rendering — different result shape.

## `codex-acp`

- Repo: https://github.com/agentclientprotocol/codex-acp

Architectural template: `index.ts` wiring → `CodexAcpServer` semantics → `CodexEventHandler`/`CodexToolCallMapper` pure mapping → approval/elicitation handlers → snapshot test harness.

## `claude-agent-acp`

- Repo: https://github.com/agentclientprotocol/claude-agent-acp
