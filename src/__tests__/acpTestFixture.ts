/**
 * Snapshot-test harness for the ACP adapter: scripted gateway events in,
 * recorded ACP transcript out (the style codex-acp's acp-test-utils
 * establishes). No network, no real Hermes, no child process.
 *
 * Both ends of the adapter are stood in for:
 *   - `ScriptedGateway` replaces HermesGatewayClient. It implements the real
 *     `HermesGateway` surface, so a method added or renamed upstream is a
 *     compile error here rather than a silently unexercised path.
 *   - A recording ACP client app is connected to the real agent app in
 *     process, so requests and notifications travel through the real SDK
 *     protocol layer instead of a hand-rolled mock connection.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  NewSessionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk'

import { buildAgentApp } from '../app.js'
import { SESSION_DIRECTORY_FILENAME } from '../constants.js'
import { GatewayRpcError } from '../gateway/GatewayClient.js'
import type { HermesGateway } from '../gateway/HermesGatewayClient.js'
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
  SessionInfo,
  SessionResumeResult,
  SessionSteerResult,
  SlashExecParams,
  SlashExecResult,
} from '../gateway/types.js'
import { HermesAcpServer } from '../HermesAcpServer.js'
import { SessionDirectory } from '../session/sessionDirectory.js'

// ── Constants ───────────────────────────────────────────────────────────────

const TEST_CLIENT_NAME = 'hermes-acp-test-client'

// Permission-like round-trips fail closed: a test that does not script an
// answer gets a denial, never an allow.
const DEFAULT_PERMISSION_RESPONSE: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }
const DEFAULT_ELICITATION_RESPONSE: CreateElicitationResponse = { action: 'cancel' }

/** What a client that cannot take delivery of a `session/update` looks like. */
export const UPDATE_DELIVERY_FAILURE = 'test client refused the session/update'

// ── Scripted gateway ────────────────────────────────────────────────────────

/** Gateway methods that go over JSON-RPC and answer with a result (everything
 * but the subscriptions and the fire-and-forget response frames). */
export type GatewayRequestMethod = Exclude<
  keyof HermesGateway,
  'onEvent' | 'onServerRequest' | GatewayResponseMethod
>
/** The server→client response frames: recorded like calls, but they carry no
 * result to script, so they never reject for want of one. */
export type GatewayResponseMethod = 'answerApproval' | 'answerClarify'

type GatewayResult<Method extends GatewayRequestMethod> = Awaited<ReturnType<HermesGateway[Method]>>

export interface GatewayCall {
  readonly method: GatewayRequestMethod | GatewayResponseMethod
  readonly args: readonly unknown[]
}

/**
 * Stand-in for HermesGatewayClient: records every method call, answers with
 * per-method scripted results, and pushes gateway events at subscribers.
 *
 * A call to a method with no scripted result rejects instead of returning a
 * placeholder, so an unconfigured test fails at the call site.
 */
export class ScriptedGateway implements HermesGateway {
  private readonly calls: GatewayCall[] = []
  private readonly results = new Map<GatewayRequestMethod, unknown>()
  private readonly failures = new Map<GatewayRequestMethod, Error>()
  private readonly eventHandlers = new Set<(event: GatewayEvent) => void>()
  private readonly serverRequestHandlers = new Set<(request: GatewayServerRequest) => void>()

  /** Script the result of the next (and every) call to `method`. A promise is
   * accepted so a test can hold a call open (e.g. cancel-while-staging). */
  setResult<Method extends GatewayRequestMethod>(
    method: Method,
    result: GatewayResult<Method> | Promise<GatewayResult<Method>>,
  ): void {
    this.results.set(method, result)
  }

  /**
   * Script `method` to reject. Defaults to the `GatewayRpcError` a real
   * gateway error response produces, so failure tests exercise the shape
   * HermesGatewayClient actually throws rather than a bare Error.
   */
  setFailure(method: GatewayRequestMethod, error: Error = new GatewayRpcError('scripted gateway failure')): void {
    this.failures.set(method, error)
  }

  /** Calls recorded so far, oldest first. */
  recordedCalls(): readonly GatewayCall[] {
    return [...this.calls]
  }

  clearRecordedCalls(): void {
    this.calls.length = 0
  }

