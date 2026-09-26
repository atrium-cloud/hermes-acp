/**
 * Per-turn stateful event handler: one instance per in-flight `session/prompt`.
 *
 * It owns everything the pure mappers deliberately do not — which tool calls
 * have already been announced, which plan was last sent, whether the client
 * asked to cancel, and the ordering of the `session/update` notifications it
 * emits. Translation itself is delegated to `mappers.ts`.
 *
 * Turn boundary (verified against Hermes 0.21.5): `prompt.submit` returns as
 * soon as the turn is streaming, and a turn that reaches the model ends with
 * exactly one `message.complete` carrying a `status`. Every emit site for our
 * session (`tui_gateway/server.py` _run_prompt_submit, _emit_terminal_turn_error,
 * the compute-host bridge) sets it; the one status-less `message.complete` in
 * the gateway belongs to the subagent-watch mirror, which runs on a different
 * session id and can never reach an ACP turn. Two upstream paths never reach a
 * terminal frame and end on a bare `error` instead: before `message.start`, the
 * cancel-before-agent-ready path; after it, the `@`-context refusal, which
 * returns straight out of the turn body (see GatewayErrorEvent). The second is
 * only distinguishable from a mid-turn diagnostic by the settled `session.info`
 * that the turn thread's `finally` emits — see the `error` and `session.info`
 * cases below.
 */

import type { ClientCapabilities, SessionUpdate } from '@agentclientprotocol/sdk'
import * as acp from '@agentclientprotocol/sdk'

import { APPROVAL_CHOICE_DENY, CLARIFY_ANSWER_FIELD, CLARIFY_TOOL_NAME } from '../constants.js'
import type { HermesGateway } from '../gateway/HermesGatewayClient.js'
import type {
  ApprovalServerRequest,
  ClarifyQuestion,
  ClarifyServerRequest,
  GatewayEvent,
  GatewayServerRequest,
  MessageCompleteStatus,
  NoUsage,
  RequestCancelEvent,
  TodoItem,
  Usage,
} from '../gateway/types.js'
import { isUsage } from '../gateway/types.js'
import {
  agentMessageChunk,
  agentThoughtChunk,
  planFromTodos,
  toolCallComplete,
  toolCallFromComplete,
  toolCallStart,
} from './mappers.js'
import {
  approvalGateResolved,
  approvalGateToolCall,
  approvalGateToolCallId,
  approvalOptions,
  clarifyAnswer,
  clarifyElicitation,
  clientSupportsFormElicitation,
} from './permissions.js'
import type { SessionUpdateSender } from './SessionUpdateSender.js'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** How a turn ended, in gateway terms; the ACP stop reason is the server's call. */
export type TurnResult =
  | { readonly kind: 'completed'; readonly usage?: Usage }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string }

export interface TurnHandlerOptions {
  /** The session's shared update channel, not a private one: see
   * SessionUpdateSender for why ordering demands a single chain. */
  readonly updates: SessionUpdateSender
  readonly hermes: HermesGateway
  /** ACP sessionId (the stored session key): client-bound permission and
   * elicitation requests are correlated to the session by it. */
  readonly sessionId: string
  /** Live gateway session_id: session-scoped gateway calls carry this one,
   * never the ACP id. */
  readonly gatewaySessionId: string
  /** What the client advertised at `initialize`, or null if it advertised
   * nothing. Elicitation is only used against a client that supports it. */
  readonly clientCapabilities: ClientCapabilities | null
  /** The session's working directory, reported as a terminal entry's cwd when
   * a `terminal` call names no `workdir` of its own. */
  readonly cwd: string
}

export class TurnHandler {
  private readonly updates: SessionUpdateSender
  private readonly hermes: HermesGateway
  private readonly sessionId: string
  private readonly gatewaySessionId: string
  private readonly clientCapabilities: ClientCapabilities | null
  private readonly cwd: string
  /** The sender's failure count when this turn started. */
  private readonly failureMark: number

