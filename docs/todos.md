# hermes-agent-acp roadmap

Purpose: expose Hermes Agent as a clean ACP v1 agent by building on its `tui_gateway` JSON-RPC backend instead of its defective `hermes acp` adapter. Retire once Hermes adopts current ACP schemas upstream.

Layering (mirrors codex-acp): `index.ts` transport → `HermesAcpServer` ACP semantics (`src/session/sessionSetup.ts` establishment) → gateway client (`src/gateway/`) → typed JSON-RPC over the gateway WebSocket.

## 1. Capability-gated session lifecycle

One id namespace: the ACP sessionId is the stored session key — except a resumed compressed-away parent, which answers under the requested id with the continuation tip as `storedKey`. A `liveIndex` maps live 8-hex gateway ids to records — `src/session/sessionSetup.ts`.

## 2. Fork

Breakpoint fork, steering, and MCP passthrough were evaluated and deliberately not built; rationale in docs/caveats.md.

## 3. Quality and integration

- [ ] E2E outcomes: run the tier on a cloud Linux VM and record the live model-switch checks and half-dead-client characterization; the hang shape decides whether a write timeout is needed.

## Known limits

- Mode selection: `HERMES_ACP_MODE` = `serve` (default) | `attach`; see `src/constants.ts` for the related env vars. A stdio spawn mode (`python -m tui_gateway.entry`) was removed before the first release: it doubled the transport code for a path nothing verified, and serve covers the managed case.
- The gateway is an internal Hermes API with no compat promise; upgrades need re-verification (`bun run drift`, then the hand-verification worklist it prints).
- No transport mode has passed against a real client end-to-end yet (section 3 E2E is open); checkboxes track implementation plus unit coverage.
- No cache token breakdown in `PromptResponse.usage`: Hermes tracks cache reads and writes, but the gateway's usage payload carries only a rounded `cache_hit_pct`, so `inputTokens` counts cached and uncached input together and `cachedRead/WriteTokens` stay unset.
- Per-turn usage misses one case: when a "Bot Chat" session's agent is rebuilt at turn start and the turn's totals outgrow the old ones, the turn is undercounted.
- No fs proxying and no client-side ACP `terminal/*` methods planned: Hermes does its own file IO and command execution in-process, like Codex. A `terminal` tool call still renders as a terminal entry, over the `_meta` side channel rather than those methods (see Delivered).

## Deferred simplifications

Flagged against codex-acp/claude-agent-acp in the pre-release review (2026-08-28); each needs an answer before it is a code change.

- [ ] `SessionStore`/`CommandExecutionContext` context bags exist so `sessionSetup.ts` and `commandExecution.ts` can be free functions; codex-acp keeps the same work as methods. Revisit if a third bag appears.
- [ ] `SessionUpdateSender` serializes notifications itself; the SDK already serializes wire writes in call order (`sendWireMessage`), so the queue may be reducible to failure counting plus `drainSince`.

## Exit criteria

Hermes upstream ships an ACP adapter on a current schema generation with correct turn-error reporting (failures as protocol errors, never prose + `end_turn`) and gateway-backed sessions. Then archive this repo.

## Delivered

