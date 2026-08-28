import * as acp from '@agentclientprotocol/sdk'

import { AGENT_NAME } from './constants.js'
import { HermesAcpServer } from './HermesAcpServer.js'

export function buildAgentApp(server: HermesAcpServer): acp.AgentApp {
  return acp
    .agent({ name: AGENT_NAME })
    .onRequest(acp.methods.agent.initialize, (ctx) => server.initialize(ctx.params))
    .onRequest(acp.methods.agent.authenticate, (ctx) => server.authenticate(ctx.params))
    .onRequest(acp.methods.agent.session.new, (ctx) => server.newSession(ctx.params, ctx.client))
    .onRequest(acp.methods.agent.session.list, (ctx) => server.listSessions(ctx.params))
    .onRequest(acp.methods.agent.session.resume, (ctx) => server.resumeSession(ctx.params, ctx.client))
    .onRequest(acp.methods.agent.session.load, (ctx) => server.loadSession(ctx.params, ctx.client))
    .onRequest(acp.methods.agent.session.close, (ctx) => server.closeSession(ctx.params))
    .onRequest(acp.methods.agent.session.delete, (ctx) => server.deleteSession(ctx.params))
    .onRequest(acp.methods.agent.session.fork, (ctx) => server.forkSession(ctx.params, ctx.client))
    .onRequest(acp.methods.agent.session.setMode, (ctx) => server.setSessionMode(ctx.params))
    // `ctx.signal` is the request's own AbortSignal (`$/cancel_request`): the
    // expensive-model confirmation is a client round-trip that must not
    // outlive the request that opened it, and a cancelled prompt request
    // cancels its turn.
    .onRequest(acp.methods.agent.session.setConfigOption, (ctx) =>
      server.setSessionConfigOption(ctx.params, ctx.signal),
    )
    .onRequest(acp.methods.agent.session.prompt, (ctx) => server.prompt(ctx.params, ctx.signal))
    .onNotification(acp.methods.agent.session.cancel, (ctx) => server.cancel(ctx.params))
}
