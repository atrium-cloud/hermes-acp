/**
 * Slash commands: the execution half.
 *
 * The pure half (catalog projection, invocation parsing) lives in commands.ts.
 * This half needs the gateway and the session's update channel, so it takes a
 * CommandExecutionContext — the pieces of HermesAcpServer these functions
 * touch, including a `runPrompt` callback for the command results that submit a
 * real turn (`send`, `skill`). Kept out of HermesAcpServer to hold that class
 * under the module size limit.
 */

import type { ClientCapabilities, ContentBlock, PromptResponse } from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'

import { COMMAND_PREFIX, GATEWAY_CODE_USE_COMMAND_DISPATCH } from '../constants.js'
import { gatewayMethodError } from '../errors.js'
import { GatewayRpcError } from '../gateway/GatewayClient.js'
import type { HermesGateway } from '../gateway/HermesGatewayClient.js'
import type { CommandDispatchResult, SlashExecResult } from '../gateway/types.js'
import type { SessionDirectory } from '../session/sessionDirectory.js'
import type { SessionRecord } from '../session/sessionSetup.js'
import type { CommandInvocation } from './commands.js'
import { agentMessageChunk } from './mappers.js'
import { TurnHandler } from './TurnHandler.js'

/** A resolved command that is not an alias hop (aliases are followed internally). */
type ResolvedCommandResult = Exclude<SlashExecResult, { readonly type: 'alias' }>

/** The slice of HermesAcpServer that command execution reaches into. */
export interface CommandExecutionContext {
  readonly hermes: HermesGateway
  readonly clientCapabilities: ClientCapabilities | null
  readonly sessionDirectory: SessionDirectory
  readonly runPrompt: (session: SessionRecord, blocks: readonly ContentBlock[]) => Promise<PromptResponse>
}

/**
 * Run a recognized slash command, and report it as a turn like any other.
 *
 * Two shapes come back. A command that produced text ends the turn with that
 * text as an agent message; a command whose whole purpose is to compose a
 * prompt (`/retry`, `/queue`, a skill, a bundle) hands back a message that is
 * then submitted through the ordinary turn path, so the user gets real
 * streaming and a real stop reason rather than a summary of what was done.
 */
export async function runCommand(
  ctx: CommandExecutionContext,
  session: SessionRecord,
  invocation: CommandInvocation,
): Promise<PromptResponse> {
  // The session is reserved for the duration of the gateway round-trip:
  // slash.exec can block for a long time (it drives a worker subprocess), and
  // a second prompt slipping in behind it would submit while the command is
  // still deciding whether to submit one itself. Reusing TurnHandler for the
  // reservation is what gives a `session/cancel` arriving mid-command
  // something to mark, and what keeps a command that does turn out to run
  // tools — a quick command shells out — from leaving a pending tool row or
  // an unanswered approval behind: `abandon()` denies and closes them.
  const reservation = new TurnHandler({
    updates: session.updates,
    hermes: ctx.hermes,
    sessionId: session.storedSessionId,
    gatewaySessionId: session.gatewaySessionId,
    clientCapabilities: ctx.clientCapabilities,
  })
  session.activeTurn = reservation
  // Taken before the reservation can relay a tool event of its own, for the
  // same reason TurnHandler takes one: a delivery failure that predates this
  // turn is not its fault, and one during it must not be swallowed.
  const failureMark = session.updates.failureCount()

  let result: ResolvedCommandResult
  // Read before `abandon()`, which marks the reservation cancelled itself.
  let cancelled = false
  try {
    result = await resolveCommand(ctx, session, invocation)
  } finally {
    cancelled = reservation.cancelWasRequested()
    if (session.activeTurn === reservation) {
      session.activeTurn = null
    }
    reservation.abandon()
    ctx.sessionDirectory.touch(session.storedSessionId)
  }

  // Either the user cancelled while the command ran, or the connection went
  // away and `connectionClosed` abandoned the reservation. Neither may lead
  // to a fresh Hermes turn, which is what a `send` result would start.
  if (cancelled) {
    return { stopReason: 'cancelled' }
  }

  if (!('type' in result)) {
    if (result.warning !== undefined && result.warning !== '') {
      console.error(`[hermes-agent-acp] gateway slash.exec warning for ${invocation.canonicalName}: ${result.warning}`)
    }
    return endCommandTurn(session, [result.output], failureMark)
  }

  switch (result.type) {
    case 'exec':
    case 'plugin':
      return endCommandTurn(session, [result.output], failureMark)

    case 'prefill':
      // `/undo` and friends hand back the prompt they popped so the user can
      // edit it. Submitting it here would put words in their mouth, so it is
      // shown and the turn ends; ACP has no way to seed a client's composer.
      return endCommandTurn(session, [result.notice, result.message], failureMark)

    case 'send':
    case 'skill': {
      // `notice` is the system line upstream renders before submitting;
      // `message` is model-facing scaffolding, which is why `display` (when
      // the gateway provides one) is what the user is shown instead.
      const notice = result.type === 'send' ? result.notice : undefined
      for (const line of [notice, result.display]) {
        if (line !== undefined && line !== '') {
          session.updates.send(agentMessageChunk(line))
        }
      }
      return await ctx.runPrompt(session, [{ type: 'text', text: result.message }])
    }
  }

  throw RequestError.internalError(
    undefined,
    `ACP session/prompt: unhandled command result ${JSON.stringify(result satisfies never)}`,
  )
}

