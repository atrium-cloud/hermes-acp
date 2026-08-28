# Caveats

Known limitations of the ACP surface, all rooted in the gateway assuming a Hermes-owned frontend (TUI or desktop) rather than an ACP client.

## MCP servers are rejected: the gateway has no per-session MCP

- Cause: `session.create` has no MCP parameter; `mcp.servers.add` mutates profile-global config and reloads the whole gateway, breaking sibling sessions.
- Behavior: `session/new` and `session/fork` reject `mcpServers` with invalid_params; no `mcpCapabilities` is advertised.

## Breakpoint fork is not offered, only head-only fork

- Cause: `session.branch`'s breakpoint `count` uses visible-history units no gateway projection exposes, so a mapped breakpoint would fork at the wrong turn.
- Behavior: fork is head-only; `sessionCapabilities.fork` is a bare `{}` with no breakpoint marker. ACP v2 is standardizing breakpoint fork.

## Steering is not offered

- Cause: ACP v1 has no steering method, and no consumer asks for codex-acp's bespoke extension.
- Behavior: `session.steer` and `session.redirect` stay typed in `src/gateway/types.ts` but unused until the ACP v2 surface lands.

## A mid-turn switch to an expensive model is silently dropped by Hermes

- Cause: a deferred pick skips the expensive-model confirm gate; at next turn start Hermes drops it, emitting only an `error` event with no result channel.
- Behavior: the adapter cannot distinguish this at set time; the drop surfaces as a stderr line and the next `session.info` snaps the option back.

## Unsupported gateway round-trips

- Cause: tools block on frontend-only bridges — `terminal.read`, `preview.read`/`act`, `window.read`, `tour`, `mcp.setup`, `sudo`, `secret` — none with an ACP counterpart.
- Behavior: the adapter never fabricates an answer; the bounded wait expires (worst case 600s for `mcp.setup`), the tool fails, the turn continues.

## Clarify needs a client that supports form elicitation

- Cause: without client `elicitation.form` the question cannot be asked, and inventing an answer would reach the model as user input.
- Behavior: the question is dropped with a stderr line and Hermes' timeout resolves it — unbounded when `clarify_timeout <= 0`.

## Approvals correlate to the most recent tool call, not to a tool id

- Cause: `approval.request` carries no tool id, and two gated tools in one concurrent batch can anchor prompts to each other's row.
- Behavior: prompt content always comes from the approval payload, so only the row anchoring can be wrong, never the action presented.

## session/list only sees this adapter's sessions, and only with a known cwd

- Cause: the gateway stamps rows with a frontend source tag and projects no cwd, while ACP requires `SessionInfo.cwd`.
- Behavior: list serves only this adapter's sessions whose cwd a live record or the `<hermes-home>/hermes-acp/sessions.json` cache vouches for.

## session/list pagination is an offset over a moving list

- Cause: upstream `session.list` has no cursor; each page is a fresh fetch sliced by the last `nextCursor` offset, capped at 1000 rows.
- Behavior: a mid-pagination create or delete can duplicate or skip rows; clients that re-fetch after a mutation see a consistent list.

## A reclaimed live session is only discovered on the next call

- Cause: the gateway reaps idle live sessions on its own; its best-effort `session.reclaimed` event is not consumed.
- Behavior: the next session-scoped call fails loudly with gateway 4001; `session/resume` or `session/load` on the stored id re-subscribes.

## Resuming a session whose turn is still running streams nothing

- Cause: TurnHandlers install per `session/prompt`, so a turn started by another frontend has no event routing on this side.
- Behavior: the resume succeeds but stays silent until the client drives its own prompt; the replay covers only persisted history.