  private readonly completion: Promise<TurnResult>
  private resolveCompletion!: (result: TurnResult) => void
  private settled = false

  /** Cancellation is sticky: once the client asks, the turn ends `cancelled`
   * whatever terminal status the gateway reports (ACP requires the cancelled
   * stop reason for a cancelled prompt). */
  private cancelRequested = false
  /** Whether the agent has begun answering: decides whether an `error` event
   * is terminal on its own (the turn never started) or has to be held. */
  private messageStarted = false
  /** The last `error` message seen after `message.start`, held because the
   * gateway does not say at that point whether the turn survived it. Read only
   * by the settled `session.info` that proves it did not. */
  private heldErrorMessage: string | null = null

  /** tool_ids already announced as `tool_call`, so a repeated `tool.start`
   * cannot open a second row for the same call. */
  private readonly startedToolCallIds = new Set<string>()
  /** Started and not yet completed, oldest first, with the tool name — the
   * only correlation the gateway offers for approvals and clarify, whose
   * payloads carry no tool id of their own. */
  private readonly inFlightToolCalls: { readonly toolCallId: string; readonly name: string }[] = []
  /** Serialized last plan sent, so the todo list riding on both `tool.start`
   * and `tool.complete` is not re-sent unchanged. */
  private lastPlanSignature: string | null = null

  /** Approvals asked of the client and not yet answered toward Hermes, keyed
   * by the queue entry's `request_id`, with the server request carrying it and
   * the gate row this adapter opened for it (null when the approval rides an
   * existing gateway tool call, which the gateway closes itself). */
  private readonly pendingApprovals = new Map<
    string,
    { readonly serverRequestId: string; readonly controller: AbortController; gateToolCallId: string | null }
  >()
  /** Every approval `request_id` already answered or withdrawn, so a turn
   * ending after the user answered cannot answer it a second time — the queue
   * re-sends a request for an entry it still holds, and one entry gets exactly
   * one decision. */
  private readonly answeredApprovals = new Set<string>()
  /** Elicitations in flight, each with the server request it is asking for,
   * so the turn's end or a `request.cancel` can cancel the client's card. */
  private readonly pendingElicitations = new Map<AbortController, string>()
  /** clarify requests already being asked, by server request id. The gateway
   * re-delivers an open clarify to a reconnecting client, and a replay must not
   * open a second card for a question the user is already looking at. */
  private readonly askingClarifyRequests = new Set<string>()
  /** Server requests the gateway withdrew (`request.cancel`): a late answer
   * from the client is dropped rather than written to a request that is gone. */
  private readonly withdrawnServerRequests = new Set<string>()

  constructor(options: TurnHandlerOptions) {
    this.updates = options.updates
    this.hermes = options.hermes
    this.sessionId = options.sessionId
    this.gatewaySessionId = options.gatewaySessionId
    this.clientCapabilities = options.clientCapabilities
    this.cwd = options.cwd
    this.failureMark = options.updates.failureCount()
    this.completion = new Promise<TurnResult>((resolve) => {
      this.resolveCompletion = resolve
    })
  }

  /** Resolves once the terminal `message.complete` has been mapped and every
   * queued `session/update` has been delivered. */
  completed(): Promise<TurnResult> {
    return this.completion
  }

  requestCancel(): void {
    this.cancelRequested = true
  }

  /** Whether the client asked to cancel; read by the server to abort a prompt
   * that is still staging attachments and has not reached Hermes yet. */
  cancelWasRequested(): boolean {
    return this.cancelRequested
  }

