import type { GatewayClient } from './GatewayClient.js'
import type {
  ApprovalResult,
  ClarifyLockParams,
  ClarifyLockResult,
  ClarifyResult,
  CommandDispatchParams,
  CommandDispatchResult,
  CommandsCatalogResult,
  ConfigGetParams,
  ConfigGetResult,
  ConfigSetParams,
  ConfigSetResult,
  FileAttachParams,
  FileAttachResult,
  GatewayEvent,
  GatewayServerRequest,
  ImageAttachBytesParams,
  ImageAttachBytesResult,
  ImageDetachParams,
  ImageDetachResult,
  ModelOptionsParams,
  ModelOptionsResult,
  PromptSubmitParams,
  PromptSubmitResult,
  SessionBranchParams,
  SessionBranchResult,
  SessionCloseResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionDeleteResult,
  SessionHistoryResult,
  SessionInterruptResult,
  SessionListParams,
  SessionListResult,
  SessionResumeParams,
  SessionResumeResult,
  SessionSteerResult,
  SlashExecParams,
  SlashExecResult,
} from './types.js'

/**
 * Public surface of HermesGatewayClient, derived from the class itself so the
 * two cannot drift. The server depends on this rather than the class because
 * the class carries a private field: a test double is only substitutable for
 * the structural surface.
 */
export type HermesGateway = { [Method in keyof HermesGatewayClient]: HermesGatewayClient[Method] }

/**
 * Typed method wrappers over the raw GatewayClient for the gateway subset
 * this adapter consumes (mirrors codex-acp's CodexAppServerClient): one
 * method per JSON-RPC call, with params and results pinned in types.ts.
 *
 * Turn lifecycle note: `prompt.submit` returns as soon as the turn is
 * streaming; the turn itself is observed through events (message.*,
 * tool.*, message.complete with a `status`), not through this call.
 */
export class HermesGatewayClient {
  private readonly gateway: GatewayClient

  constructor(gateway: GatewayClient) {
    this.gateway = gateway
  }

  onEvent(handler: (event: GatewayEvent) => void): () => void {
    return this.gateway.onEvent(handler)
  }

  onServerRequest(handler: (request: GatewayServerRequest) => void): () => void {
    return this.gateway.onServerRequest(handler)
  }

  sessionCreate(params: SessionCreateParams): Promise<SessionCreateResult> {
    return this.gateway.request('session.create', params)
  }

  promptSubmit(params: PromptSubmitParams): Promise<PromptSubmitResult> {
    return this.gateway.request('prompt.submit', params)
  }

  /**
   * Stage an image for the next `prompt.submit`. Attachment methods are all
   * pre-submit: they push onto the session's staged-image list, which the
   * following submit drains into the turn.
   */
  imageAttachBytes(params: ImageAttachBytesParams): Promise<ImageAttachBytesResult> {
    return this.gateway.request('image.attach_bytes', params)
  }

  /**
   * Materialize a non-image file in the session workspace. Unlike the image
   * methods this stages nothing for the turn: the returned `ref_text` has to be
   * spliced into the prompt text for the file to reach the model.
   */
  fileAttach(params: FileAttachParams): Promise<FileAttachResult> {
    return this.gateway.request('file.attach', params)
  }

  /** Unstage an image by the path its attach returned. */
  imageDetach(params: ImageDetachParams): Promise<ImageDetachResult> {
    return this.gateway.request('image.detach', params)
  }

  sessionInterrupt(sessionId: string): Promise<SessionInterruptResult> {
    return this.gateway.request('session.interrupt', { session_id: sessionId })
  }

  sessionSteer(sessionId: string, text: string): Promise<SessionSteerResult> {
    return this.gateway.request('session.steer', { session_id: sessionId, text })
  }

  sessionBranch(params: SessionBranchParams): Promise<SessionBranchResult> {
    return this.gateway.request('session.branch', params)
  }

  sessionList(params: SessionListParams = {}): Promise<SessionListResult> {
    return this.gateway.request('session.list', params)
  }

  sessionResume(params: SessionResumeParams): Promise<SessionResumeResult> {
    return this.gateway.request('session.resume', params)
  }

  sessionHistory(sessionId: string): Promise<SessionHistoryResult> {
    return this.gateway.request('session.history', { session_id: sessionId })
  }

  sessionClose(sessionId: string): Promise<SessionCloseResult> {
    return this.gateway.request('session.close', { session_id: sessionId })
  }

  sessionDelete(sessionId: string): Promise<SessionDeleteResult> {
    return this.gateway.request('session.delete', { session_id: sessionId })
  }

  /**
   * Answer an `approval` server request. A response frame, not a method: the
   * gateway resolves the queue entry from it (server.py `_emit_approval_request`
   * on_result) and withdraws the request itself. Throws when the transport is
   * gone.
   */
  answerApproval(requestId: string, result: ApprovalResult): void {
    this.gateway.respond(requestId, result)
  }

  /** Answer a single-question `clarify` server request. Throws when the
   * transport is gone. */
  answerClarify(requestId: string, result: ClarifyResult): void {
    this.gateway.respond(requestId, result)
  }

  /** Lock one batch-clarify answer; the last lock resolves the request. */
  clarifyLock(params: ClarifyLockParams): Promise<ClarifyLockResult> {
    return this.gateway.request('clarify.lock', params)
  }

  /**
   * `timeoutMs` shortens the RPC budget for this call. `model.options` probes
   * the current custom provider's endpoint even without `refresh`, so a caller
   * the user is waiting on (the ACP handshake) bounds it well below the
   * client-wide default and degrades instead.
   */
  modelOptions(params: ModelOptionsParams = {}, timeoutMs?: number): Promise<ModelOptionsResult> {
    return this.gateway.request('model.options', params, timeoutMs)
  }

  configGet(params: ConfigGetParams): Promise<ConfigGetResult> {
    return this.gateway.request('config.get', params)
  }

  configSet(params: ConfigSetParams): Promise<ConfigSetResult> {
    return this.gateway.request('config.set', params)
  }

  commandsCatalog(): Promise<CommandsCatalogResult> {
    return this.gateway.request('commands.catalog', {})
  }

  slashExec(params: SlashExecParams): Promise<SlashExecResult> {
    return this.gateway.request('slash.exec', params)
  }

  /**
   * The state-mutating command path. `slash.exec` reroutes here on its own for
   * pending-input commands and skill bundles, but refuses skill commands and
   * the state-mutating `/snapshot` subcommands (`restore` and `rewind`,
   * methods_tools.py ~1164) with code 4018 and a "use command.dispatch"
   * message — those have to be re-issued here by the caller.
   */
  commandDispatch(params: CommandDispatchParams): Promise<CommandDispatchResult> {
    return this.gateway.request('command.dispatch', params)
  }
}
