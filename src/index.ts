#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'

import { buildAgentApp } from './app.js'
import {
  AGENT_NAME,
  AGENT_VERSION,
  AUTH_SETUP_FLAG,
  AUTH_SETUP_HERMES_ARGS,
  DEFAULT_HERMES_BIN,
  ENV_HERMES_BIN,
} from './constants.js'
import { GatewayClient } from './gateway/GatewayClient.js'
import { gatewayOptionsFromEnv } from './gateway/options.js'
import { HermesGatewayClient } from './gateway/HermesGatewayClient.js'
import { HermesAcpServer } from './HermesAcpServer.js'
import { SessionDirectory, sessionDirectoryPath } from './session/sessionDirectory.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The terminal auth method's flag.
 *
 * ACP terminal auth has no command of its own: the client re-runs the agent
 * invocation it already has with the advertised args appended, so the flag has
 * to live here. It hands off to the Hermes CLI's interactive provider/model
 * picker — the same flow upstream's `hermes-acp --setup` wraps — with stdio
 * inherited, because the whole point is that a human answers its prompts. No
 * gateway is started: this process is a launcher, not an ACP agent.
 */
function runSetup(): never {
  const bin = process.env[ENV_HERMES_BIN] ?? DEFAULT_HERMES_BIN
  const result = spawnSync(bin, [...AUTH_SETUP_HERMES_ARGS], { stdio: 'inherit' })
  if (result.error) {
    console.error(`[hermes-agent-acp] failed to run ${bin} ${AUTH_SETUP_HERMES_ARGS.join(' ')}: ${errorMessage(result.error)}`)
    process.exit(1)
  }
  if (result.signal !== null) {
    console.error(`[hermes-agent-acp] ${bin} ${AUTH_SETUP_HERMES_ARGS.join(' ')} was killed by ${result.signal}`)
    process.exit(1)
  }
  process.exit(result.status ?? 1)
}

async function main(): Promise<void> {
  if (process.argv.includes('--version')) {
    console.log(`${AGENT_NAME} ${AGENT_VERSION}`)
    return
  }

  if (process.argv.includes(AUTH_SETUP_FLAG)) {
    runSetup()
  }

  const gateway = new GatewayClient(gatewayOptionsFromEnv(process.env))

  let exiting = false
  const shutdown = async (code: number, reason: string): Promise<void> => {
    if (exiting) {
      return
    }
    exiting = true
    try {
      await gateway.kill(reason)
      // A response the SDK just queued (the typed error a gateway death
      // produces, for one) is still in stdout's pipe buffer; process.exit
      // does not flush it. An empty write's callback runs after everything
      // queued before it.
      await new Promise<void>((resolve) => process.stdout.write('', () => resolve()))
    } finally {
      process.exit(code)
    }
  }

  process.on('SIGTERM', () => {
    void shutdown(0, 'sigterm')
  })
  process.on('SIGINT', () => {
    void shutdown(0, 'sigint')
  })

  // Start the Hermes gateway before accepting ACP connections so a broken
  // Hermes install fails the process at spawn time with a clear error,
  // rather than surfacing as protocol errors on the first request.
  try {
    await gateway.start()
  } catch (error) {
    console.error(`[hermes-agent-acp] failed to start Hermes gateway: ${errorMessage(error)}`)
    await gateway.kill('startup failed')
    process.exit(1)
  }

  try {
    const server = new HermesAcpServer(
      new HermesGatewayClient(gateway),
      SessionDirectory.load(sessionDirectoryPath(process.env)),
    )
    const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
    const connection = buildAgentApp(server).connect(stream)

    // Registered after the server exists so a mid-turn death fails the turns
    // first (typed prompt errors, flushed) and only then exits. An exit during
    // `gateway.start()` is already handled by its catch above. Non-zero so a
    // supervising client's restart policy can bring the adapter back up.
    gateway.onExit((code) => {
      const reason = `Hermes gateway exited unexpectedly (code ${code ?? 'null'})`
      console.error(`[hermes-agent-acp] ${reason}`)
      void server
        .gatewayExited(reason)
        .catch((error: unknown) => {
          console.error(`[hermes-agent-acp] failed to settle turns after the gateway exited: ${errorMessage(error)}`)
        })
        .finally(() => shutdown(1, 'gateway exited unexpectedly'))
    })

    void connection.closed
      .then(async () => {
        // Settle in-flight turns and stop the gateway working on them before the
        // process goes down; the ACP semantics of that live on the server.
        await server.connectionClosed()
        await shutdown(0, 'acp connection closed')
      })
      .catch((error: unknown) => {
        // `closed` only resolves today, but the no-unobserved-rejection rule
        // holds regardless: if teardown ever rejects, still bring the process down.
        console.error(`[hermes-agent-acp] fatal during connection teardown: ${errorMessage(error)}`)
        void shutdown(1, 'connection teardown failed')
      })
  } catch (error) {
    // ACP wiring failed after the gateway child was already spawned; tear it
    // down instead of leaving teardown to the parent-death watchdog.
    console.error(`[hermes-agent-acp] fatal: ${errorMessage(error)}`)
    await shutdown(1, 'acp wiring failed')
  }
}

main().catch((error: unknown) => {
  console.error(`[hermes-agent-acp] fatal: ${errorMessage(error)}`)
  process.exit(1)
})