  /**
   * End the turn without a terminal frame, for when the ACP connection died:
   * no `message.complete` is coming and the queued updates have nowhere to go,
   * so the pending prompt resolves `cancelled` immediately rather than hanging
   * on a drain that can never complete.
   */
  abandon(): void {
    if (this.settled) {
      return
    }
    // The cancel flag, not just the settled one: an abandoned turn resolves
    // `cancelled`, and the callers that consult the flag before reaching
    // Hermes (a prompt still staging, a command deciding whether to submit)
    // must not start work for a client that is already gone.
    this.cancelRequested = true
    this.settled = true
    this.failPendingClientRequests()
    this.resolveCompletion({ kind: 'cancelled' })
  }

  /**
   * End the turn `failed` without a terminal frame, for when the gateway died
   * under it: the prompt gets a typed error naming the death instead of the
   * bare EOF the process exit would otherwise leave it with.
   */
  fail(message: string): void {
    if (this.settled) {
      return
    }
    this.settle({ kind: 'failed', message })
  }

  /**
   * A blocking prompt from the gateway, addressed to this turn's session. A
   * request that lands in the window between the turn settling and the server
   * clearing the slot still has an agent thread parked on it: an approval is
   * denied rather than dropped, a clarify has no fail-closed answer and is
   * left to Hermes' timeout.
   */
  handleServerRequest(request: GatewayServerRequest): void {
    switch (request.method) {
      case 'approval': {
        if (this.settled) {
          this.respondToApproval(request.params.request_id, request.id, APPROVAL_CHOICE_DENY)
          return
        }
        this.track(this.handleApprovalRequest(request), `approval round-trip for request ${request.id}`)
        return
      }
      case 'clarify': {
        if (this.settled) {
          console.error(`[hermes-agent-acp] dropped clarify ${request.id}: it arrived after the turn ended`)
          return
        }
        this.track(this.handleClarifyRequest(request), `clarify round-trip for request ${request.id}`)
        return
      }
    }
    // A method added to GatewayServerRequest must be routed here on purpose.
    request satisfies never
  }

