/**
 * The one `session/update` channel for an ACP session.
 *
 * Everything client-bound for a session goes through here — turn events via
 * TurnHandler, and the session-scoped events (title, usage) that arrive
 * whether or not a turn is running. A single chain per session is what makes
 * ordering well-defined: a usage update that lands mid-turn cannot overtake
 * the message chunks that preceded it, which two independent queues would
 * allow.
 *
 * The client connection is captured once at `session/new` and lives as long as
 * the connection does; `close()` is how the adapter stops writing to a
 * connection that has gone away.
 *
 * It also owns the session's client-bound *requests* (permission prompts,
 * elicitations), because it owns the AgentContext they travel on. Those do not
 * ride the notification queue — a request cannot be fire-and-forget — so a
 * caller that needs the client to have received an update first drains the
 * queue before asking. Both fail closed against a connection that has gone
 * away: no user can answer a prompt nobody received.
 */

import type {
  AgentContext,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk'
import * as acp from '@agentclientprotocol/sdk'

/**
 * Settle locally when the signal aborts.
 *
 * ACP cancellation is cooperative: aborting only sends `$/cancel_request` and
 * leaves the promise waiting on a peer that may never answer (SDK `jsonrpc.js`
 * `sendRequest`). A caller that abandons a prompt therefore needs its own
 * outcome, or it waits out a client that ignores the cancel — and would act on
 * that client's late answer when it finally arrives.
 */
function abortable<T>(response: Promise<T>, signal: AbortSignal, whenAborted: T): Promise<T> {
  // The peer's eventual answer is deliberately discarded, but its rejection
  // still has to be observed or it surfaces as an unhandled rejection.
  void response.catch(() => undefined)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      resolve(whenAborted)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    response.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

export class SessionUpdateSender {
  private readonly sessionId: string
  private readonly client: AgentContext

  /** Serializes notifications so the client observes them in gateway order. */
  private queue: Promise<void> = Promise.resolve()
  private closed = false

  /** Delivery failures so far. A turn captures this count when it starts and
   * compares at the end, so a failure that predates the turn is not blamed on
   * it and a failure during it is not swallowed. */
  private failures = 0
  private lastFailure: string | null = null

  constructor(sessionId: string, client: AgentContext) {
    this.sessionId = sessionId
    this.client = client
  }

  send(update: SessionUpdate): void {
    if (this.closed) {
      return
    }
    this.queue = this.queue
      .then(async () => {
        // Re-checked inside the chain: the connection can close between the
        // enqueue and the turn of this link.
        if (this.closed) {
          return
        }
        await this.client.notify(acp.methods.client.session.update, { sessionId: this.sessionId, update })
      })
      .catch((error: unknown) => {
        // Recorded rather than rethrown: an unobserved rejection here would
        // take the process down over a client that merely hung up. The turn
        // reads the count and reports the failure as its outcome.
        this.failures += 1
        this.lastFailure = error instanceof Error ? error.message : String(error)
      })
  }

  /**
   * `session/request_permission`. A closed connection or an aborted signal
   * resolves `cancelled`, which every caller maps to a denial — the same
   * outcome as a user dismissing the prompt.
   */
  async requestPermission(
    params: RequestPermissionRequest,
    cancellationSignal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (this.closed || cancellationSignal.aborted) {
      return { outcome: { outcome: 'cancelled' } }
    }
    return abortable(
      this.client.request(acp.methods.client.session.requestPermission, params, { cancellationSignal }),
      cancellationSignal,
      { outcome: { outcome: 'cancelled' } },
    )
  }

  /**
   * `elicitation/create`. A closed connection or an aborted signal resolves
   * `cancel`, which callers treat as "no answer" — Hermes times the question
   * out server-side rather than receiving one this adapter made up.
   */
  async createElicitation(
    params: CreateElicitationRequest,
    cancellationSignal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    if (this.closed || cancellationSignal.aborted) {
      return { action: 'cancel' }
    }
    return abortable(
      this.client.request(acp.methods.client.elicitation.create, params, { cancellationSignal }),
      cancellationSignal,
      { action: 'cancel' },
    )
  }

  /** A mark for `drainSince`: the failures recorded so far, so a failure that
   * predates the caller's own updates is not charged to them. */
  failureCount(): number {
    return this.failures
  }

  /** Resolves once every update enqueued before this call has been delivered
   * (or has failed and been recorded). */
  drained(): Promise<void> {
    return this.queue
  }

  /**
   * Drain, then report the delivery failure since `mark` (or null). The one
   * protocol every turn-shaped caller ends with: an update the client never
   * received invalidates the transcript it would otherwise take at face value,
   * so a turn, a command turn, and a history replay all fail on it rather than
   * report a clean outcome.
   */
  async drainSince(mark: number): Promise<string | null> {
    await this.queue
    if (this.failures <= mark) {
      return null
    }
    return `ACP session/update delivery failed: ${this.lastFailure ?? 'unknown error'}`
  }

  /** Stop writing: the ACP connection is gone. */
  close(): void {
    this.closed = true
  }
}
