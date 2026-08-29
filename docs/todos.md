# hermes-agent-acp roadmap

Purpose: expose Hermes Agent as a clean ACP v1 agent by building on its `tui_gateway` JSON-RPC backend instead of its defective `hermes acp` adapter. Retire once Hermes adopts current ACP schemas upstream.

Layering (mirrors codex-acp): `index.ts` transport → `HermesAcpServer` ACP semantics (`src/session/sessionSetup.ts` establishment) → gateway client (`src/gateway/`) → typed JSON-RPC over the gateway WebSocket.

## 1. Transport and child lifecycle

- [x] Gateway JSON-RPC client: ndjson framing, request correlation, event dispatch, typed wrappers — `src/gateway/GatewayClient.ts` + `HermesGatewayClient.ts`.
- [x] Managed serve mode (default): spawn `hermes serve`, connect over WebSocket with `HERMES_BACKEND_READY` discovery and minted `?token=` auth.
- [x] Attach mode: connect to an already-running gateway over WebSocket, selected via env/flag.
- [x] Startup handshake: wait for `gateway.ready`, fail fast on child death or timeout.
- [x] Clean teardown: SIGTERM→SIGKILL on close plus the `HERMES_PARENT_PID` watchdog, so no orphaned gateways.
- [x] Hand-written gateway types pinned to a Hermes version as the compile-time tripwire — `src/gateway/types.ts`.

## 2. Stable ACP v1 baseline