  handleEvent(event: GatewayEvent): void {
    if (this.settled) {
      // Turn narration with nowhere left to go; teardown has already withdrawn
      // every client-side prompt a `request.cancel` could target.
      return
    }

    switch (event.type) {
      case 'message.delta': {
        const text = event.payload?.text
        if (text !== undefined && text !== '') {
          this.send(agentMessageChunk(text))
        }
        return
      }

      case 'message.interim': {
        // Already-streamed text went out as message.delta; the rest is the
        // only delivery of that commentary (see MessageInterimEvent).
        const text = event.payload?.text
        if (event.payload?.already_streamed !== true && text !== undefined && text !== '') {
          this.send(agentMessageChunk(text))
        }
        return
      }

      case 'thinking.delta':
      case 'reasoning.delta': {
        const text = event.payload?.text
        if (text !== undefined && text !== '') {
          this.send(agentThoughtChunk(text))
        }
        return
      }

      case 'tool.start': {
        if (!this.startedToolCallIds.has(event.payload.tool_id)) {
          this.startedToolCallIds.add(event.payload.tool_id)
          this.inFlightToolCalls.push({ toolCallId: event.payload.tool_id, name: event.payload.name })
          this.send(toolCallStart(event.payload, this.cwd))
        }
        return
      }

      case 'tool.complete': {
        this.dropInFlightToolCall(event.payload.tool_id)
        // With tool progress off the gateway emits only the completion of a
        // call (and always for an edit that rendered a diff), so the whole
        // row is announced from it rather than dropped.
        if (this.startedToolCallIds.has(event.payload.tool_id)) {
          this.send(toolCallComplete(event.payload))
        } else {
          this.startedToolCallIds.add(event.payload.tool_id)
          this.send(toolCallFromComplete(event.payload, this.cwd))
        }
        this.sendPlanIfChanged(event.payload.todos)
        return
      }

      case 'session.usage':
      case 'session.title':
        // Session-scoped, not turn-scoped: HermesAcpServer forwards these on
        // the session's own channel so they still reach the client between
        // turns. Emitting them here too would double-deliver every one that
        // happens to land mid-turn.
        return

      case 'session.info':
        // Also session-scoped — the server has already applied it to the
        // session's mode and config options, and this case emits nothing. It is
        // routed here for the one thing no other event reports: `running: false`
        // means the turn thread has run its `finally` (the turn body in
        // prompt_turn.py, then `_emit_settled_session_info` in
        // session_workdir.py), so no `message.complete` is
        // coming. Paired with an error seen since `message.start`, that error
        // was the turn's ending after all. It cannot promote a diagnostic:
        // `session["running"]` stays true for the whole turn body, so every
        // mid-turn frame reports `running: true`, and every path that does emit
        // `message.complete` emits it before the `finally`, settling the turn
        // first. The lazy workspace-move skeleton carries no `running` at all,
        // hence the strict comparison.
        if (this.heldErrorMessage !== null && event.payload.running === false) {
          this.settle(
            this.cancelRequested ? { kind: 'cancelled' } : { kind: 'failed', message: this.heldErrorMessage },
          )
        }
        return

      case 'message.complete': {
        this.settleFromTerminalFrame(event.payload?.status, event.payload?.error, event.payload?.usage)
        return
      }

      case 'message.start':
        // Marks the start of an assistant message. ACP chunk grouping is done
        // with `messageId`, which this adapter does not yet assign, so the
        // boundary carries no client-visible update of its own.
        this.messageStarted = true
        return

      case 'gateway.ready':
        // Transport-level readiness, consumed by GatewayClient's startup
        // handshake. Nothing about it is session- or turn-scoped.
        return

      case 'request.cancel':
        this.withdrawServerRequest(event.payload)
        return

      case 'error':
        // Before any `message.start` this is the turn's only ending: the
        // pending-agent path emits it and returns (GatewayErrorEvent), and
        // waiting for a terminal frame would wedge the session behind a turn
        // that never ran. After it the event is ambiguous — usually the gateway
        // logging a mid-turn problem it keeps running through, but the
        // `@`-context refusal also returns out of the turn body right after
        // one — so the message is held for the settled `session.info` above to
        // resolve. Last-wins: a turn can log a model-switch diagnostic at its
        // start and then be refused, and the refusal is the ending.
        // HermesAcpServer has already surfaced the message on stderr.
        if (this.messageStarted) {
          this.heldErrorMessage = event.payload?.message ?? 'Hermes ended the turn without a message'
        } else {
          this.settle(
            this.cancelRequested
              ? { kind: 'cancelled' }
              : { kind: 'failed', message: event.payload?.message ?? 'Hermes ended the turn before it started, without a message' },
          )
        }
        return
    }

    // Every case above returns, so a new upstream event type falls through to
    // here — and fails the build, per the exhaustive-switch rule.
    event satisfies never
  }

  private settleFromTerminalFrame(
    status: MessageCompleteStatus | undefined,
    error: string | undefined,
    usage: Usage | NoUsage | undefined,
  ): void {
    if (status === undefined) {
      this.settle({
        kind: 'failed',
        message: 'gateway event mapping: message.complete arrived without a status, so the turn outcome is unknown',
      })
      return
    }

    if (this.cancelRequested) {
      this.settle({ kind: 'cancelled' })
      return
    }

    switch (status) {
      case 'complete':
        this.settle({ kind: 'completed', ...(isUsage(usage) ? { usage } : {}) })
        return
      case 'interrupted':
        this.settle({ kind: 'cancelled' })
        return
      case 'error':
        this.settle({ kind: 'failed', message: error ?? 'Hermes reported a failed turn without an error message' })
        return
    }

    // Unreachable while MessageCompleteStatus matches the verified Hermes: the
    // `satisfies never` makes a new upstream status a compile error here, and
    // settling anyway keeps an unknown one from hanging the prompt forever.
    this.settle({
      kind: 'failed',
      message: `gateway event mapping: unknown message.complete status ${JSON.stringify(status satisfies never)}`,
    })
  }