/**
 * Send a command's output as an agent message and close the turn.
 *
 * The updates are drained before answering so the client has the output in
 * hand when the prompt resolves — a stop reason that arrives before the text
 * it describes reads as an empty turn — and a delivery failure fails the
 * command turn like any other (SessionUpdateSender.drainSince).
 */
async function endCommandTurn(
  session: SessionRecord,
  parts: readonly (string | undefined)[],
  failureMark: number,
): Promise<PromptResponse> {
  for (const part of parts) {
    if (part !== undefined && part !== '') {
      session.updates.send(agentMessageChunk(part))
    }
  }
  const deliveryFailure = await session.updates.drainSince(failureMark)
  if (deliveryFailure !== null) {
    throw RequestError.internalError(undefined, `ACP session/prompt: ${deliveryFailure} during the command turn`)
  }
  return { stopReason: 'end_turn' }
}

/**
 * Execute a command, following at most one alias hop.
 *
 * `slash.exec` is the entry point for everything: it runs direct commands
 * itself and reroutes pending-input commands and skill bundles to
 * `command.dispatch` internally. The two cases it refuses — skill commands
 * and `/snapshot restore|rewind` — come back as gateway code 4018 telling the caller
 * to use `command.dispatch`, which is what that branch does. Any other
 * gateway failure is a real failure and surfaces as a protocol error.
 */
async function resolveCommand(
  ctx: CommandExecutionContext,
  session: SessionRecord,
  invocation: CommandInvocation,
): Promise<ResolvedCommandResult> {
  let result: SlashExecResult
  try {
    result = await ctx.hermes.slashExec({
      session_id: session.gatewaySessionId,
      command: invocation.commandLine,
    })
  } catch (error) {
    if (!(error instanceof GatewayRpcError) || error.code !== GATEWAY_CODE_USE_COMMAND_DISPATCH) {
      throw gatewayMethodError('slash.exec', error)
    }
    result = await dispatchCommand(ctx, session, invocation.canonicalName, invocation.argument)
  }

  if (!('type' in result) || result.type !== 'alias') {
    return result
  }

  // `command.dispatch` resolves aliases itself, so a target that aliases
  // again is a cycle in the user's quick_commands config, not something to
  // keep chasing.
  const followed = await dispatchCommand(ctx, session, result.target, invocation.argument)
  if (followed.type === 'alias') {
    throw RequestError.internalError(
      undefined,
      `ACP session/prompt: command ${invocation.canonicalName} aliases through ${result.target} to another alias (${followed.target})`,
    )
  }
  return followed
}

/**
 * One `command.dispatch` call. `target` may carry its own arguments (a
 * quick-command alias is a whole command line), which take precedence over
 * the invocation's — the alias author wrote them deliberately.
 */
async function dispatchCommand(
  ctx: CommandExecutionContext,
  session: SessionRecord,
  target: string,
  argument: string,
): Promise<CommandDispatchResult> {
  const line = target.startsWith(COMMAND_PREFIX) ? target.slice(COMMAND_PREFIX.length) : target
  const name = line.split(/\s+/)[0] ?? line
  const inlineArgument = line.slice(name.length).trim()
  try {
    return await ctx.hermes.commandDispatch({
      name,
      arg: inlineArgument === '' ? argument : inlineArgument,
      session_id: session.gatewaySessionId,
    })
  } catch (error) {
    throw gatewayMethodError('command.dispatch', error)
  }
}