- [x] `initialize`: honest capabilities only, each advertised in the change that implements it; pinned by `initialize.test.ts`.
- [x] Auth (`src/auth.ts`): provider-slug agent method while `model.options` reports `authenticated`, plus terminal `hermes-setup`. Credentials never travel over ACP.
- [x] `session/new`: `session.create` with validated absolute cwd; MCP servers rejected fast (docs/caveats.md).
- [x] `session/prompt`: `prompt.submit`, stream to turn end, real stop reasons — terminal errors become JSON-RPC errors, never false `end_turn`.
- [x] `session/cancel`: `session.interrupt` with a sticky cancel flag.
- [x] Streaming translation: stateful per-turn `src/turn/TurnHandler.ts` plus pure `src/turn/mappers.ts`, exhaustive switch with no `default`. Cancelled todos dropped, never mapped to `completed`.
- [x] Permissions: `approval.request` → `session/request_permission`, fail-closed to `"deny"` exactly once; `clarify.request` → elicitation, never auto-answered — Hermes' timeout resolves it (`src/turn/permissions.ts`).
- [x] Model selection as `configOptions`: `model` select applied via `config.set` (the provider rides in the value's flags) plus a global `approval_mode` select — `src/turn/configOptions.ts`.
- [x] Model-switch hardening: bogus ids surface gateway 5001 verbatim; deferred and expensive-model paths covered in `src/__tests__/sessionConfig.test.ts`.
- [x] Modes: `default`/`dont_ask` via `config.set {key: "yolo", scope: "session"}`; current mode is the gateway's effective `yolo` state. No `accept_edits`: gateway Hermes never prompts for edits.
- [x] Slash commands: `commands.catalog` snapshot sent as `available_commands_update`; recognized commands routed to `slash.exec`/`command.dispatch` (4018 is the reroute signal) — `src/turn/commands.ts`.
- [x] Prompt content (`src/turn/promptContent.ts`): images via `image.attach_bytes` with `image.detach` rollback; everything else via `file.attach` `@file:` refs. Audio rejected.

## 3. Capability-gated session lifecycle

One id namespace: the ACP sessionId is the stored session key — except a resumed compressed-away parent, which answers under the requested id with the continuation tip as `storedKey`. A `liveIndex` maps live 8-hex gateway ids to records — `src/session/sessionSetup.ts`.

- [x] `session/list`: bounded fetch filtered adapter-side (source tag, known cwd, client cwd), paged by decimal-offset cursor; cwd cache `src/session/sessionDirectory.ts`.
- [x] `session/resume` and `session/load`: one shared `resumeSession` flow; load replays history synchronously before responding (codex-acp's order).
- [x] `session/close` and `session/delete`: close abandons in-flight turns (`cancelled`, never hangs); a `closing` flag refuses mid-teardown work. Delete handles stored ids, tracked or not.
- [x] Note: gateway sessions and old `hermes acp` sessions are different state.db rows; old-adapter sessions never appear (docs/caveats.md).

## 4. Fork

- [x] Fork, head-only (stopgap): first-class `session/fork` via `session.branch` with no `count`; bare `{}` capability, no breakpoint marker. Transcript replay happens via `session/load` on the child.

Breakpoint fork, steering, and MCP passthrough were evaluated and deliberately not built; rationale in docs/caveats.md.

## 5. Quality and integration

- [x] Snapshot test harness modeled on codex-acp's: scripted gateway events in, recorded ACP transcript out.
- [x] E2E harness (`src/__tests__/e2e/`): drives the BUILT `dist/index.js` as a real ACP client against a scratch `HERMES_HOME`; gated on `RUN_HERMES_E2E=true`, key via child environment only.
- [ ] E2E outcomes: run the tier on a cloud Linux VM and record the live model-switch checks and half-dead-client characterization; the hang shape decides whether a write timeout is needed.
- [x] No runtime Hermes version gate: like codex-acp and claude-agent-acp, Hermes is an external runtime dependency (0.20.6 and above, docs/refs.md + `bun run drift`), not a check. The two-channel version/contract floor and `HERMES_ACP_SKIP_VERSION_CHECK` were removed 2026-08-29.
- [x] Distribution is GitHub Releases only (no npm): `package.json` stays `private`; release zips carry LICENSE and NOTICE alongside the binary; `#!/usr/bin/env node` hashbang on `src/index.ts`; `package.json` read via static import (not `createRequire`) so `bun build --compile` binaries boot without a filesystem.
- [x] CI (`.github/workflows/ci.yml`): typecheck, unit tests, esbuild bundle `--version` smoke, and a cross-compile of all six binaries on push/PR to main (Bun 1.4.0).
- [x] Release: `scripts/release.sh [patch|minor|major|X.Y.Z] [--dry-run] [--push]` bumps `package.json` (the initial release tags the current version as-is), requires `docs/changelogs/vX.Y.Z.md`, runs the pre-commit gates, commits and annotated-tags; `.github/workflows/release.yml` is tag-triggered (`v*`) and `bundle:all`/`package:all` produce six `bun --compile` binaries (`{x64,arm64}-{linux,darwin,windows}`) attached to the GitHub Release, whose body is `docs/changelogs/<tag>.md` (the workflow fails without it) with generated commit notes appended.
- [x] Pre-commit hook (`.githooks/pre-commit`, installed via `core.hooksPath` by the `prepare` script): typecheck, unit tests, build, `--version` smoke. Binaries are compiled only in CI and the release workflow.

## Known limits

- Mode selection: `HERMES_ACP_MODE` = `serve` (default) | `attach`; see `src/constants.ts` for the related env vars. A stdio spawn mode (`python -m tui_gateway.entry`) was removed before the first release: it doubled the transport code for a path nothing verified, and serve covers the managed case.
- The gateway is an internal Hermes API with no compat promise; upgrades need re-verification (`bun run drift`, then the hand-verification worklist it prints).
- No transport mode has passed against a real client end-to-end yet (section 5 E2E is open); checkboxes track implementation plus unit coverage.
- No fs proxying or ACP terminal methods planned: Hermes does its own file IO and command execution in-process, like Codex.

## Deferred simplifications

Flagged against codex-acp/claude-agent-acp in the pre-release review (2026-08-28); each needs an answer before it is a code change.

- [ ] `SessionStore`/`CommandExecutionContext` context bags exist so `sessionSetup.ts` and `commandExecution.ts` can be free functions; codex-acp keeps the same work as methods. Revisit if a third bag appears.
- [ ] `SessionUpdateSender` serializes notifications itself; the SDK already serializes wire writes in call order (`sendWireMessage`), so the queue may be reducible to failure counting plus `drainSince`.

## Exit criteria

Hermes upstream ships an ACP adapter on current schemas with live model switching, correct turn-error reporting, and event-time tool updates. Then archive this repo.