  // ── Withdrawn requests ────────────────────────────────────────────────────

  /**
   * The gateway took a blocking prompt back (its wait timed out, the turn was
   * interrupted, the session closed): the client's card is cancelled and no
   * answer goes out for it. An approval's gate row closes as failed — the gate
   * ran and nobody allowed it.
   */
  private withdrawServerRequest(payload: RequestCancelEvent['payload']): void {
    this.withdrawnServerRequests.add(payload.id)
    for (const [requestId, pending] of [...this.pendingApprovals]) {
      if (pending.serverRequestId !== payload.id) {
        continue
      }
      this.answeredApprovals.add(requestId)
      this.pendingApprovals.delete(requestId)
      pending.controller.abort()
      if (pending.gateToolCallId !== null) {
        this.send(approvalGateResolved(pending.gateToolCallId, false))
      }
      console.error(`[hermes-agent-acp] approval ${requestId} withdrawn by Hermes (${payload.reason})`)
    }
    for (const [controller, serverRequestId] of this.pendingElicitations) {
      if (serverRequestId === payload.id) {
        controller.abort()
        console.error(`[hermes-agent-acp] clarify ${payload.id} withdrawn by Hermes (${payload.reason})`)
      }
    }
  }

  // ── Approvals ─────────────────────────────────────────────────────────────

  /**
   * `approval` server request → `session/request_permission` → response frame.
   *
   * Every exit denies unless the user picked an allowing option: a client that
   * errors, a connection that closed, an outcome that names an option the
   * adapter never offered, and the turn ending first all resolve to "deny"
   * toward Hermes, promptly, so the parked agent thread is released instead of
   * waiting out the upstream timeout.
   */
  private async handleApprovalRequest(request: ApprovalServerRequest): Promise<void> {
    const payload = request.params
    const requestId = payload.request_id
    if (this.answeredApprovals.has(requestId) || this.pendingApprovals.has(requestId)) {
      // A re-delivery (`open_requests` after a reconnect) carries the same
      // server request id as the original, so an entry this turn already
      // decided or is deciding needs no second prompt and no second frame.
      return
    }
    const { options, unknownChoices } = approvalOptions(payload)
    if (unknownChoices.length > 0) {
      // Not offered and not relayed: upstream approves on every resolved choice
      // that is not "deny", so relaying a string this adapter cannot describe
      // to the user would turn an unknown option into silent consent.
      console.error(
        `[hermes-agent-acp] approval ${requestId} offered choices this adapter cannot present, dropped from the prompt: ${unknownChoices.join(', ')}`,
      )
    }
    if (options.length === 0) {
      console.error(`[hermes-agent-acp] approval ${requestId} offered no presentable choice; denying`)
      this.respondToApproval(requestId, request.id, APPROVAL_CHOICE_DENY)
      return
    }

    const controller = new AbortController()
    const pending = { serverRequestId: request.id, controller, gateToolCallId: null as string | null }
    this.pendingApprovals.set(requestId, pending)

    // A gateway tool call is in flight for every gated tool: `tool.start` is
    // emitted from the executor's pre-execution hook (agent/tool_executor.py),
    // and the approval gate runs inside the tool body that follows. The most
    // recent one is the gated call (see docs/caveats.md for the concurrent-tool
    // limitation). The gate row is the fallback for the one case that breaks —
    // tool progress turned off for the session, where no tool event reaches the
    // client at all.
    const correlated = this.inFlightToolCalls.at(-1)
    if (correlated === undefined) {
      pending.gateToolCallId = approvalGateToolCallId(requestId)
      this.send(approvalGateToolCall(payload, pending.gateToolCallId))
    }
    const toolCallId = correlated?.toolCallId ?? pending.gateToolCallId!

    // Updates are queued and requests are not, so without this drain the
    // permission request could overtake the `tool_call` it references and
    // arrive at a client that has never heard of the tool call id.
    await this.updates.drained()
    if (controller.signal.aborted) {
      // The turn ended during the drain; teardown has already denied and closed
      // the gate row. Prompting now would ask about a settled decision.
      return
    }

    let allowed = false
    let choice = APPROVAL_CHOICE_DENY
    try {
      const response = await this.updates.requestPermission(
        { sessionId: this.sessionId, toolCall: { toolCallId, status: 'pending' }, options: [...options] },
        controller.signal,
      )
      if (response.outcome.outcome === 'selected') {
        const selected = response.outcome.optionId
        if (options.some((option) => option.optionId === selected)) {
          choice = selected
          allowed = selected !== APPROVAL_CHOICE_DENY
        } else {
          console.error(
            `[hermes-agent-acp] client selected permission option ${JSON.stringify(selected)} for approval ${requestId}, which was never offered; denying`,
          )
        }
      }
    } catch (error) {
      // Includes the abort the turn's end fires: either way nobody answered.
      console.error(
        `[hermes-agent-acp] ACP session/request_permission failed for approval ${requestId}: ${describeError(error)}; denying`,
      )
    }

    if (this.answeredApprovals.has(requestId)) {
      // Answered by turn-end teardown while this prompt was open, or withdrawn
      // by Hermes: the decision toward Hermes is made and the gate row is
      // already closed, so a late client answer must change neither.
      return
    }
    if (pending.gateToolCallId !== null) {
      this.send(approvalGateResolved(pending.gateToolCallId, allowed))
    } else if (allowed && !this.settled && this.inFlightToolCalls.some((call) => call.toolCallId === toolCallId)) {
      // The permission request parked the real tool row on `pending`; the
      // gateway only speaks again at `tool.complete`, so the row would sit
      // there for the whole execution. Skipped once the call has completed —
      // an update after that would walk the row backwards.
      this.send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' })
    }
    this.respondToApproval(requestId, request.id, choice)
  }

