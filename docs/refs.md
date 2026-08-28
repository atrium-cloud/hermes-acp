# References

## ACP v1 spec

- Repo: https://github.com/agentclientprotocol/agent-client-protocol
- Schema (latest release): https://github.com/agentclientprotocol/agent-client-protocol/releases/latest/download/schema.json
- Protocol docs: https://agentclientprotocol.com/protocol
- TypeScript SDK: `@agentclientprotocol/sdk` (generated types in `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`)
- `session/fork` is a first-class experimental method in SDK 1.4.0; this adapter implements head-only fork, with no breakpoint marker advertised (docs/todos.md section 4).

## Hermes Agent

- Repo: https://github.com/NousResearch/hermes-agent
- Pinned reference: Hermes 0.20.6 (tag `v2026.8.27`), the version `src/gateway/types.ts` was hand-verified against (payload shapes, method params/results, and turn lifecycle, 2026-08-28). Every bump re-verifies the typed subset, then moves this pin.
- Runtime floor check: `SUPPORTED_HERMES_MIN` and `SUPPORTED_DESKTOP_CONTRACT` (6) in `src/constants.ts`; below either refuses. No upper bound: newer Hermes runs as-is, and `bun run drift` is the guard against upstream changes.
- Verified against live Hermes 0.20.5 in a cloud Linux VM E2E (2026-08-24): contract 6 passes.
- Two channels because only `_session_info` reports versions: `desktop_contract` rides the lazy skeleton (known pre-`session/new`), `version` arrives with full info.
- `HERMES_ACP_SKIP_VERSION_CHECK=1|true` disarms the range check.
- Drift checker: `bun run drift` (`-- --tag`, `-- --root`) diffs consumed gateway method/event names against a release; payload shapes need hand-verification.
- E2E credentials: the provider key passes via child environment (`OPENROUTER_API_KEY`); the profile secret scope overlays `os.environ`, so no `<home>/.env` is written.

The agent we wrap; we build on its `tui_gateway`, not its own ACP adapter.

- `tui_gateway/server.py` — JSON-RPC dispatcher, the full method/event catalog (~156 methods), `_session_info`, `_block()` frontend bridges.
- `tui_gateway/methods_prompt.py` — `prompt.submit`, attachments (`image.attach_bytes`, `file.attach`, `image.detach`; deliberately not rasterizing `pdf.attach`), `clarify.respond`, `approval.respond`.
- `tui_gateway/methods_session.py` — `session.create/resume/list/interrupt/steer/redirect/branch/compress/undo/history/usage`; `branch` takes the breakpoint `count`.
- `tui_gateway/methods_config.py`, `methods_complete.py` — `config.set` model/`approval_mode`/`yolo` switching; `model.options` catalog (`refresh` probes providers, stays off).
- `tui_gateway/methods_tools.py` — `commands.catalog`, `slash.exec` (code 4018 means re-issue on `command.dispatch`), `command.dispatch` answering `exec|plugin|alias|send|skill|prefill`.
- `tui_gateway/transport.py`, `ws.py` — ndjson stdio framing and the wire-compatible WebSocket variant.
- `hermes_cli/subcommands/dashboard.py`, `web_server.py` — `hermes serve`; `/api/ws` token auth, `HERMES_BACKEND_READY` sentinel, `HERMES_PARENT_PID` watchdog.
- `ui-tui/src/gatewayClient.ts`, `apps/shared` — Hermes' own TypeScript gateway clients; our client's template.
- `AGENTS.md` (~lines 467-540) — TUI/gateway process model, transport, desktop `hermes serve` fallback behavior.
- `acp_adapter/` — Hermes' own ACP adapter: behavior reference for tool mapping and auth, and the deviations we must not reproduce.
- `gateway/platforms/api_server.py` — OpenAI-compatible HTTP server; secondary reference only.

## `codex-acp`

- Repo: https://github.com/agentclientprotocol/codex-acp

Architectural template: `index.ts` wiring → `CodexAcpServer` semantics → `CodexEventHandler`/`CodexToolCallMapper` pure mapping → approval/elicitation handlers → snapshot test harness.

## `claude-agent-acp`

- Repo: https://github.com/agentclientprotocol/claude-agent-acp