  /** Deliver an event to the adapter as if the gateway had emitted it. */
  emit(event: GatewayEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event)
    }
  }

  onEvent(handler: (event: GatewayEvent) => void): () => void {
    this.eventHandlers.add(handler)
    return () => {
      this.eventHandlers.delete(handler)
    }
  }

  /** Deliver a server→client request as if the gateway had sent it. */
  emitServerRequest(request: GatewayServerRequest): void {
    for (const handler of this.serverRequestHandlers) {
      handler(request)
    }
  }

  onServerRequest(handler: (request: GatewayServerRequest) => void): () => void {
    this.serverRequestHandlers.add(handler)
    return () => {
      this.serverRequestHandlers.delete(handler)
    }
  }

  sessionCreate(params: SessionCreateParams): Promise<SessionCreateResult> {
    return this.respond('sessionCreate', [params])
  }

  promptSubmit(params: PromptSubmitParams): Promise<PromptSubmitResult> {
    return this.respond('promptSubmit', [params])
  }

  imageAttachBytes(params: ImageAttachBytesParams): Promise<ImageAttachBytesResult> {
    return this.respond('imageAttachBytes', [params])
  }

  fileAttach(params: FileAttachParams): Promise<FileAttachResult> {
    return this.respond('fileAttach', [params])
  }

  imageDetach(params: ImageDetachParams): Promise<ImageDetachResult> {
    return this.respond('imageDetach', [params])
  }

  sessionInterrupt(sessionId: string): Promise<SessionInterruptResult> {
    return this.respond('sessionInterrupt', [sessionId])
  }

  sessionSteer(sessionId: string, text: string): Promise<SessionSteerResult> {
    return this.respond('sessionSteer', [sessionId, text])
  }

  sessionBranch(params: SessionBranchParams): Promise<SessionBranchResult> {
    return this.respond('sessionBranch', [params])
  }

  sessionList(params: SessionListParams = {}): Promise<SessionListResult> {
    return this.respond('sessionList', [params])
  }

  sessionResume(params: SessionResumeParams): Promise<SessionResumeResult> {
    return this.respond('sessionResume', [params])
  }

  sessionHistory(sessionId: string): Promise<SessionHistoryResult> {
    return this.respond('sessionHistory', [sessionId])
  }

  sessionClose(sessionId: string): Promise<SessionCloseResult> {
    return this.respond('sessionClose', [sessionId])
  }

  sessionDelete(sessionId: string): Promise<SessionDeleteResult> {
    return this.respond('sessionDelete', [sessionId])
  }

  answerApproval(requestId: string, result: ApprovalResult): void {
    this.calls.push({ method: 'answerApproval', args: [requestId, result] })
  }

  answerClarify(requestId: string, result: ClarifyResult): void {
    this.calls.push({ method: 'answerClarify', args: [requestId, result] })
  }

  clarifyLock(params: ClarifyLockParams): Promise<ClarifyLockResult> {
    return this.respond('clarifyLock', [params])
  }

  /** The RPC budget is recorded only when the caller set one, so calls that
   * take the client-wide default keep a one-argument call record. */
  modelOptions(params: ModelOptionsParams = {}, timeoutMs?: number): Promise<ModelOptionsResult> {
    return this.respond('modelOptions', timeoutMs === undefined ? [params] : [params, timeoutMs])
  }

  configGet(params: ConfigGetParams): Promise<ConfigGetResult> {
    return this.respond('configGet', [params])
  }

  configSet(params: ConfigSetParams): Promise<ConfigSetResult> {
    return this.respond('configSet', [params])
  }

  commandsCatalog(): Promise<CommandsCatalogResult> {
    return this.respond('commandsCatalog', [])
  }

  slashExec(params: SlashExecParams): Promise<SlashExecResult> {
    return this.respond('slashExec', [params])
  }

  commandDispatch(params: CommandDispatchParams): Promise<CommandDispatchResult> {
    return this.respond('commandDispatch', [params])
  }

  private respond<Method extends GatewayRequestMethod>(
    method: Method,
    args: readonly unknown[],
  ): Promise<GatewayResult<Method>> {
    this.calls.push({ method, args })
    const failure = this.failures.get(method)
    if (failure) {
      return Promise.reject(failure)
    }
    if (!this.results.has(method)) {
      return Promise.reject(
        new Error(`scripted gateway: no result configured for ${method}(); call setResult(${JSON.stringify(method)}, …)`),
      )
    }
    return Promise.resolve(this.results.get(method) as GatewayResult<Method>)
  }
}

// ── Session settings scripting ──────────────────────────────────────────────

/**
 * Provider catalog every session/new test starts from. Two providers, one of
 * them with a slash in its model id, so value-id round-tripping is exercised by
 * default rather than only in the test that targets it.
 */
export const TEST_MODEL_CATALOG: ModelOptionsResult = {
  model: 'hermes-4-70b',
  provider: 'nous',
  providers: [
    {
      slug: 'nous',
      name: 'Nous Research',
      models: ['hermes-4-70b', 'hermes-4-405b'],
      total_models: 2,
      is_current: true,
      authenticated: true,
    },
    {
      slug: 'openrouter',
      name: 'OpenRouter',
      models: ['deepseek/deepseek-v4-flash'],
      total_models: 1,
      authenticated: true,
    },
  ],
}