  /**
   * Answer one approval toward Hermes, at most once. `all` is deliberately left
   * off: `resolve_gateway_approval` would otherwise apply this one answer to
   * every approval queued on the session, including ones the user never saw.
   */
  private respondToApproval(requestId: string, serverRequestId: string, choice: string): void {
    if (this.answeredApprovals.has(requestId)) {
      return
    }
    this.answeredApprovals.add(requestId)
    this.pendingApprovals.delete(requestId)
    if (this.withdrawnServerRequests.has(serverRequestId)) {
      return
    }
    try {
      this.hermes.answerApproval(serverRequestId, { choice })
    } catch (error) {
      // Nothing to recover: the transport is gone and the request with it, and
      // there is no ACP channel to report a notification-shaped failure on.
      console.error(
        `[hermes-agent-acp] gateway transport: could not answer approval ${requestId} (${serverRequestId}): ${describeError(error)}`,
      )
    }
  }

  // ── Clarify ───────────────────────────────────────────────────────────────

  /**
   * `clarify` server request → `elicitation/create` → response frame (one
   * question) or `clarify.lock` per question (a batch).
   *
   * A question is not a permission, so there is no fallback onto a permission
   * prompt and no fail-closed answer: when the client cannot or will not
   * answer, the adapter says nothing and Hermes' own timeout resolves it. An
   * invented answer would reach the model as though the user had typed it.
   */
  private async handleClarifyRequest(request: ClarifyServerRequest): Promise<void> {
    const requestId = request.id
    const payload = request.params
    if (!clientSupportsFormElicitation(this.clientCapabilities)) {
      console.error(
        `[hermes-agent-acp] dropped clarify ${requestId}: the client does not support form elicitation, so Hermes will time the question out`,
      )
      return
    }
    if (this.askingClarifyRequests.has(requestId)) {
      return
    }
    this.askingClarifyRequests.add(requestId)

    try {
      // The gateway emits `clarify`'s tool.start even with tool progress off
      // (`_tool_lifecycle_required_for_ui`), so the question can be tied to the
      // tool row the client is already showing.
      const toolCallId = this.inFlightToolCalls.find((call) => call.name === CLARIFY_TOOL_NAME)?.toolCallId
      await this.updates.drained()

      const questions = payload.questions
      if (questions !== undefined && questions.length > 0) {
        await this.answerClarifyBatch(requestId, questions, payload.answers, toolCallId)
        return
      }

      const question = payload.question
      if (question === undefined || question === '') {
        console.error(`[hermes-agent-acp] dropped clarify ${requestId}: neither a question nor a question list`)
        return
      }
      if (this.settled || this.withdrawnServerRequests.has(requestId)) {
        // Settled or withdrawn during the drain above: teardown has already
        // cancelled every elicitation it knew about, so a card opened now is
        // one nothing will ever abort. Same guard the batch path applies per
        // question.
        console.error(`[hermes-agent-acp] clarify ${requestId} abandoned: the turn ended or Hermes withdrew it`)
        return
      }

      const answer = await this.askClarify(requestId, {
        sessionId: this.sessionId,
        question,
        choices: payload.choices,
        multiSelect: payload.multi_select === true,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
      })
      if (answer === null) {
        console.error(`[hermes-agent-acp] clarify ${requestId} went unanswered by the client; leaving it to Hermes' timeout`)
        return
      }
      if (this.settled || this.withdrawnServerRequests.has(requestId)) {
        console.error(
          `[hermes-agent-acp] clarify ${requestId} answer arrived after the turn ended or Hermes withdrew the question; dropping it`,
        )
        return
      }
      try {
        this.hermes.answerClarify(requestId, { answer })
      } catch (error) {
        console.error(
          `[hermes-agent-acp] gateway transport: could not answer clarify ${requestId}: ${describeError(error)}`,
        )
      }
    } finally {
      this.askingClarifyRequests.delete(requestId)
    }
  }

