import { isAbsolute, resolve as resolvePath } from 'node:path'

import type {
  AgentContext,
  ForkSessionRequest,
  ForkSessionResponse,
  LoadSessionRequest,
  NewSessionRequest,
  NewSessionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'

import {
  CONFIG_KEY_APPROVAL_MODE,
  GATEWAY_SESSION_SOURCE,
  MODEL_OPTIONS_TIMEOUT_MS,
  SESSION_LIST_FETCH_CAP,
} from '../constants.js'
import { gatewayMethodError } from '../errors.js'
import type { HermesGateway } from '../gateway/HermesGatewayClient.js'
import type {
  LazySessionInfo,
  ModelOptionsResult,
  SessionBranchResult,
  SessionCreateResult,
  SessionHistoryResult,
  SessionListResult,
  SessionResumeResult,
  TranscriptMessage,
} from '../gateway/types.js'
import type { CommandCatalog } from '../turn/commands.js'
import { buildCommandCatalog, EMPTY_COMMAND_CATALOG } from '../turn/commands.js'
import type { SessionSettings } from '../turn/configOptions.js'
import {
  buildConfigOptions,
  normalizeApprovalMode,
  sessionModeState,
  settingsFromConfig,
} from '../turn/configOptions.js'
import { historyUpdateFromMessage, sessionTitle } from '../turn/mappers.js'
import { SessionUpdateSender } from '../turn/SessionUpdateSender.js'
import type { TurnHandler } from '../turn/TurnHandler.js'
import type { SessionDirectory } from './sessionDirectory.js'

/**
 * Adapter-side state for one ACP session. Per-turn bookkeeping lives on the
 * TurnHandler in `activeTurn`; this record pins the gateway session, its cwd,
 * the client channel every update for the session travels on, and which turn
 * (if any) is currently streaming into it.
 *
 * Two gateway id namespaces meet here: the STORED session key (what
 * session.list/resume/delete take) and the LIVE 8-hex gateway session_id
 * (what events, history, close, and every session-scoped gateway method
 * carry). The ACP sessionId is the id the client opened the session with —
 * normally the stored key verbatim, but a resume of a compressed-away parent
 * resolves to its continuation tip upstream (methods_session.py ~369) and ACP
 * has no way to hand the client a replacement id, so the record answers under
 * the requested id and keeps the tip as `storedKey`.
 */
export interface SessionRecord {
  /** ACP sessionId — the id the client opened the session with. */
  readonly storedSessionId: string
  /** The gateway's stored session key: the continuation tip `session.resume`
   * resolved to, or `storedSessionId` when no resolution happened. */
  readonly storedKey: string
  /** Live gateway `session_id`; events and session-scoped calls carry this. */
  readonly gatewaySessionId: string
  readonly cwd: string
  /** Ordered `session/update` channel, shared by turn and session events. */
  readonly updates: SessionUpdateSender
  /** The in-flight `session/prompt`, or null when the session is idle. */
  activeTurn: TurnHandler | null
  /** The in-flight `session/prompt` request itself, settled when its response
   * is on its way. Teardown awaits it so a `session/close` (or a gateway
   * death) answers only after the prompt it ended has answered. */
  activePrompt: Promise<unknown> | null
  /** True while `session/close`/`session/delete` teardown is in flight. Set
   * before teardown's first await, so a concurrent prompt is refused rather
   * than installing a turn the teardown would strand; cleared when the
   * gateway close fails and the record stays registered. */
  closing: boolean
  /** True while a `session/fork` of this session is in flight. Set before the
   * `session.branch` round-trip, which upstream services by copying the history
   * AND building the child's agent — long enough for a prompt to arrive, pass
   * the `activeTurn` check, and submit into the history the branch is
   * snapshotting. The one-turn discipline has to cover that window from both
   * sides, so a prompt (or a second fork) is refused while this is set. */
  forking: boolean
  /** Provider/model catalog snapshot taken when the session was opened.
   * `model.options` probes provider endpoints, so it is never called from the
   * event path; only the selected value moves as `session.info` arrives.
   * Empty until that read lands, which is why nothing is emitted while
   * `registering`. */
  modelCatalog: ModelOptionsResult
  /** What the client was last told about mode and config options. A
   * `session.info` that derives to the same settings emits nothing. */
  settings: SessionSettings
  /** True until the open/resume request has finished its gateway reads. The
   * record is registered before them so no `session.info` is dropped, but the
   * client has not been told the session exists yet, so updates are held back
   * and the response carries the merged state instead. */
  registering: boolean
  /** Slash commands advertised for this session, and the table a prompt is
   * matched against. Empty when the catalog read failed — commands are an
   * enhancement, not a precondition for the session. */
  commands: CommandCatalog
}

/**
 * The session table and its auxiliaries, lent by HermesAcpServer to the setup
 * flows below. `records` is keyed by ACP sessionId (the id the client opened
 * the session with); `liveIndex` is how `routeGatewayEvent` — whose events
 * carry the live id — finds the record.
 */
export interface SessionStore {
  readonly records: Map<string, SessionRecord>
  readonly liveIndex: Map<string, string>
  readonly directory: SessionDirectory
  /** Stored ids with a resume/load in flight. The tracked check and the
   * registration in `establishSession` are separated by gateway round-trips,
   * so without this set two concurrent opens of the same id would both miss
   * `records`, both resume on the gateway, and the later registration would
   * overwrite the earlier one. */
  readonly pendingOpens: Set<string>
}

/** A session that has not read `model.options` yet reports no providers; it is
 * never used to build client-bound options, only to hold the field until the
 * read lands (see `registering`). */
const EMPTY_MODEL_CATALOG: ModelOptionsResult = {}

/**
 * The request validation `session/new`, `session/resume`, `session/load`, and
 * `session/fork` share: no MCP passthrough, no additionalDirectories, an
 * absolute cwd.
 */
function validateLifecycleRequest(
  acpMethod: string,
  params: NewSessionRequest | ResumeSessionRequest | LoadSessionRequest | ForkSessionRequest,
): void {
  // Stdio MCP servers have no gating capability in ACP (`mcpCapabilities`
  // only covers http/sse), so a conforming client may legitimately send
  // them. The reject is settled, not provisional: the gateway exposes no
  // per-session MCP registration at all, so the only way to honor these
  // would be to rewrite the user's global Hermes config and re-discover
  // process-wide, disturbing every sibling session (docs/caveats.md).
  if ((params.mcpServers ?? []).length > 0) {
    throw RequestError.invalidParams(
      undefined,
      `ACP ${acpMethod}: MCP passthrough is not implemented by this adapter (see docs/caveats.md)`,
    )
  }
  // Unlike MCP, this field is capability-gated; a conforming client never
  // sends it while `sessionCapabilities.additionalDirectories` is off.
  if (params.additionalDirectories && params.additionalDirectories.length > 0) {
    throw RequestError.invalidParams(
      undefined,
      `ACP ${acpMethod}: additionalDirectories is not implemented by this adapter and the capability is not advertised`,
    )
  }
  // The spec requires an absolute cwd; a relative one would resolve against
  // the gateway process's own directory — a different process entirely in
  // serve/attach mode.
  if (!isAbsolute(params.cwd)) {
    throw RequestError.invalidParams(
      undefined,
      `ACP ${acpMethod}: cwd must be an absolute path, got ${JSON.stringify(params.cwd)}`,
    )
  }
}

/**
 * The `session/new` flow: create the gateway session, run the shared
 * registration tail, and answer with the merged state. The ACP sessionId is
 * the STORED session key, not the live gateway id: `session/list`,
 * `session/resume`, and `session/delete` all speak stored keys, so anchoring
 * the ACP namespace there keeps one identifier end to end.
 */
export async function openSession(
  hermes: HermesGateway,
  store: SessionStore,
  params: NewSessionRequest,
  client: AgentContext,
): Promise<NewSessionResponse> {
  validateLifecycleRequest('session/new', params)

  // The only handling here is naming the subsystem and action that failed:
  // the gateway's code/data ride along and nothing is recovered from.
  let result: SessionCreateResult
  try {
    result = await hermes.sessionCreate({ cwd: params.cwd, source: GATEWAY_SESSION_SOURCE })
  } catch (error) {
    throw gatewayMethodError('session.create', error)
  }

  // `session.create` returns the stored key even though the DB row is lazily
  // created on first prompt (methods_session.py ~128), so it is always there
  // to anchor the ACP sessionId to. A create without it breaks the one
  // sessionId namespace list/resume/delete depend on — a gateway contract
  // violation, not a client error.
  const storedSessionId = result.stored_session_id
  if (storedSessionId === undefined || storedSessionId === '') {
    throw RequestError.internalError(
      undefined,
      'ACP session/new: the gateway session.create response carried no stored_session_id',
    )
  }
  const gatewaySessionId = result.session_id

  // Hermes falls back to the gateway process's own cwd when the requested
  // path does not exist on the gateway host (`_completion_cwd`) and still
  // reports success; a session silently running somewhere the client never
  // asked for is worse than a failed create. Both sides are lexically
  // normalized absolute paths (abspath upstream, resolve here), so string
  // comparison is sound.
  const actualCwd = result.info?.cwd
  if (actualCwd !== undefined && actualCwd !== resolvePath(params.cwd)) {
    await closeQuietly(hermes, gatewaySessionId, `discarding mis-rooted session ${gatewaySessionId}`)
    throw RequestError.invalidParams(
      undefined,
      `ACP session/new: gateway resolved cwd to ${JSON.stringify(actualCwd)} instead of the requested ${JSON.stringify(params.cwd)} (does the directory exist on the gateway host?)`,
    )
  }

  const session = await establishSession(hermes, store, client, {
    acpMethod: 'session/new',
    storedSessionId,
    storedKey: storedSessionId,
    gatewaySessionId,
    cwd: params.cwd,
    info: result.info,
  })

  return {
    sessionId: storedSessionId,
    modes: sessionModeState(session.settings),
    configOptions: buildConfigOptions(session.modelCatalog, session.settings),
  }
}

/**
 * The `session/fork` flow: branch a tracked session's history into a new
 * gateway session, then run the same registration tail `session/new` does and
 * answer with the child's own id and state.
 *
 * Head-only. Upstream `session.branch` takes a `count` that truncates the
 * child's history to the first N visible messages (breakpoint fork), and this
 * adapter deliberately sends none: ACP v1 carries no per-message identity to
 * derive that count from, so the child always starts from the whole parent
 * history (docs/todos.md section 4).
 */
export async function forkSession(
  hermes: HermesGateway,
  store: SessionStore,
  params: ForkSessionRequest,
  client: AgentContext,
): Promise<ForkSessionResponse> {
  validateLifecycleRequest('session/fork', params)

  const parent = store.records.get(params.sessionId)
  if (parent === undefined) {
    throw RequestError.invalidParams(undefined, `ACP session/fork: unknown session ${params.sessionId}`)
  }
  // Same teardown race the prompt guard covers: a fork arriving mid-teardown
  // would branch a gateway session that is being closed, and register a child
  // whose parent stops existing a moment later.
  if (parent.closing) {
    throw RequestError.invalidRequest(
      undefined,
      `ACP session/fork: session ${params.sessionId} is being closed`,
    )
  }
  // The gateway's `session.branch` has no running check of its own (`_sess`
  // waits for the agent build but accepts a session mid-turn), so the adapter's
  // one-turn discipline has to supply it: branching while a turn streams would
  // race the in-flight history write and snapshot a half-written exchange.
  if (parent.activeTurn !== null) {
    throw RequestError.invalidRequest(
      undefined,
      `ACP session/fork: session ${params.sessionId} already has a turn in flight; cancel it before forking`,
    )
  }
  // A second fork of the same parent is refused rather than run: both children
  // would be branched from the same head, and refusing keeps one meaning for
  // "this session is busy" instead of a second concurrency rule to reason about.
  if (parent.forking) {
    throw RequestError.invalidRequest(
      undefined,
      `ACP session/fork: session ${params.sessionId} already has a fork in flight; wait for it to finish before forking again`,
    )
  }
  // The child is rooted at the parent's cwd upstream (`_session_cwd`), so a
  // request naming a different directory is a client bug — the same mis-rooting
  // resume refuses rather than re-rooting the session.
  if (resolvePath(params.cwd) !== resolvePath(parent.cwd)) {
    throw RequestError.invalidParams(
      undefined,
      `ACP session/fork: session ${params.sessionId} is tracked at ${JSON.stringify(parent.cwd)}, not the requested ${JSON.stringify(params.cwd)}`,
    )
  }

  // Claimed synchronously, with no await between the guards above and this
  // line: the branch below is a long round-trip, and a prompt or a second fork
  // arriving inside it must see the claim rather than the state the guards
  // just read. Cleared for every exit, so a failed fork leaves the parent
  // promptable and forkable again.
  parent.forking = true
  try {
    return await forkBranchedSession(hermes, store, parent, params, client)
  } finally {
    parent.forking = false
  }
}

async function forkBranchedSession(
  hermes: HermesGateway,
  store: SessionStore,
  parent: SessionRecord,
  params: ForkSessionRequest,
  client: AgentContext,
): Promise<ForkSessionResponse> {
  let result: SessionBranchResult
  try {
    // An empty `name` leaves the child's title to the gateway's lineage naming
    // (methods_session.py `session.branch`); ACP has no fork title to pass on.
    result = await hermes.sessionBranch({ session_id: parent.gatewaySessionId, name: '' })
  } catch (error) {
    // 4008 ("nothing to branch — send a message first") rides along in the
    // gateway code/data, per the gatewayMethodError convention.
    throw gatewayMethodError('session.branch', error)
  }

  // The stored key anchors the ACP sessionId the same way it does for
  // `session/new`; a branch without one breaks the namespace list/resume/delete
  // depend on, which is a gateway contract violation rather than a client error.
  // The child is already fully built at this point (upstream copies the history
  // and builds its agent before answering), so it is closed rather than left
  // running with no record pointing at it.
  const storedSessionId = result.stored_session_id
  if (storedSessionId === undefined || storedSessionId === '') {
    await closeQuietly(hermes, result.session_id, `discarding branched session ${result.session_id} with no stored_session_id`)
    throw RequestError.internalError(
      undefined,
      'ACP session/fork: the gateway session.branch response carried no stored_session_id',
    )
  }

  // The child is rooted at the parent's LIVE cwd upstream, which can have moved
  // since the parent was opened (a terminal tool settling in a sibling worktree,
  // a project switch, dead-cwd healing) without the adapter being told. Adopting
  // it would register — and persist into the session directory — a brand-new
  // session at a directory it is not running in, the same mis-rooting
  // `session/new` refuses.
  const actualCwd = result.info?.cwd
  if (actualCwd !== undefined && actualCwd !== resolvePath(parent.cwd)) {
    await closeQuietly(hermes, result.session_id, `discarding mis-rooted branched session ${result.session_id}`)
    throw RequestError.invalidParams(
      undefined,
      `ACP session/fork: the gateway branched session ${params.sessionId} at ${JSON.stringify(actualCwd)} instead of its tracked ${JSON.stringify(parent.cwd)}`,
    )
  }

  // `result.messages` — the parent transcript the branch copied into the child —
  // is deliberately not replayed: `ForkSessionResponse` has no replay channel,
  // the client already holds the transcript of the session it forked, and a
  // client that wants the child's own history can `session/load` the id below.
  const session = await establishSession(hermes, store, client, {
    acpMethod: 'session/fork',
    storedSessionId,
    storedKey: storedSessionId,
    gatewaySessionId: result.session_id,
    cwd: parent.cwd,
    info: result.info,
  })

  return {
    sessionId: storedSessionId,
    modes: sessionModeState(session.settings),
    configOptions: buildConfigOptions(session.modelCatalog, session.settings),
  }
}

/** Whether a resume/load replays the transcript before responding. */
export interface ResumeOptions {
  /** 'sync' (session/load) replays history as session/update notifications
   * before the response; 'none' (session/resume) only subscribes. */
  readonly replay: 'none' | 'sync'
}

/**
 * The shared `session/resume` and `session/load` flow. Both subscribe the
 * client to a stored session; load additionally replays the transcript,
 * synchronously and before the response (codex-acp's order — deferred replay
 * is the defect that broke spec-compliant clients upstream).
 *
 * A session this adapter already tracks is not resumed on the gateway again:
 * resume rebuilds the response from the record, and load re-reads the history
 * of the still-live gateway session.
 */
export async function resumeSession(
  hermes: HermesGateway,
  store: SessionStore,
  acpMethod: 'session/resume' | 'session/load',
  params: ResumeSessionRequest | LoadSessionRequest,
  client: AgentContext,
  options: ResumeOptions,
): Promise<ResumeSessionResponse> {
  validateLifecycleRequest(acpMethod, params)

  // Claim the id synchronously, before the first await: the tracked check and
  // the registration below are round-trips apart, and a second resume/load
  // arriving in that window must fail rather than double-open the session.
  if (store.pendingOpens.has(params.sessionId)) {
    throw RequestError.invalidRequest(
      undefined,
      `ACP ${acpMethod}: session ${params.sessionId} already has an open in flight; wait for it before calling ${acpMethod} again`,
    )
  }
  store.pendingOpens.add(params.sessionId)
  try {
    return await resumeSessionOpen(hermes, store, acpMethod, params, client, options)
  } finally {
    store.pendingOpens.delete(params.sessionId)
  }
}

async function resumeSessionOpen(
  hermes: HermesGateway,
  store: SessionStore,
  acpMethod: 'session/resume' | 'session/load',
  params: ResumeSessionRequest | LoadSessionRequest,
  client: AgentContext,
  options: ResumeOptions,
): Promise<ResumeSessionResponse> {
  const tracked = store.records.get(params.sessionId)
  if (tracked !== undefined) {
    // A session being torn down is still registered, but answering from it
    // would replay into a channel the teardown is about to close.
    if (tracked.closing) {
      throw RequestError.invalidRequest(
        undefined,
        `ACP ${acpMethod}: session ${params.sessionId} is being closed; wait for the close to finish before opening it again`,
      )
    }
    // The same mis-rooting guard as the fresh path: the record's cwd is the
    // one the session actually runs at, so a request pointing elsewhere is a
    // client bug, not a re-root.
    if (resolvePath(params.cwd) !== resolvePath(tracked.cwd)) {
      throw RequestError.invalidParams(
        undefined,
        `ACP ${acpMethod}: session ${params.sessionId} is tracked at ${JSON.stringify(tracked.cwd)}, not the requested ${JSON.stringify(params.cwd)}`,
      )
    }
    if (options.replay === 'sync') {
      let history: SessionHistoryResult
      try {
        history = await hermes.sessionHistory(tracked.gatewaySessionId)
      } catch (error) {
        throw gatewayMethodError('session.history', error)
      }
      // The record outlives the response here — the client already owns this
      // session — so a failed replay fails the request without tearing down.
      // No title precedes the chunks: the record does not track one, and a
      // fabricated `session_info_update` would overwrite the client's own.
      await replayHistory(tracked, history.messages, acpMethod)
    }
    // The command list rides the session channel, not the response, and a
    // client re-opening a session it already holds starts from an empty list.
    sendAvailableCommands(tracked)
    return {
      modes: sessionModeState(tracked.settings),
      configOptions: buildConfigOptions(tracked.modelCatalog, tracked.settings),
    }
  }

  let result: SessionResumeResult
  try {
    result = await hermes.sessionResume({
      session_id: params.sessionId,
      omit_messages: options.replay === 'none',
    })
  } catch (error) {
    // 4007 (unknown session) and 4130 (transcript too large) ride along in
    // the gateway code/data, per the gatewayMethodError convention.
    throw gatewayMethodError('session.resume', error)
  }

  // `resumed`/`session_key` are the stored key on every resume path upstream;
  // the requested id already is one, so it is the fallback, never the live id.
  const storedKey = result.resumed ?? result.session_key ?? params.sessionId
  const gatewaySessionId = result.session_id

  // Upstream resolves a compressed-away parent to its continuation tip
  // (methods_session.py ~369) and reuses the tip's already-live session
  // instead of building a new one. Registering that live session again would
  // overwrite the record that owns it and strand its update channel, so the
  // second open is refused — and the gateway session is NOT closed here, the
  // way a failed open's own session would be: it belongs to the other record.
  const owner = store.liveIndex.get(gatewaySessionId)
  if (owner !== undefined) {
    throw RequestError.invalidRequest(
      undefined,
      `ACP ${acpMethod}: session ${params.sessionId} resolves to stored session ${storedKey}, which is already open as session ${owner}; close that session before opening ${params.sessionId}`,
    )
  }

  // The gateway roots a resumed session at its stored cwd, so a mismatch with
  // the requested one means the client is pointing at a different directory
  // than the session belongs to — the same mis-rooting `session/new` fails.
  const actualCwd = result.info?.cwd
  if (actualCwd !== undefined && actualCwd !== resolvePath(params.cwd)) {
    await closeQuietly(hermes, gatewaySessionId, `discarding mis-rooted resumed session ${gatewaySessionId}`)
    throw RequestError.invalidParams(
      undefined,
      `ACP ${acpMethod}: gateway resumed the session at ${JSON.stringify(actualCwd)} instead of the requested ${JSON.stringify(params.cwd)}`,
    )
  }

  // ACP has no way to tell the client the requested id resolved to a different
  // stored key, so the record answers under the REQUESTED id; the tip is kept
  // as `storedKey` for the calls that speak stored keys (session.delete) and
  // for resolving the tip's own session/list row.
  //
  // The unsolicited `session.info` from the cold-path agent build lands inside
  // this registration window, the same as `session/new`'s.
  const session = await establishSession(hermes, store, client, {
    acpMethod,
    storedSessionId: params.sessionId,
    storedKey,
    gatewaySessionId,
    cwd: params.cwd,
    info: result.info,
  })

  if (options.replay === 'sync') {
    // The cold path's lazy info snapshot carries no title (`_lazy_resume_info`,
    // server.py ~8356), so the promised title update is read off `session.list`
    // unless the response's info happened to carry one.
    const infoTitle = result.info?.title
    const title = infoTitle !== undefined && infoTitle !== '' ? infoTitle : await readStoredTitle(hermes, storedKey)
    try {
      await replayHistory(session, result.messages, acpMethod, title)
    } catch (error) {
      // The client was never told this session exists, so the registration
      // and the resumed gateway session both go — same discipline as a failed
      // setup read, not a session left half-subscribed.
      unregister(store, session)
      await closeQuietly(hermes, gatewaySessionId, `discarding resumed session ${gatewaySessionId} whose history replay failed`)
      throw error
    }
  }

  return {
    modes: sessionModeState(session.settings),
    configOptions: buildConfigOptions(session.modelCatalog, session.settings),
  }
}

/**
 * Replay a transcript as ordered `session/update` notifications, title first
 * (codex-acp's order), synchronously — the caller awaits this before
 * responding. A delivery failure aborts the replay loudly: a partial
 * transcript presented as the session's history is the silent-half-replay
 * failure mode, so the channel error fails the request.
 *
 * The `closing` checks bracket the send: the caller's own closing check is
 * separated from this replay by gateway awaits a teardown can complete in,
 * and a closed channel drops updates WITHOUT recording a failure, so without
 * these the request could return success for a session that no longer exists
 * with its transcript silently lost — the same failure mode, one layer down.
 */
async function replayHistory(
  session: SessionRecord,
  messages: readonly TranscriptMessage[],
  acpMethod: string,
  title?: string,
): Promise<void> {
  const failureMark = session.updates.failureCount()
  if (session.closing) {
    throw RequestError.invalidRequest(
      undefined,
      `ACP ${acpMethod}: session ${session.storedSessionId} was closed while its history was being read`,
    )
  }
  if (title !== undefined && title !== '') {
    session.updates.send(sessionTitle(title))
  }
  messages.forEach((row, index) => {
    for (const update of historyUpdateFromMessage(row, index)) {
      session.updates.send(update)
    }
  })
  const deliveryFailure = await session.updates.drainSince(failureMark)
  if (session.closing) {
    // The teardown committed while the replay drained, so the channel close
    // may have swallowed queued updates the failure count cannot see.
    throw RequestError.invalidRequest(
      undefined,
      `ACP ${acpMethod}: session ${session.storedSessionId} was closed during its history replay`,
    )
  }
  if (deliveryFailure !== null) {
    throw RequestError.internalError(undefined, `ACP ${acpMethod}: ${deliveryFailure} during history replay`)
  }
}

/**
 * The title a cold resume's lazy info snapshot does not carry, read from
 * `session.list` — the only upstream surface that projects stored titles.
 *
 * The same degradation call as the command catalog: a load whose title update
 * never arrives is fully functional (the client keeps the title its own
 * session/list already showed), so a failed read is logged and skipped rather
 * than costing the user the session.
 */
async function readStoredTitle(hermes: HermesGateway, storedKey: string): Promise<string | undefined> {
  let result: SessionListResult
  try {
    result = await hermes.sessionList({ limit: SESSION_LIST_FETCH_CAP })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[hermes-agent-acp] gateway method session.list failed while reading the resumed session's title; the replay carries no title: ${message}`)
    return undefined
  }
  const row = result.sessions.find((candidate) => candidate.id === storedKey)
  return row === undefined || row.title === '' ? undefined : row.title
}

interface SessionIdentity {
  /** The ACP method being served, for the errors this tail raises. */
  readonly acpMethod: string
  readonly storedSessionId: string
  readonly storedKey: string
  readonly gatewaySessionId: string
  readonly cwd: string
  /** The create/resume response's info snapshot: provisional settings source
   * and `initialSessionState`'s fallback. A lazy snapshot upstream — partial
   * by contract, and title-less. */
  readonly info: LazySessionInfo | undefined
}

/**
 * The tail `session/new` and `session/resume`/`session/load` share: register
 * the record BEFORE the settings reads (so no `session.info` is dropped — the
 * gateway routes info for unregistered sessions into the void, and the first
 * one, the deferred agent build's, is the only report of a `--yolo`-frozen
 * gateway), read the catalog/approval baseline and the command catalog, merge
 * with any event that landed mid-read, and advertise the commands.
 *
 * The client context is captured here, not at prompt time, so session-scoped
 * events (title, usage) can reach the client between turns.
 */
async function establishSession(
  hermes: HermesGateway,
  store: SessionStore,
  client: AgentContext,
  identity: SessionIdentity,
): Promise<SessionRecord> {
  // The provisional settings are what `initialSessionState` would derive from
  // an empty read: a create response's `info` is partial (a model but neither
  // `yolo` nor `approval_mode`), so those two start at the defaults.
  const provisionalSettings = settingsFromConfig(identity.info?.model ?? '', identity.info?.provider ?? '', '')
  const session: SessionRecord = {
    storedSessionId: identity.storedSessionId,
    storedKey: identity.storedKey,
    gatewaySessionId: identity.gatewaySessionId,
    cwd: identity.cwd,
    updates: new SessionUpdateSender(identity.storedSessionId, client),
    activeTurn: null,
    activePrompt: null,
    closing: false,
    forking: false,
    modelCatalog: EMPTY_MODEL_CATALOG,
    settings: provisionalSettings,
    registering: true,
    commands: EMPTY_COMMAND_CATALOG,
  }
  store.records.set(identity.storedSessionId, session)
  store.liveIndex.set(identity.gatewaySessionId, identity.storedSessionId)

  try {
    const initial = await initialSessionState(hermes, identity.gatewaySessionId, identity.info)
    const commands = await readCommandCatalog(hermes)

    // Merge discipline: the reads are only a baseline, and a `session.info`
    // that landed while they were in flight is strictly fresher, so it wins.
    // `applySessionInfo` always installs a NEW settings object, so an
    // unchanged reference is proof that no event spoke during the window.
    session.modelCatalog = initial.catalog
    if (session.settings === provisionalSettings) {
      session.settings = initial.settings
    }
    session.commands = commands
    session.registering = false
  } catch (error) {
    // This catch owns the whole failure cleanup, whichever read threw: the
    // registration goes (a record pointing at a dead session would accept
    // prompts and route events) and the gateway session is closed (one left
    // open with no record pointing at it would leak on the gateway). Keeping
    // both here, rather than closing inside the reads, means a future read
    // added to this block cannot leak by forgetting its own close.
    unregister(store, session)
    await closeQuietly(hermes, identity.gatewaySessionId, `discarding session ${identity.gatewaySessionId} whose setup failed`)
    throw error
  }

  store.directory.remember(identity.storedSessionId, identity.cwd)
  if (identity.storedKey !== identity.storedSessionId) {
    // session/list lists the tip under its own key, so that row's cwd must
    // resolve too — the record itself answers only under the requested id.
    store.directory.remember(identity.storedKey, identity.cwd)
  }

  // ACP carries the command list on the session channel rather than in the
  // response, so this is the first thing the opened session emits.
  sendAvailableCommands(session)
  return session
}

function sendAvailableCommands(session: SessionRecord): void {
  if (session.commands.available.length > 0) {
    session.updates.send({ sessionUpdate: 'available_commands_update', availableCommands: [...session.commands.available] })
  }
}

function unregister(store: SessionStore, session: SessionRecord): void {
  store.records.delete(session.storedSessionId)
  store.liveIndex.delete(session.gatewaySessionId)
}

/**
 * Snapshot the slash-command catalog for a new session.
 *
 * The one place in this adapter where degrading is right rather than lazy: a
 * session with no command list is fully functional — every prompt still runs,
 * and an unrecognized `/word` was always going to reach Hermes as text — so a
 * `commands.catalog` failure must not cost the user their session. Unlike the
 * model and approval reads in `initialSessionState`, nothing about the
 * session's behavior is misreported by leaving it out.
 *
 * The catalog's own `warning` field reports a partial build (skill or
 * quick-command discovery failed); it goes to stderr because the commands
 * that did resolve are still correct and worth advertising.
 */
async function readCommandCatalog(hermes: HermesGateway): Promise<CommandCatalog> {
  try {
    const catalog = await hermes.commandsCatalog()
    if (catalog.warning !== undefined && catalog.warning !== '') {
      console.error(`[hermes-agent-acp] gateway commands.catalog reported a partial build: ${catalog.warning}`)
    }
    return buildCommandCatalog(catalog)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[hermes-agent-acp] gateway method commands.catalog failed; session opens without slash commands: ${message}`)
    return EMPTY_COMMAND_CATALOG
  }
}

/**
 * The catalog and settings a freshly opened session starts from.
 *
 * `session.create` answers before the agent exists and its `info` is a
 * deliberately partial "lazy" snapshot (methods_session.py ~135) — it carries
 * a model but neither `yolo` nor `approval_mode` — and a cold resume's agent
 * build is equally deferred, so the settings are read from the two config
 * surfaces that do not need an agent: `model.options` (which falls back to
 * disk config when no agent is built) and `config.get approval_mode`.
 *
 * One residual gap: a gateway started with `--yolo` freezes the bypass on
 * process-wide (`_YOLO_MODE_FROZEN`), which neither call reports. Only the
 * first `session.info` says so, which is why the session is registered before
 * this runs: an info landing during these reads is merged over their result
 * and reported in the open response, and one landing after it arrives as a
 * `current_mode_update`.
 */
async function initialSessionState(
  hermes: HermesGateway,
  gatewaySessionId: string,
  info: LazySessionInfo | undefined,
): Promise<{ readonly catalog: ModelOptionsResult; readonly settings: SessionSettings }> {
  // `refresh` is left off: it busts every cache and probes every custom
  // provider endpoint, which would put a multi-second network round-trip in
  // front of every session open.
  const catalog = await readSessionSetting('model.options', () =>
    hermes.modelOptions({ session_id: gatewaySessionId }, MODEL_OPTIONS_TIMEOUT_MS),
  )
  const storedApprovalMode = await readSessionSetting('config.get', () =>
    hermes.configGet({ key: CONFIG_KEY_APPROVAL_MODE, session_id: gatewaySessionId }),
  )

  // The catalog's own current model wins over the open response's: both read
  // the same disk config, and this is the one the catalog rows are guaranteed
  // to be consistent with. Empty is "not reported", not "cleared".
  const model = catalog.model !== undefined && catalog.model !== '' ? catalog.model : (info?.model ?? '')
  const provider = catalog.provider !== undefined && catalog.provider !== '' ? catalog.provider : (info?.provider ?? '')
  return { catalog, settings: settingsFromConfig(model, provider, normalizeApprovalMode(storedApprovalMode.value ?? '')) }
}

/**
 * One settings read on a session that is not established yet: a failure fails
 * the open, and the caller closes the gateway session rather than leaving it
 * behind with no ACP session pointing at it (same reasoning as the
 * mis-rooted-cwd path). This wrapper only names the failed method.
 */
async function readSessionSetting<Result>(
  gatewayMethod: string,
  read: () => Promise<Result>,
): Promise<Result> {
  try {
    return await read()
  } catch (error) {
    throw gatewayMethodError(gatewayMethod, error)
  }
}

/**
 * Close a gateway session this adapter is abandoning. The caller is already
 * failing its request, so a failed close is logged rather than replacing the
 * error the client actually needs to see.
 */
async function closeQuietly(hermes: HermesGateway, gatewaySessionId: string, reason: string): Promise<void> {
  try {
    await hermes.sessionClose(gatewaySessionId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[hermes-agent-acp] gateway method session.close failed while ${reason}: ${message}`)
  }
}