- [x] Gateway JSON-RPC client: ndjson framing, request correlation, event dispatch, typed wrappers — `src/gateway/GatewayClient.ts` + `HermesGatewayClient.ts`.
- [x] Managed serve mode (default): spawn `hermes serve`, connect over WebSocket with `HERMES_BACKEND_READY` discovery and minted `?token=` auth.
- [x] Attach mode: connect to an already-running gateway over WebSocket, selected via env/flag.
- [x] Startup handshake: wait for `gateway.ready`, fail fast on child death or timeout.
- [x] Clean teardown: SIGTERM→SIGKILL on close plus the `HERMES_PARENT_PID` watchdog, so no orphaned gateways.
- [x] Hand-written gateway types pinned to a Hermes version as the compile-time tripwire — `src/gateway/types.ts`.
- [x] `initialize`: honest capabilities only, each advertised in the change that implements it; pinned by `initialize.test.ts`.
- [x] Auth (`src/auth.ts`): provider-slug agent method while `model.options` reports `authenticated`, plus terminal `hermes-setup`. Credentials never travel over ACP.
- [x] `session/new`: `session.create` with validated absolute cwd; MCP servers rejected fast (docs/caveats.md).
- [x] `session/prompt`: `prompt.submit`, stream to turn end, real stop reasons — terminal errors become JSON-RPC errors, never false `end_turn`.
- [x] `session/cancel`: `session.interrupt` with a sticky cancel flag.
- [x] Streaming translation: stateful per-turn `src/turn/TurnHandler.ts` plus pure `src/turn/mappers.ts`, exhaustive switch with no `default`. Cancelled todos dropped, never mapped to `completed`.
- [x] Permissions: the `approval` server request → `session/request_permission` → response frame, fail-closed to `"deny"` exactly once; the `clarify` server request → elicitation, never auto-answered — Hermes' timeout resolves it (`src/turn/permissions.ts`). `request.cancel` withdraws the client-side card; unsupported server requests (`sudo`, `secret`, GUI reads, …) are refused with JSON-RPC method-not-found. Ported to the 0.21.3 wire on 2026-09-21.
- [x] Terminal entries: a `terminal` tool call renders as an ACP terminal over the Zed `_meta` convention (`terminal_info`/`terminal_output`/`terminal_exit`, terminal id == tool call id), which also puts the command's output on the wire outside verbose tool-progress mode. Replayed history rows stay plain, `process` keeps the plain `execute` rendering — docs/refs.md.
- [x] Token usage: `PromptResponse.usage` is the turn's own share, the difference of Hermes' running `prompt`/`completion`/`total` counters across the turn, restarted when Hermes rebuilds the agent; the `usage_update` context gauge follows `session.usage` ticks and the final `message.complete`, which is the only report for a one-call turn. Verified live 2026-09-26.
- [x] Model selection as `configOptions`: `model` select applied via `config.set` (the provider rides in the value's flags) plus a global `approval_mode` select — `src/turn/configOptions.ts`.
- [x] Model-switch hardening: bogus ids surface gateway 5001 verbatim; deferred and expensive-model paths covered in `src/__tests__/sessionConfig.test.ts`.
- [x] Modes: `default`/`dont_ask` via `config.set {key: "yolo", scope: "session"}`; current mode is the gateway's effective `yolo` state. No `accept_edits`: gateway Hermes never prompts for edits.
- [x] Slash commands: `commands.catalog` snapshot sent as `available_commands_update`; recognized commands routed to `slash.exec`/`command.dispatch` (4018 is the reroute signal) — `src/turn/commands.ts`.
- [x] Prompt content (`src/turn/promptContent.ts`): images via `image.attach_bytes` with `image.detach` rollback; everything else via `file.attach` `@file:` refs. Audio rejected.
- [x] `session/list`: bounded fetch filtered adapter-side (source tag, known cwd, client cwd), paged by decimal-offset cursor; cwd cache `src/session/sessionDirectory.ts`.
- [x] `session/resume` and `session/load`: one shared `resumeSession` flow; load replays history synchronously before responding (codex-acp's order).
- [x] `session/close` and `session/delete`: close abandons in-flight turns (`cancelled`, never hangs); a `closing` flag refuses mid-teardown work. Delete handles stored ids, tracked or not.
- [x] Note: gateway sessions and old `hermes acp` sessions are different state.db rows; old-adapter sessions never appear (docs/caveats.md).
- [x] Fork, head-only (stopgap): first-class `session/fork` via `session.branch` with no `count`; bare `{}` capability, no breakpoint marker. Transcript replay happens via `session/load` on the child.
- [x] Snapshot test harness modeled on codex-acp's: scripted gateway events in, recorded ACP transcript out.
- [x] E2E harness (`src/__tests__/e2e/`): drives the BUILT `dist/index.js` as a real ACP client against a scratch `HERMES_HOME`; gated on `RUN_HERMES_E2E=true`, key via child environment only.
- [x] Sprite e2e automation (`scripts/e2eSprite.ts`, `bun run test:e2e:sprite`): runs the live tier in an ephemeral Fly.io sprite (gated on `sprite` on PATH + `OPENROUTER_API_KEY`), installs the pinned Hermes via uv, saves git-ignored evidence to `e2e-evidence/<ts>-<tag>/` with a scrubbed `output.log` and per-step `summary.json`. Verified green against Hermes 0.20.6 (21/21) on 2026-09-12.
- [x] No runtime Hermes version gate: like codex-acp and claude-agent-acp, Hermes is an external runtime dependency (0.21.3 and above, docs/refs.md + `bun run drift`), not a check. The two-channel version/contract floor and `HERMES_ACP_SKIP_VERSION_CHECK` were removed 2026-08-29.
- [x] Distribution: one `hermes-agent-acp.zip` (the `hermes-agent-acp` executable, a hashbang bundle, plus LICENSE and NOTICE) on GitHub Releases, no npm. Needs Node 22+ on PATH and Hermes 0.21.3+.
- [x] CI (`.github/workflows/ci.yml`): typecheck, unit tests, build, `--version` smoke, `bun run package`.
- [x] Release: `scripts/release.sh [patch|minor|major|X.Y.Z] [--dry-run] [--push]` bumps, tags and pushes; `release.yml` packages and attaches the zip with `docs/changelogs/<tag>.md` as the body.
- [x] Pre-commit hook (`.githooks/pre-commit`, installed via `core.hooksPath` by the `prepare` script): typecheck, unit tests, build, `--version` smoke.