  /**
   * Batch clarify locks one answer per `qid` and only releases the agent thread
   * once every question is answered, so the questions are asked one at a time
   * and the first unanswered one ends the batch: continuing would lock answers
   * for a form the user has already walked away from.
   */
  private async answerClarifyBatch(
    requestId: string,
    questions: readonly ClarifyQuestion[],
    alreadyAnswered: Record<string, string> | undefined,
    toolCallId: string | undefined,
  ): Promise<void> {
    for (const question of questions) {
      // Replay state: the gateway echoes answers locked before a reconnect.
      if (alreadyAnswered !== undefined && Object.hasOwn(alreadyAnswered, question.qid)) {
        continue
      }
      if (this.settled || this.withdrawnServerRequests.has(requestId)) {
        console.error(`[hermes-agent-acp] clarify ${requestId} abandoned mid-batch: the turn ended or Hermes withdrew it`)
        return
      }
      const answer = await this.askClarify(requestId, {
        sessionId: this.sessionId,
        question: question.question,
        choices: question.choices,
        multiSelect: question.multi_select === true,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
      })
      if (answer === null) {
        console.error(
          `[hermes-agent-acp] clarify ${requestId} question ${question.qid} went unanswered by the client; abandoning the remaining questions`,
        )
        return
      }
      if (this.settled || this.withdrawnServerRequests.has(requestId)) {
        // Answered after the turn ended or the question was withdrawn: locking
        // it would record a decision for a turn nobody is watching, and
        // upstream has already expired the card.
        console.error(
          `[hermes-agent-acp] clarify ${requestId} answer for question ${question.qid} arrived after the turn ended or Hermes withdrew the question; dropping it`,
        )
        return
      }
      await this.lockClarifyAnswer(requestId, question.qid, answer)
    }
  }