export const TEST_APPROVAL_MODE = 'manual'

/**
 * The build-identity fields every full `_session_info` carries upstream, as
 * the reference Hermes (docs/refs.md) reports them. Spread into the
 * `SessionInfo` literals so they model the real wire shape; the adapter reads
 * none of them.
 */
export const TEST_GATEWAY_BUILD_IDENTITY: Pick<SessionInfo, 'version' | 'release_date' | 'desktop_contract'> = {
  version: '0.21.3',
  // `hermes_cli.__release_date__`'s own format, dots not dashes.
  release_date: '2026.9.14',
  desktop_contract: 7,
}

/**
 * Script the two settings reads every `session/new` makes. Sessions are created
 * in nearly every test file, so this keeps the model/mode surface out of tests
 * that are about something else.
 */
/**
 * Command catalog every slash-command test starts from. Deliberately mixed:
 * a plain command, one with subcommands, one reachable through an alias, an
 * excluded TUI command, and a skill command (which upstream lists in `pairs`
 * and `skills` but never in `canon`).
 */
export const TEST_COMMAND_CATALOG: CommandsCatalogResult = {
  pairs: [
    ['/status', 'Show session status'],
    ['/snapshot', 'Manage snapshots (usage: /snapshot list|restore)'],
    ['/retry', 'Resend the last prompt'],
    ['/undo', 'Remove the last exchange and hand its prompt back'],
    ['/theme', 'Change the terminal theme'],
    ['/work', 'Run the work skill'],
  ],
  canon: {
    '/status': '/status',
    '/st': '/status',
    '/snapshot': '/snapshot',
    '/snap': '/snapshot',
    '/retry': '/retry',
    '/undo': '/undo',
    '/theme': '/theme',
  },
  sub: { '/snapshot': ['list', 'restore'], '/hidden': ['nope'] },
  skills: { '/work': { usage: 3, origin: 'local' } },
  skill_count: 1,
  warning: '',
}

export function scriptSessionSettings(
  gateway: ScriptedGateway,
  options: { readonly catalog?: ModelOptionsResult; readonly approvalMode?: string } = {},
): void {
  gateway.setResult('modelOptions', options.catalog ?? TEST_MODEL_CATALOG)
  gateway.setResult('configGet', { value: options.approvalMode ?? TEST_APPROVAL_MODE })
}

// ── Recorded ACP transcript ─────────────────────────────────────────────────

/** A promise that never settles stands in for a card the user leaves open. */
export type ElicitationResponder = (
  params: CreateElicitationRequest,
) => CreateElicitationResponse | Promise<CreateElicitationResponse>

export type AcpRecordKind = 'notification' | 'request'

/** One client-bound message the adapter sent, in arrival order. */
export interface AcpRecord {
  readonly kind: AcpRecordKind
  readonly method: string
  readonly params: unknown
}

/**
 * Replace the value of every field named (or path-addressed) in
 * `fieldsToAnonymize` with the field name, so transcripts containing
 * generated ids stay snapshot-stable.
 */
function anonymizeValue(value: unknown, path: readonly string[], fieldsToAnonymize: ReadonlySet<string>): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => anonymizeValue(item, [...path, String(index)], fieldsToAnonymize))
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => {
      const nextPath = [...path, key]
      if (fieldsToAnonymize.has(key) || fieldsToAnonymize.has(nextPath.join('.'))) {
        return [key, key]
      }
      return [key, anonymizeValue(nested, nextPath, fieldsToAnonymize)]
    }),
  )
}

// ── Fixture ─────────────────────────────────────────────────────────────────

export interface AcpTestFixture {
  /** The scripted gateway wired into the server under test. */
  readonly gateway: ScriptedGateway
  /** The real server under test. */
  readonly server: HermesAcpServer
  /** The cwd cache the server was built with, backed by a temp file, so list
   * and delete tests can seed and inspect it directly. */
  readonly sessionDirectory: SessionDirectory
  /** Client-side context: call agent methods (initialize, session/*, …). */
  readonly client: acp.ClientContext
  /** Agent-side context: call client methods, as the server does mid-turn. */
  readonly agent: acp.AgentContext

  /** Client-bound messages recorded so far, oldest first. */
  transcript(ignoredFields?: readonly string[]): readonly AcpRecord[]
  clearTranscript(): void

