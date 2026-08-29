import { isAbsolute, resolve as resolvePath } from 'node:path'

import type {
  AgentContext,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  ClientCapabilities,
  CloseSessionRequest,
  CloseSessionResponse,
  ContentBlock,
  DeleteSessionRequest,
  DeleteSessionResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from '@agentclientprotocol/sdk'
import * as acp from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'

import { authenticationSucceeds, buildAuthMethods } from './auth.js'
import {
  AGENT_NAME,
  AGENT_TITLE,
  AGENT_VERSION,
  APPROVAL_CHOICE_DENY,
  MODEL_OPTIONS_TIMEOUT_MS,
  CONFIG_OPTION_APPROVAL_MODE,
  CONFIG_OPTION_MODEL,
  GATEWAY_SESSION_SOURCE,
  MODEL_CONFIRM_FIELD,
  PROTOCOL_VERSION,
  SESSION_LIST_FETCH_CAP,
  SESSION_LIST_PAGE_SIZE,
} from './constants.js'
import { gatewayMethodError } from './errors.js'
import { clientSupportsFormElicitation } from './turn/permissions.js'
import { runCommand } from './turn/commandExecution.js'
import type { CommandExecutionContext } from './turn/commandExecution.js'
import type { HermesGateway } from './gateway/HermesGatewayClient.js'
import type {
  ConfigSetParams,
  ConfigSetResult,
  GatewayEvent,
  LazySessionInfo,
  ModelOptionsResult,
  PromptSubmitResult,
  SessionListResult,
} from './gateway/types.js'
import { isFullSessionInfo } from './gateway/types.js'
import type { SessionDirectory } from './session/sessionDirectory.js'
import type { SessionRecord, SessionStore } from './session/sessionSetup.js'
import {
  forkSession as forkStoredSession,
  openSession,
  resumeSession as resumeStoredSession,
} from './session/sessionSetup.js'
import { parseCommandInvocation } from './turn/commands.js'
import type { SessionSettings } from './turn/configOptions.js'
import {
  APPROVAL_MODE_VALUES,
  approvalModeSwitchParams,
  buildConfigOptions,
  isKnownModeId,
  isModelConfirmed,
  modelConfirmElicitation,
  modelSwitchParams,
  modeSwitchParams,
  settingsFromInfo,
} from './turn/configOptions.js'
import { promptUsage, sanitizeSessionTitle, sessionTitle, usageGauge } from './turn/mappers.js'
import { detachStagedImages, stagePrompt } from './turn/promptContent.js'
import { TurnHandler } from './turn/TurnHandler.js'

export class HermesAcpServer {
  private readonly hermes: HermesGateway
  /** Keyed by ACP sessionId, which is the STORED session key verbatim. Gateway
   * events carry the live session_id and resolve through `liveIndex`. */
  private readonly sessions = new Map<string, SessionRecord>()
  /** Live gateway session_id → stored session key, for event routing. */
  private readonly liveIndex = new Map<string, string>()
  /** Stored ids with a resume/load in flight (see SessionStore.pendingOpens). */
  private readonly pendingOpens = new Set<string>()
  /** stored-id → cwd cache backing `session/list` (see sessionDirectory.ts). */
  private readonly sessionDirectory: SessionDirectory
  /** What the client advertised at `initialize`. Elicitation is capability-
   * gated, so a turn cannot decide how to ask a question without it. */
  private clientCapabilities: ClientCapabilities | null = null

  constructor(hermes: HermesGateway, sessionDirectory: SessionDirectory) {
    this.hermes = hermes
    this.sessionDirectory = sessionDirectory
    // Subscribed for the process lifetime: the gateway multiplexes every
    // session onto one event stream, and routing needs the session table.
    this.hermes.onEvent((event) => {
      this.routeGatewayEvent(event)
    })
  }

  /** The table the session-setup flows (new/resume/load) register into. */
  private get sessionStore(): SessionStore {
    return { records: this.sessions, liveIndex: this.liveIndex, directory: this.sessionDirectory, pendingOpens: this.pendingOpens }
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = params.clientCapabilities ?? null
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: AGENT_NAME, title: AGENT_TITLE, version: AGENT_VERSION },
      // Capabilities are advertised as each feature lands (docs/todos.md);
      // nothing optional is claimed until it actually works.
      agentCapabilities: {
        // The stored-session lifecycle: `session/load` (which subsumes
        // `session/resume`'s subscribe), list/close/delete, and a head-only
        // `session/fork`. `fork` is a bare capability: breakpoint forking is
        // not implemented (docs/todos.md section 4).
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, fork: {} },
        promptCapabilities: {
          // Images and embedded resources are staged on the gateway session
          // before the submit (src/turn/promptContent.ts). Audio stays
          // unadvertised and rejected: Hermes has no audio attachment path.
          image: true,
          embeddedContext: true,
        },
      },
      authMethods: buildAuthMethods(await this.readProviderCatalog(), this.clientCapabilities),
    }
  }

  /**
   * Read the session-less provider catalog, or null if the gateway refused.
   *
   * Legal at `initialize` because the gateway child is already running before
   * the ACP connection accepts connections (index.ts), so this does not race
   * the handshake. A failure is not fatal: auth advertisement degrades to the
   * terminal setup method, which is exactly the right offer when the adapter
   * cannot read Hermes' credential state.
   */
  private async readProviderCatalog(): Promise<ModelOptionsResult | null> {
    try {
      return await this.hermes.modelOptions({}, MODEL_OPTIONS_TIMEOUT_MS)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[hermes-agent-acp] gateway method model.options failed while building auth methods: ${message}`)
      return null
    }
  }

  /**
   * `authenticate` is a validation no-op, exactly as upstream's is: no
   * credential travels over ACP, so the only thing to check is whether the
   * named method matches the provider Hermes currently resolves. The catalog is
   * re-read rather than reused from `initialize` — the whole point of the
   * terminal setup method is that the credential state changes in between.
   */
  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    let catalog: ModelOptionsResult
    try {
      catalog = await this.hermes.modelOptions({}, MODEL_OPTIONS_TIMEOUT_MS)
    } catch (error) {
      throw gatewayMethodError('model.options', error)
    }
    if (!authenticationSucceeds(params.methodId, catalog)) {
      throw RequestError.authRequired(
        undefined,
        `ACP authenticate: Hermes has no usable credentials for ${JSON.stringify(params.methodId)}`,
      )
    }
    return {}
  }

  /** The full flow lives in src/session/sessionSetup.ts; the server only
   * lends it the session table its event routing reads from. */
  async newSession(params: NewSessionRequest, client: AgentContext): Promise<NewSessionResponse> {
    return openSession(this.hermes, this.sessionStore, params, client)
  }

  /**
   * `session/list`, adapter-side end to end: upstream `session.list` has no
   * cursor or cwd params and projects no cwd, so one bounded fetch is filtered
   * (source tag, then rows whose cwd the live record or the persisted
   * directory can vouch for, then the client's cwd filter) and paged by a
   * decimal-offset cursor. Offset drift when sessions appear mid-pagination
   * is accepted and documented (docs/caveats.md).
   */
  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    let offset = 0
    if (params.cursor !== undefined && params.cursor !== null) {
      if (!/^\d+$/.test(params.cursor)) {
        throw RequestError.invalidParams(
          undefined,
          `ACP session/list: cursor must be a nextCursor value this adapter returned, got ${JSON.stringify(params.cursor)}`,
        )
      }
      offset = Number.parseInt(params.cursor, 10)
    }

    let cwdFilter: string | null = null
    if (params.cwd !== undefined && params.cwd !== null) {
      if (!isAbsolute(params.cwd)) {
        throw RequestError.invalidParams(
          undefined,
          `ACP session/list: the cwd filter must be an absolute path, got ${JSON.stringify(params.cwd)}`,
        )
      }
      cwdFilter = resolvePath(params.cwd)
    }

    let result: SessionListResult
    try {
      result = await this.hermes.sessionList({ limit: SESSION_LIST_FETCH_CAP })
    } catch (error) {
      throw gatewayMethodError('session.list', error)
    }
    if (result.sessions.length === SESSION_LIST_FETCH_CAP) {
      // A full fetch means the real list may be longer; every row past the
      // cap is invisible to every page of this response.
      console.error(
        `[hermes-agent-acp] gateway session.list returned the fetch cap of ${SESSION_LIST_FETCH_CAP} rows; the session list is truncated (see docs/caveats.md)`,
      )
    }

    const sessions: ListSessionsResponse['sessions'] = []
    for (const row of result.sessions) {
      // Only sessions this adapter created: old `hermes acp` sessions (source
      // "acp") and TUI/desktop sessions never appear here (docs/caveats.md).
      if (row.source !== GATEWAY_SESSION_SOURCE) {
        continue
      }
      // A row with no known cwd is unservable: SessionInfo.cwd is required,
      // and inventing one would make both the field and the cwd filter lie.
      const record = this.sessions.get(row.id)
      const cached = this.sessionDirectory.get(row.id)
      const cwd = record?.cwd ?? cached?.cwd
      if (cwd === undefined) {
        continue
      }
      if (cwdFilter !== null && resolvePath(cwd) !== cwdFilter) {
        continue
      }
      sessions.push({
        sessionId: row.id,
        cwd,
        title: row.title === '' ? null : sanitizeSessionTitle(row.title),
        ...(cached?.updatedAt !== undefined ? { updatedAt: cached.updatedAt } : {}),
      })
    }

    const page = sessions.slice(offset, offset + SESSION_LIST_PAGE_SIZE)
    const nextOffset = offset + SESSION_LIST_PAGE_SIZE
    return {
      sessions: page,
      ...(nextOffset < sessions.length ? { nextCursor: String(nextOffset) } : {}),
    }
  }

  /** `session/resume`: subscribe without the transcript (replay belongs to
   * `session/load`). The full flow lives in src/session/sessionSetup.ts. */
  async resumeSession(params: ResumeSessionRequest, client: AgentContext): Promise<ResumeSessionResponse> {
    return resumeStoredSession(this.hermes, this.sessionStore, 'session/resume', params, client, { replay: 'none' })
  }

  /** `session/load`: subscribe AND replay the transcript, synchronously,
   * before responding. The full flow lives in src/session/sessionSetup.ts. */
  async loadSession(params: LoadSessionRequest, client: AgentContext): Promise<LoadSessionResponse> {
    return resumeStoredSession(this.hermes, this.sessionStore, 'session/load', params, client, { replay: 'sync' })
  }

  /** `session/fork`: branch a tracked session's whole history into a new
   * gateway session (head-only — no breakpoint count). The full flow lives in
   * src/session/sessionSetup.ts. */
  async forkSession(params: ForkSessionRequest, client: AgentContext): Promise<ForkSessionResponse> {
    return forkStoredSession(this.hermes, this.sessionStore, params, client)
  }

  /**
   * `session/close` on an untracked id is invalidParams, consistent with
   * every other session-scoped method; the gateway's own tolerance for
   * unknown ids is not a reason to accept a client bug here.
   */
  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.requireSession(params.sessionId, 'session/close')
    // The teardown half of the fork race: `session.branch` runs in the
    // gateway's long-handler pool, so a close committed alongside it either
    // fails the fork or leaves a child parented to a session being torn down.
    // The guard belongs here rather than in `teardownSession`, which
    // connection-close teardown shares and which must always proceed.
    this.refuseWhileForking(session, 'session/close', 'closing')
    await this.teardownSession(session)
    return {}
  }

  /**
   * `session/delete` works for any stored id, tracked or straight off
   * `session/list`: the gateway refuses to delete a session that is live in
   * its process (4023), so a tracked one is torn down first, and a 4023 from
   * a session live elsewhere (attach mode, a TUI sharing the gateway)
   * surfaces via the gatewayMethodError convention.
   */
  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    const session = this.sessions.get(params.sessionId)
    if (session !== undefined) {
      // Refused before the teardown AND before `session.delete` reaches the
      // gateway: deleting the row a branch is copying from is the same race
      // `session/close` refuses, one step worse. An untracked id carries no
      // fork state and is deleted as before.
      this.refuseWhileForking(session, 'session/delete', 'deleting')
      await this.teardownSession(session)
    }
    // The gateway speaks stored keys, which the client's id may not be: a
    // resume that resolved a compressed-away parent registered the record
    // under the requested id, but the conversation the client was looking at
    // is the continuation tip's, so the tip's row is the one deletion removes.
    const storedKey = session?.storedKey ?? params.sessionId
    try {
      await this.hermes.sessionDelete(storedKey)
    } catch (error) {
      throw gatewayMethodError('session.delete', error)
    }
    this.sessionDirectory.forget(params.sessionId)
    if (storedKey !== params.sessionId) {
      this.sessionDirectory.forget(storedKey)
    }
    return {}
  }

  /**
   * `session/set_mode` → `config.set yolo`, scoped to this session.
   *
   * The mode the client should show is the gateway's effective bypass state,
   * which a global `approvals.mode: off` can keep at `dont_ask` whatever the
   * session flag says. The gateway emits that state on a `session.info` before
   * answering the switch (server.py config.set), so by the time the call
   * returns the record holds it. When it differs from the requested mode the
   * client is corrected explicitly — the event path only reports deltas, and a
   * refused switch produces none.
   */
  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId, 'session/set_mode')
    this.refuseUnlessOperable(session, 'session/set_mode', 'changing its mode')
    if (!isKnownModeId(params.modeId)) {
      throw RequestError.invalidParams(
        undefined,
        `ACP session/set_mode: unknown mode ${JSON.stringify(params.modeId)}`,
      )
    }
    const before = session.settings
    await this.configSet(modeSwitchParams(session.gatewaySessionId, params.modeId))
    // An unchanged settings reference means no `session.info` spoke (the agent
    // is still building), so there is no effective state to correct toward.
    if (session.settings !== before && session.settings.modeId !== params.modeId) {
      session.updates.send({ sessionUpdate: 'current_mode_update', currentModeId: session.settings.modeId })
    }
    return {}
  }

  /**
   * `session/set_config_option` → the matching `config.set` key.
   *
   * `cancellationSignal` is the request's own: a model switch can open a
   * confirmation card, and a cancelled request must not have that card answered
   * out from under it later (see confirmExpensiveModel).
   */
  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
    cancellationSignal: AbortSignal,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId, 'session/set_config_option')
    this.refuseUnlessOperable(session, 'session/set_config_option', 'changing its configuration')
    // Both advertised options are selects, and no boolean capability is
    // claimed, so a boolean value is a client bug rather than something to
    // coerce.
    const value: unknown = params.value
    if (typeof value !== 'string') {
      throw RequestError.invalidParams(
        undefined,
        `ACP session/set_config_option: option ${params.configId} takes a string value id, got ${JSON.stringify(value)}`,
      )
    }

    switch (params.configId) {
      case CONFIG_OPTION_MODEL:
        return await this.setModel(session, value, cancellationSignal)
      case CONFIG_OPTION_APPROVAL_MODE:
        return await this.setApprovalMode(session, value)
      default:
        throw RequestError.invalidParams(
          undefined,
          `ACP session/set_config_option: unknown config option ${JSON.stringify(params.configId)}`,
        )
    }
  }

  /**
   * Switch the session's model.
   *
   * Three gateway outcomes are distinguished, and none of them is swallowed:
   * a rejected model id arrives as a gateway error (5001) and is surfaced
   * verbatim; an expensive pick comes back `confirm_required` WITHOUT being
   * applied and is put to the user; a pick made mid-turn is queued and applied
   * at the next turn start.
   */
  private async setModel(
    session: SessionRecord,
    valueId: string,
    cancellationSignal: AbortSignal,
  ): Promise<SetSessionConfigOptionResponse> {
    let result = await this.configSet(modelSwitchParams(session.gatewaySessionId, valueId, false))

    if (result.confirm_required === true) {
      const message = result.confirm_message ?? `${valueId} needs confirmation before it can be selected`
      await this.confirmExpensiveModel(session, message, cancellationSignal)
      result = await this.configSet(modelSwitchParams(session.gatewaySessionId, valueId, true))
      if (result.confirm_required === true) {
        // Confirmed once and still gated: re-asking would loop the user
        // through the same card forever.
        throw RequestError.internalError(
          undefined,
          `ACP session/set_config_option: the gateway still requires confirmation for ${valueId} after it was confirmed: ${result.confirm_message ?? message}`,
        )
      }
    }

    if (result.deferred === true) {
      // A queued pick emits no `session.info` of its own (server.py ~11978), so
      // this is the only place the record can learn about it. Later
      // `session.info` frames report the pending pick as current, which now
      // matches and stays silent instead of announcing it a second time.
      session.settings = { ...session.settings, modelValueId: valueId }
    }

    // Built from the record rather than from `result`: on an agent-backed
    // session the applied switch has already been reported by the
    // `session.info` the gateway emitted before answering, and that frame is
    // the authority on what the session runs. A session whose agent build has
    // not landed yet emits no `session.info` at all (every re-emit upstream is
    // gated on a live agent), so this response repeats the old value and the
    // build's first `session.info` corrects it.
    return { configOptions: buildConfigOptions(session.modelCatalog, session.settings) }
  }

  /**
   * Set the GLOBAL approval policy. Upstream writes config.yaml and re-emits
   * `session.info` to every live session, so every session's client — not just
   * this one — sees the change through its own update channel.
   */
  private async setApprovalMode(session: SessionRecord, valueId: string): Promise<SetSessionConfigOptionResponse> {
    if (!APPROVAL_MODE_VALUES.includes(valueId)) {
      throw RequestError.invalidParams(
        undefined,
        `ACP session/set_config_option: unknown approval mode ${JSON.stringify(valueId)}; expected one of ${APPROVAL_MODE_VALUES.join(', ')}`,
      )
    }
    await this.configSet(approvalModeSwitchParams(valueId))
    return { configOptions: buildConfigOptions(session.modelCatalog, session.settings) }
  }

  /**
   * Put the gateway's expensive-model gate to the user, and fail the option set
   * unless they explicitly accept. Never auto-confirmed: `confirm_message` is
   * the only statement of what the pick costs, and a client that cannot show it
   * cannot consent on the user's behalf.
   *
   * The card is bound to the request that opened it. ACP cancellation is
   * cooperative — aborting only sends `$/cancel_request` and leaves the
   * elicitation promise waiting on a client that may never answer — so the
   * abortable race in SessionUpdateSender settles it locally as `cancel`.
   * Without that, a cancelled option set whose card is answered "Yes" minutes
   * later would wake up and apply the confirmed switch: a stale round-trip
   * resolving to allow, which is exactly what every permission-like path here
   * fails closed against.
   */
  private async confirmExpensiveModel(
    session: SessionRecord,
    confirmMessage: string,
    cancellationSignal: AbortSignal,
  ): Promise<void> {
    if (!clientSupportsFormElicitation(this.clientCapabilities)) {
      throw RequestError.invalidRequest(
        undefined,
        `ACP session/set_config_option: the model was not switched because it needs confirmation the client cannot ask for (no elicitation.form capability): ${confirmMessage}`,
      )
    }

    const response = await session.updates.createElicitation(
      modelConfirmElicitation(session.storedSessionId, confirmMessage),
      cancellationSignal,
    )
    const content = acp.CreateElicitationResponse.isAccept(response) ? response.content : null
    // The abort is re-checked after the answer: a card accepted in the window
    // between the client cancelling and this frame is an answer to a question
    // nobody is waiting on anymore.
    if (cancellationSignal.aborted || !isModelConfirmed(content?.[MODEL_CONFIRM_FIELD])) {
      throw RequestError.invalidRequest(
        undefined,
        `ACP session/set_config_option: the model was not switched because the confirmation was not given: ${confirmMessage}`,
      )
    }
  }

  private async configSet(params: ConfigSetParams): Promise<ConfigSetResult> {
    try {
      return await this.hermes.configSet(params)
    } catch (error) {
      // Includes 5001, the code a rejected model id arrives under: the
      // gateway's own message is what tells the user which id was refused.
      throw gatewayMethodError('config.set', error)
    }
  }

  /**
   * `cancellationSignal` is the request's own (`$/cancel_request`): aborting
   * it is the same act as `session/cancel`, so it routes through `cancel`,
   * which covers a command reservation and a turn alike. The prompt then ends
   * `cancelled` like any other cancelled turn.
   */
  async prompt(params: PromptRequest, cancellationSignal: AbortSignal): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId, 'session/prompt')
    // The one-turn discipline, checked synchronously up to the turn (or
    // command reservation) install so no teardown or fork can slip in behind
    // it: a turn installed into a session being torn down would be stranded
    // without event routing, and one submitted while a `session.branch`
    // snapshots the history would be copied into the child half-written.
    this.refuseUnlessOperable(session, 'session/prompt', 'prompting')
    // The gateway rejects a concurrent submit anyway; refusing here keeps the
    // in-flight turn's event stream from being interleaved with a second one.
    if (session.activeTurn !== null) {
      throw RequestError.invalidRequest(
        undefined,
        `ACP session/prompt: session ${params.sessionId} already has a turn in flight; cancel it before prompting again`,
      )
    }

    const cancelOnAbort = (): void => {
      void this.cancel({ sessionId: params.sessionId })
    }
    cancellationSignal.addEventListener('abort', cancelOnAbort)
    const request = this.runPromptOrCommand(session, params.prompt)
    // The record keeps the request so teardown can wait for this response to
    // be on its way before answering its own (see abandonActiveTurn). The
    // observer is empty: the SDK is the one reporting the outcome.
    session.activePrompt = request.then(
      () => undefined,
      () => undefined,
    )
    try {
      return await request
    } finally {
      cancellationSignal.removeEventListener('abort', cancelOnAbort)
      session.activePrompt = null
    }
  }

  private async runPromptOrCommand(session: SessionRecord, blocks: readonly ContentBlock[]): Promise<PromptResponse> {
    // ACP v1 has no command-invocation method: a command arrives as prompt text
    // and is recognized here, against the catalog this session advertised.
    // Anything unrecognized is ordinary prompt text, slash or not.
    const invocation = parseCommandInvocation(blocks, session.commands)
    if (invocation !== null) {
      // A command consumes only the block it was parsed from. Silently
      // dropping the rest would lose an image this adapter advertises support
      // for, so a mixed prompt is refused rather than half-executed.
      if (blocks.length > 1) {
        throw RequestError.invalidParams(
          undefined,
          `ACP session/prompt: the slash command ${invocation.canonicalName} cannot carry additional content blocks; send the command on its own`,
        )
      }
      return await runCommand(this.commandExecutionContext(), session, invocation)
    }
    return await this.runPrompt(session, blocks)
  }

  /**
   * The slice of this server that slash-command execution reaches into
   * (src/turn/commandExecution.ts). `runPrompt` is passed as a callback because
   * a `send`/`skill` command result submits an ordinary turn of its own.
   */
  private commandExecutionContext(): CommandExecutionContext {
    return {
      hermes: this.hermes,
      clientCapabilities: this.clientCapabilities,
      sessionDirectory: this.sessionDirectory,
      runPrompt: (session, blocks) => this.runPrompt(session, blocks),
    }
  }

  /** The ordinary prompt turn: stage attachments, submit, stream to the end. */
  private async runPrompt(session: SessionRecord, blocks: readonly ContentBlock[]): Promise<PromptResponse> {
    // Installed before staging, not just before the submit: staging awaits the
    // gateway, and a second prompt slipping in behind that await would stage
    // its images onto the same session for the first submit to drain. The
    // reserved slot also gives a mid-staging `session/cancel` something to
    // mark. No turn events can arrive before the submit, so an early install
    // routes nothing prematurely.
    const turn = new TurnHandler({
      updates: session.updates,
      hermes: this.hermes,
      sessionId: session.storedSessionId,
      gatewaySessionId: session.gatewaySessionId,
      clientCapabilities: this.clientCapabilities,
    })
    session.activeTurn = turn

    try {
      // Attachments are staged on the session before the submit that drains
      // them, so this both talks to the gateway and produces the prompt text.
      // A staging failure rolls back inside stagePrompt and the finally below
      // leaves the session idle and promptable.
      const staged = await stagePrompt(this.hermes, session.gatewaySessionId, blocks)

      // Cancelled while staging: the user asked to stop before the turn ever
      // reached Hermes, so nothing is submitted and the staged images are
      // pulled back out rather than leaking into the next prompt's drain.
      if (turn.cancelWasRequested()) {
        await detachStagedImages(this.hermes, session.gatewaySessionId, staged.stagedImagePaths)
        return { stopReason: 'cancelled' }
      }

      let submitted: PromptSubmitResult
      try {
        submitted = await this.hermes.promptSubmit({ session_id: session.gatewaySessionId, text: staged.text })
      } catch (error) {
        // The submit that was going to drain these images never happened, so
        // the next one on this session would pick them up instead.
        await detachStagedImages(this.hermes, session.gatewaySessionId, staged.stagedImagePaths)
        throw gatewayMethodError('prompt.submit', error)
      }
      if (!('status' in submitted)) {
        // No turn was started, so no terminal frame is coming; waiting for one
        // would wedge the session (see PromptSubmitResult).
        throw RequestError.internalError(
          undefined,
          'gateway method prompt.submit: the prompt was consumed as a voice stop phrase and started no turn',
        )
      }

      const result = await turn.completed()
      switch (result.kind) {
        case 'completed': {
          const usage = promptUsage(result.usage)
          return usage === undefined ? { stopReason: 'end_turn' } : { stopReason: 'end_turn', usage }
        }
        case 'cancelled':
          return { stopReason: 'cancelled' }
        case 'failed':
          // Never a clean end_turn: a failed Hermes turn is the upstream defect
          // this adapter exists to fix (see CLAUDE.md, docs/todos.md section 2).
          throw RequestError.internalError(undefined, `Hermes turn failed: ${result.message}`)
      }

      throw RequestError.internalError(
        undefined,
        `ACP session/prompt: unhandled turn result ${JSON.stringify(result satisfies never)}`,
      )
    } finally {
      // Every exit path clears the slot — a leaked activeTurn would reject
      // every later prompt on this session as "already in flight".
      if (session.activeTurn === turn) {
        session.activeTurn = null
      }
      this.sessionDirectory.touch(session.storedSessionId)
    }
  }

  /**
   * `session/cancel` is a notification: there is no channel to report a failure
   * back on, so the interrupt result is only logged. The prompt still resolves
   * `cancelled` — TurnHandler's cancel flag is sticky, so whatever terminal
   * status the gateway ends up reporting maps to a cancelled stop reason.
   */
  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId)
    const turn = session?.activeTurn
    if (!session || !turn) {
      // Cancelling an unknown or idle session is a no-op, not an error: the
      // turn may have completed between the client's decision and this frame.
      return
    }

    turn.requestCancel()
    await this.interruptQuietly(session.gatewaySessionId)
  }

  /**
   * The ACP connection went away. Every in-flight turn is settled `cancelled`
   * rather than left hanging on a terminal frame nobody is waiting for, the
   * gateway is told to stop working on them, and the update channels are shut
   * so a send into a dead connection cannot take the process down.
   *
   * index.ts calls this from its `connection.closed` observer; keeping the
   * seam here is what keeps the ACP semantics out of the entry point.
   */
  async connectionClosed(): Promise<void> {
    const abandons: Promise<void>[] = []
    for (const session of this.sessions.values()) {
      session.updates.close()
      abandons.push(this.abandonActiveTurn(session))
    }
    await Promise.all(abandons)
  }

  /**
   * Settle any in-flight turn `cancelled`, tell the gateway to stop working on
   * it, and wait for the prompt's response to be on its way. Shared by
   * connection teardown and `session/close`/`session/delete`: a pending
   * `session/prompt` must resolve, never hang on a terminal frame nobody is
   * waiting for, and it must resolve BEFORE the teardown's own response so a
   * client never hears from a session it was just told is gone. The wait
   * covers a prompt still staging and a blocking `slash.exec` alike — the
   * interrupt is what unblocks the latter upstream.
   */
  private async abandonActiveTurn(session: SessionRecord): Promise<void> {
    const turn = session.activeTurn
    if (turn !== null) {
      session.activeTurn = null
      turn.abandon()
      await this.interruptQuietly(session.gatewaySessionId)
    }
    // Awaited even with no turn in the slot: a command turn releases its
    // reservation before draining its output, and closing the channel inside
    // that drain would swallow the output without recording a failure.
    await session.activePrompt
  }

  /**
   * The gateway process died under the adapter. Every in-flight turn fails with
   * the death as its reason — the alternative is a prompt that ends in a bare
   * EOF when index.ts exits — and the wait is for those responses to be on
   * their way before the exit that follows.
   */
  async gatewayExited(reason: string): Promise<void> {
    const prompts: Promise<unknown>[] = []
    for (const session of this.sessions.values()) {
      session.activeTurn?.fail(`gateway transport: ${reason}`)
      session.activeTurn = null
      if (session.activePrompt !== null) {
        prompts.push(session.activePrompt)
      }
    }
    await Promise.all(prompts)
  }

  /**
   * Close one tracked session: abandon its turn, close the live gateway
   * session, then forget both indexes and shut the update channel. The record
   * is flagged `closing` before the first await, so a prompt arriving
   * mid-teardown is refused rather than installing a turn the abandon below
   * already missed — a turn stranded without event routing would leave its
   * prompt pending indefinitely. The channel closes only when the teardown
   * commits: a failed `session.close` keeps the record registered (and
   * promptable again), and a channel closed underneath it would silently
   * swallow every later update (`send` early-returns on `closed` without
   * recording a failure). The directory entry deliberately stays — the stored
   * session still exists and `session/list` must keep resolving its cwd; only
   * `session/delete` removes it.
   */
  private async teardownSession(session: SessionRecord): Promise<void> {
    session.closing = true
    await this.abandonActiveTurn(session)
    try {
      await this.hermes.sessionClose(session.gatewaySessionId)
    } catch (error) {
      session.closing = false
      throw gatewayMethodError('session.close', error)
    }
    this.sessions.delete(session.storedSessionId)
    this.liveIndex.delete(session.gatewaySessionId)
    session.updates.close()
  }

  /** Adapter state for an ACP session (keyed by stored session id), or
   * undefined if the id is unknown. */
  session(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * `session.info` is the gateway's one report of what a session is configured
   * to run, emitted after every model switch, every approval-policy change
   * (including a global one made from another session), and after the deferred
   * agent build. It carries no delta, so the change detection is here: only a
   * setting that actually moved since the client was last told produces an
   * update.
   *
   * An empty `model` means the gateway has nothing to report yet (the agent is
   * still building), not that the model was cleared, so the last known value is
   * kept rather than announced as gone.
   */
  private applySessionInfo(session: SessionRecord, info: LazySessionInfo): void {
    // The workspace-move skeleton carries no settings (isFullSessionInfo).
    if (!isFullSessionInfo(info)) {
      return
    }

    const previous = session.settings
    const reported = settingsFromInfo(info)
    const next: SessionSettings =
      reported.modelValueId === '' ? { ...reported, modelValueId: previous.modelValueId } : reported
    session.settings = next

    if (session.registering) {
      // The client has not been told this session exists yet and the provider
      // catalog has not been read, so there is neither an audience for an
      // update nor a catalog to build one from. The settings still moved, and
      // the `session/new` response reports them.
      return
    }

    if (next.modeId !== previous.modeId) {
      session.updates.send({ sessionUpdate: 'current_mode_update', currentModeId: next.modeId })
    }
    if (next.modelValueId !== previous.modelValueId || next.approvalMode !== previous.approvalMode) {
      session.updates.send({
        sessionUpdate: 'config_option_update',
        configOptions: buildConfigOptions(session.modelCatalog, next),
      })
    }
  }

  /**
   * Interrupt without a channel to report on: both callers (`session/cancel`,
   * connection close) are notifications, so the failure is logged and the turn
   * still ends — its cancel flag is already set.
   */
  private async interruptQuietly(gatewaySessionId: string): Promise<void> {
    try {
      await this.hermes.sessionInterrupt(gatewaySessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[hermes-agent-acp] gateway method session.interrupt failed: ${message}`)
    }
  }

  /**
   * Refuse a request that puts new work on a session that cannot take it: a
   * teardown in flight, or a `session.branch` in flight (see
   * SessionRecord.closing/forking). One helper for prompt, set_mode, and
   * set_config_option, so they cannot drift into different contracts for the
   * same windows. Close and delete apply only the fork half: teardown is what
   * they are.
   */
  private refuseUnlessOperable(session: SessionRecord, acpMethod: string, action: string): void {
    if (session.closing) {
      throw RequestError.invalidRequest(
        undefined,
        `ACP ${acpMethod}: session ${session.storedSessionId} is being closed`,
      )
    }
    this.refuseWhileForking(session, acpMethod, action)
  }

  private refuseWhileForking(session: SessionRecord, acpMethod: string, action: string): void {
    if (!session.forking) {
      return
    }
    throw RequestError.invalidRequest(
      undefined,
      `ACP ${acpMethod}: session ${session.storedSessionId} is being forked; wait for the fork to finish before ${action}`,
    )
  }

  private requireSession(sessionId: string, acpMethod: string): SessionRecord {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw RequestError.invalidParams(undefined, `ACP ${acpMethod}: unknown session ${sessionId}`)
    }
    return session
  }

  /**
   * The gateway fans every session's events onto one stream, so an event
   * reaches a turn only when its `session_id` — the LIVE id — resolves
   * through `liveIndex` to a tracked session. Session-less frames carry
   * `session_id: ""` upstream and match nothing, which is the intended
   * fail-closed behavior.
   */
  private routeGatewayEvent(event: GatewayEvent): void {
    if (event.type === 'error') {
      // Logged regardless of routing: a session-less gateway error would
      // otherwise vanish, and it is the only diagnostic Hermes gives here.
      console.error(`[hermes-agent-acp] gateway error event: ${event.payload?.message ?? '(no message)'}`)
    }
    if (event.session_id === undefined) {
      return
    }
    const storedSessionId = this.liveIndex.get(event.session_id)
    const session = storedSessionId === undefined ? undefined : this.sessions.get(storedSessionId)
    if (!session) {
      return
    }

    // Session-scoped events describe the session, not the turn, and Hermes
    // emits them between turns too (a title is generated after the first
    // exchange). They go straight to the session channel; TurnHandler emits
    // nothing for any of them, so exactly one path delivers each.
    if (event.type === 'session.title') {
      session.updates.send(sessionTitle(event.payload.title))
      return
    }
    if (event.type === 'session.usage') {
      const gauge = usageGauge(event.payload?.usage)
      if (gauge) {
        session.updates.send(gauge)
      }
      return
    }
    if (event.type === 'session.info') {
      this.applySessionInfo(session, event.payload)
      // Handed to the turn as well: the settled frame (`running: false`) is the
      // only signal that a turn Hermes abandoned after `message.start` is over,
      // and no `message.complete` is coming for it (TurnHandler `session.info`).
      session.activeTurn?.handleEvent(event)
      return
    }

    // A blocking request with no turn in flight has no user watching it: this
    // adapter's client only sees a session while it is prompting. Approvals are
    // denied so the parked agent thread is released immediately; a clarify has
    // no fail-closed answer, so it is left to Hermes' own timeout.
    if (session.activeTurn === null) {
      if (event.type === 'approval.request') {
        const requestId = event.payload.request_id
        void this.hermes
          .approvalRespond({ session_id: session.gatewaySessionId, request_id: requestId, choice: APPROVAL_CHOICE_DENY })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(
              `[hermes-agent-acp] gateway method approval.respond failed while denying approval ${requestId} on idle session ${session.gatewaySessionId}: ${message}`,
            )
          })
        return
      }
      if (event.type === 'clarify.request') {
        console.error(
          `[hermes-agent-acp] dropped clarify.request ${event.payload.request_id}: session ${session.gatewaySessionId} has no turn in flight`,
        )
        return
      }
    }

    session.activeTurn?.handleEvent(event)
  }
}