  /** Ask one question; null means the client declined, cancelled, errored, or
   * accepted a form with the answer field left empty. */
  private async askClarify(
    serverRequestId: string,
    request: Parameters<typeof clarifyElicitation>[0],
  ): Promise<string | null> {
    const controller = new AbortController()
    this.pendingElicitations.set(controller, serverRequestId)
    try {
      const response = await this.updates.createElicitation(clarifyElicitation(request), controller.signal)
      if (!acp.CreateElicitationResponse.isAccept(response)) {
        return null
      }
      const content = response.content
      return clarifyAnswer(content === null || content === undefined ? undefined : content[CLARIFY_ANSWER_FIELD])
    } catch (error) {
      console.error(`[hermes-agent-acp] ACP elicitation/create failed: ${describeError(error)}`)
      return null
    } finally {
      this.pendingElicitations.delete(controller)
    }
  }

  private async lockClarifyAnswer(requestId: string, questionId: string, answer: string): Promise<void> {
    try {
      const result = await this.hermes.clarifyLock({ request_id: requestId, question_id: questionId, answer })
      if (result.status === 'expired') {
        // Upstream tolerates a late answer rather than erroring on it; the
        // question is gone and the agent thread has already moved on.
        console.error(`[hermes-agent-acp] clarify ${requestId} had already expired when the client's answer arrived`)
      }
    } catch (error) {
      console.error(
        `[hermes-agent-acp] gateway method clarify.lock failed for request ${requestId}: ${describeError(error)}`,
      )
    }
  }

  // ── Turn-end teardown ─────────────────────────────────────────────────────

  /**
   * The turn is over and nobody is watching its prompts. Every unanswered
   * approval is denied toward Hermes and its client-side request cancelled;
   * elicitations are only cancelled, because a question has no fail-closed
   * answer to send (see handleClarifyRequest).
   */
  private failPendingClientRequests(): void {
    for (const [requestId, pending] of [...this.pendingApprovals]) {
      pending.controller.abort()
      // Closed here rather than from the prompt's own path, so the row is
      // resolved before `settle` drains the channel — a tool call left pending
      // past the end of its turn is a spinner the client never clears.
      if (pending.gateToolCallId !== null) {
        this.send(approvalGateResolved(pending.gateToolCallId, false))
      }
      this.respondToApproval(requestId, pending.serverRequestId, APPROVAL_CHOICE_DENY)
    }
    for (const controller of this.pendingElicitations.keys()) {
      controller.abort()
    }
  }

  private dropInFlightToolCall(toolCallId: string): void {
    const index = this.inFlightToolCalls.findIndex((call) => call.toolCallId === toolCallId)
    if (index >= 0) {
      this.inFlightToolCalls.splice(index, 1)
    }
  }

  /**
   * Observe a round-trip that runs outside any ACP request. Its own failure
   * paths are already handled; this is the last resort that keeps a bug in them
   * from becoming an unhandled rejection.
   */
  private track(work: Promise<void>, description: string): void {
    void work.catch((error: unknown) => {
      console.error(`[hermes-agent-acp] ${description} failed unexpectedly: ${describeError(error)}`)
    })
  }

  private sendPlanIfChanged(todos: readonly TodoItem[] | undefined): void {
    if (todos === undefined) {
      return
    }
    const signature = JSON.stringify(todos)
    if (signature === this.lastPlanSignature) {
      return
    }
    this.lastPlanSignature = signature
    this.send(planFromTodos(todos))
  }

  private send(update: SessionUpdate): void {
    this.updates.send(update)
  }

  private settle(result: TurnResult): void {
    if (this.settled) {
      return
    }
    this.settled = true
    this.failPendingClientRequests()
    // Drain the update channel first: the prompt response must not reach the
    // client before the updates that describe the turn it summarizes.
    void this.updates.drainSince(this.failureMark).then((deliveryFailure) => {
      this.resolveCompletion(deliveryFailure === null ? result : { kind: 'failed', message: deliveryFailure })
    })
  }
}