  /** A promise holds the prompt open, which is how a test arranges for the
   * turn to end while the user is still deciding. */
  setPermissionResponse(response: RequestPermissionResponse | Promise<RequestPermissionResponse>): void
  /** A function answers each request from its params, which is what a batch
   * clarify needs: one elicitation per question, a different answer each. */
  setElicitationResponse(response: CreateElicitationResponse | ElicitationResponder): void

  /**
   * Open a session whose `session/update` delivery can be made to fail, and
   * return its id alongside the switch that starts failing it.
   *
   * `session/new` is called on the server directly rather than over the ACP
   * connection because the failure has to be injected into the AgentContext the
   * session's update channel captures, and the SDK builds a fresh one per
   * inbound request. Failing at the transport instead is not an option: a write
   * error closes the whole connection (jsonrpc.js `sendWireMessage`), which
   * would take the pending prompt's response down with it and hide the very
   * outcome under test.
   */
  newSessionWithFailableUpdates(params: NewSessionRequest): Promise<{
    readonly sessionId: string
    readonly failUpdates: () => void
  }>

  close(): void
}

export function createAcpTestFixture(): AcpTestFixture {
  const gateway = new ScriptedGateway()
  // A real temp file, not a fake: every fixture exercises the same atomic
  // persistence the production path does, and close() removes it.
  const directoryScratch = mkdtempSync(join(tmpdir(), 'hermes-acp-fixture-'))
  const sessionDirectory = SessionDirectory.load(join(directoryScratch, SESSION_DIRECTORY_FILENAME))
  const server = new HermesAcpServer(gateway, sessionDirectory)

  const records: AcpRecord[] = []
  const record = (kind: AcpRecordKind, method: string, params: unknown): void => {
    records.push({ kind, method, params })
  }

  let permissionResponse: RequestPermissionResponse | Promise<RequestPermissionResponse> = DEFAULT_PERMISSION_RESPONSE
  let elicitationResponse: CreateElicitationResponse | ElicitationResponder = DEFAULT_ELICITATION_RESPONSE

  // Only the client methods the adapter actually calls are handled; anything
  // else must surface as a protocol error rather than a silent success.
  const clientApp = acp
    .client({ name: TEST_CLIENT_NAME })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      record('notification', acp.methods.client.session.update, ctx.params)
    })
    .onNotification(acp.methods.client.elicitation.complete, (ctx) => {
      record('notification', acp.methods.client.elicitation.complete, ctx.params)
    })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      record('request', acp.methods.client.session.requestPermission, ctx.params)
      return permissionResponse
    })
    .onRequest(acp.methods.client.elicitation.create, (ctx) => {
      record('request', acp.methods.client.elicitation.create, ctx.params)
      return typeof elicitationResponse === 'function' ? elicitationResponse(ctx.params) : elicitationResponse
    })

  const agentContexts: acp.AgentContext[] = []
  const agentApp = buildAgentApp(server).onConnect((connection) => {
    agentContexts.push(connection.client)
  })

  const connection = clientApp.connect(agentApp)
  const agentContext = agentContexts[0]
  if (!agentContext) {
    throw new Error('acp test fixture: agent connect handler did not run')
  }

  return {
    gateway,
    server,
    sessionDirectory,
    client: connection.agent,
    agent: agentContext,

    transcript(ignoredFields: readonly string[] = []): readonly AcpRecord[] {
      const fields = new Set(ignoredFields)
      return records.map((entry) => ({
        kind: entry.kind,
        method: entry.method,
        params: anonymizeValue(entry.params, [], fields),
      }))
    },
    clearTranscript(): void {
      records.length = 0
    },
    setPermissionResponse(response: RequestPermissionResponse | Promise<RequestPermissionResponse>): void {
      permissionResponse = response
    },
    setElicitationResponse(response: CreateElicitationResponse | ElicitationResponder): void {
      elicitationResponse = response
    },
    async newSessionWithFailableUpdates(params: NewSessionRequest) {
      let failing = false
      // A Proxy over the real context, so every other call still travels the
      // real connection and lands in the transcript. `notify` is invoked on the
      // target, never on the receiver: the SDK's context reads private fields.
      const context = new Proxy(agentContext, {
        get(target, property, receiver: unknown) {
          if (property === 'notify') {
            return (method: string, notifyParams: unknown): Promise<void> =>
              failing
                ? Promise.reject(new Error(UPDATE_DELIVERY_FAILURE))
                : (target.notify as (m: string, p: unknown) => Promise<void>).call(target, method, notifyParams)
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      const created = await server.newSession(params, context)
      return {
        sessionId: created.sessionId,
        failUpdates: (): void => {
          failing = true
        },
      }
    },
    close(): void {
      connection.close()
      rmSync(directoryScratch, { recursive: true, force: true })
    },
  }
}
