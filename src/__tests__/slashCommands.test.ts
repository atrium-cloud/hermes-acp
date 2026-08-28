/**
 * Slash commands end to end through the fixture: a scripted `commands.catalog`
 * in, an `available_commands_update` out, and prompts that start with "/"
 * routed to `slash.exec` / `command.dispatch` instead of the model.
 */

import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { GATEWAY_CODE_USE_COMMAND_DISPATCH } from '../constants.js'
import { GatewayRpcError } from '../gateway/GatewayClient.js'
import type { GatewayEvent } from '../gateway/types.js'
import type { AcpTestFixture, GatewayRequestMethod, ScriptedGateway } from './acpTestFixture.js'
import {
  createAcpTestFixture,
  scriptSessionSettings,
  TEST_COMMAND_CATALOG,
  UPDATE_DELIVERY_FAILURE,
} from './acpTestFixture.js'

const TEST_CWD = '/tmp/hermes-acp-slash-commands'
// Live gateway id (events, slash.exec/prompt.submit calls); the ACP sessionId
// is the stored key below, distinct on purpose.
const SESSION_ID = 'gw-session-1'
const STORED_SESSION_ID = 'stored-session-1'

const CALL_POLL_INTERVAL_MS = 1
const CALL_POLL_ATTEMPTS = 500

async function waitForGatewayCall(gateway: ScriptedGateway, method: GatewayRequestMethod): Promise<void> {
  for (let attempt = 0; attempt < CALL_POLL_ATTEMPTS; attempt += 1) {
    if (gateway.recordedCalls().some((call) => call.method === method)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, CALL_POLL_INTERVAL_MS))
  }
  throw new Error(`scripted gateway: ${method}() was never called`)
}

/** Terminal frame for the turn a `send`-shaped command submits. */
const TURN_COMPLETE: GatewayEvent = {
  type: 'message.complete',
  session_id: SESSION_ID,
  payload: { status: 'complete' },
}

async function openSession(
  fixture: AcpTestFixture,
  options: { readonly withCatalog?: boolean } = {},
): Promise<void> {
  fixture.gateway.setResult('sessionCreate', { session_id: SESSION_ID, stored_session_id: STORED_SESSION_ID })
  scriptSessionSettings(fixture.gateway)
  if (options.withCatalog !== false) {
    fixture.gateway.setResult('commandsCatalog', TEST_COMMAND_CATALOG)
  }
  await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
}

function commandUpdates(fixture: AcpTestFixture): readonly acp.AvailableCommand[][] {
  return fixture
    .transcript()
    .filter((entry) => entry.method === acp.methods.client.session.update)
    .map((entry) => (entry.params as { update: acp.SessionUpdate }).update)
    .filter((update) => update.sessionUpdate === 'available_commands_update')
    .map((update) => update.availableCommands)
}

function messageChunks(fixture: AcpTestFixture): readonly string[] {
  return fixture
    .transcript()
    .filter((entry) => entry.method === acp.methods.client.session.update)
    .map((entry) => (entry.params as { update: acp.SessionUpdate }).update)
    .flatMap((update) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : [],
    )
}

describe('slash command advertisement', () => {
  it('sends the catalog as available_commands_update with the TUI-only commands excluded', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      expect(commandUpdates(fixture)).toEqual([
        [
          { name: 'status', description: 'Show session status' },
          {
            name: 'snapshot',
            description: 'Manage snapshots (usage: /snapshot list|restore)',
            // Subcommands ride the one free-text hint ACP models input with;
            // `/hidden` is in `sub` but not in `pairs`, so it never appears.
            input: { hint: 'list|restore' },
          },
          { name: 'retry', description: 'Resend the last prompt' },
          { name: 'undo', description: 'Remove the last exchange and hand its prompt back' },
          // `/theme` is dropped: its only effect is on Hermes' own terminal UI.
          { name: 'work', description: 'Run the work skill' },
        ],
      ])
    } finally {
      fixture.close()
    }
  })

  it('opens the session without commands when the catalog read fails', async () => {
    const fixture = createAcpTestFixture()
    try {
      // No `commandsCatalog` scripted: the call rejects.
      await openSession(fixture, { withCatalog: false })

      // The session still exists and is promptable — commands are an
      // enhancement, not a precondition.
      expect(fixture.server.session(STORED_SESSION_ID)).toBeDefined()
      expect(commandUpdates(fixture)).toEqual([])
    } finally {
      fixture.close()
    }
  })
})

describe('slash command invocation', () => {
  it('routes a recognized command to slash.exec and ends the turn with its output', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.clearRecordedCalls()
      fixture.clearTranscript()
      fixture.gateway.setResult('slashExec', { output: 'model: hermes-4-70b' })

      const response = await fixture.client.request(acp.methods.agent.session.prompt, {
        sessionId: STORED_SESSION_ID,
        prompt: [{ type: 'text', text: '  /st  --verbose  ' }],
      })

      // The alias resolved to its canonical name and the argument rode along.
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'slashExec', args: [{ session_id: SESSION_ID, command: '/status --verbose' }] },
      ])
      expect(messageChunks(fixture)).toEqual(['model: hermes-4-70b'])
      // A real stop reason, not a fabricated one: the command genuinely ran.
      expect(response.stopReason).toBe('end_turn')
    } finally {
      fixture.close()
    }
  })

  it('fails the command turn when its output could not be delivered', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', { session_id: SESSION_ID, stored_session_id: STORED_SESSION_ID })
      scriptSessionSettings(fixture.gateway)
      fixture.gateway.setResult('commandsCatalog', TEST_COMMAND_CATALOG)
      const session = await fixture.newSessionWithFailableUpdates({ cwd: TEST_CWD, mcpServers: [] })
      fixture.gateway.setResult('slashExec', { output: 'model: hermes-4-70b' })

      session.failUpdates()

      // The command ran, but its output never reached the client, so reporting
      // end_turn would describe a turn the user saw nothing of.
      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/status' }],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining(`session/update delivery failed: ${UPDATE_DELIVERY_FAILURE} during the command turn`),
      })
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('passes an unrecognized slash word through to the model as ordinary text', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.clearRecordedCalls()
      fixture.gateway.setResult('promptSubmit', { status: 'streaming' })

      const response = fixture.client.request(acp.methods.agent.session.prompt, {
        sessionId: STORED_SESSION_ID,
        prompt: [{ type: 'text', text: '/usr/local/bin exists?' }],
      })
      await waitForGatewayCall(fixture.gateway, 'promptSubmit')
      fixture.gateway.emit(TURN_COMPLETE)
      await response

      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'promptSubmit', args: [{ session_id: SESSION_ID, text: '/usr/local/bin exists?' }] },
      ])
    } finally {
      fixture.close()
    }
  })

  it('re-issues on command.dispatch when slash.exec refuses a skill command', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.clearRecordedCalls()
      fixture.clearTranscript()
      fixture.gateway.setFailure(
        'slashExec',
        new GatewayRpcError('skill command: use command.dispatch for /work', GATEWAY_CODE_USE_COMMAND_DISPATCH),
      )
      fixture.gateway.setResult('commandDispatch', {
        type: 'skill',
        name: 'work',
        message: 'Follow the work skill: <scaffold>',
        display: 'Running skill: work',
      })
      fixture.gateway.setResult('promptSubmit', { status: 'streaming' })

      const response = fixture.client.request(acp.methods.agent.session.prompt, {
        sessionId: STORED_SESSION_ID,
        prompt: [{ type: 'text', text: '/work refactor the parser' }],
      })
      await waitForGatewayCall(fixture.gateway, 'promptSubmit')
      fixture.gateway.emit(TURN_COMPLETE)

      expect((await response).stopReason).toBe('end_turn')
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'slashExec', args: [{ session_id: SESSION_ID, command: '/work refactor the parser' }] },
        {
          method: 'commandDispatch',
          args: [{ name: 'work', arg: 'refactor the parser', session_id: SESSION_ID }],
        },
        // The dispatched message is submitted as a real turn, so the user gets
        // streaming and a real stop reason rather than a summary.
        { method: 'promptSubmit', args: [{ session_id: SESSION_ID, text: 'Follow the work skill: <scaffold>' }] },
      ])
      // `display`, not `message`: the scaffold is model-facing.
      expect(messageChunks(fixture)).toEqual(['Running skill: work'])
    } finally {
      fixture.close()
    }
  })

  it('submits the message of a send-shaped result and shows its notice first', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.clearRecordedCalls()
      fixture.clearTranscript()
      // `/retry` is a pending-input command: slash.exec reroutes it upstream and
      // answers with command.dispatch's payload directly.
      fixture.gateway.setResult('slashExec', {
        type: 'send',
        message: 'summarize the repo',
        notice: 'Resending the last prompt',
      })
      fixture.gateway.setResult('promptSubmit', { status: 'streaming' })

      const response = fixture.client.request(acp.methods.agent.session.prompt, {
        sessionId: STORED_SESSION_ID,
        prompt: [{ type: 'text', text: '/retry' }],
      })
      await waitForGatewayCall(fixture.gateway, 'promptSubmit')
      fixture.gateway.emit(TURN_COMPLETE)

      expect((await response).stopReason).toBe('end_turn')
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'slashExec', args: [{ session_id: SESSION_ID, command: '/retry' }] },
        { method: 'promptSubmit', args: [{ session_id: SESSION_ID, text: 'summarize the repo' }] },
      ])
      expect(messageChunks(fixture)).toEqual(['Resending the last prompt'])
    } finally {
      fixture.close()
    }
  })

  it('shows a prefill result without submitting it', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.clearRecordedCalls()
      fixture.clearTranscript()
      fixture.gateway.setResult('slashExec', {
        type: 'prefill',
        message: 'the prompt that was undone',
        notice: 'Removed the last exchange',
      })

      // `/undo` is a pending-input command: slash.exec reroutes it and answers
      // with the dispatch payload, which for undo is a prefill.
      const response = await fixture.client.request(acp.methods.agent.session.prompt, {
        sessionId: STORED_SESSION_ID,
        prompt: [{ type: 'text', text: '/undo' }],
      })

      // Nothing was submitted: auto-resending the popped prompt would act on
      // the user's behalf.
      expect(fixture.gateway.recordedCalls().map((call) => call.method)).toEqual(['slashExec'])
      expect(messageChunks(fixture)).toEqual(['Removed the last exchange', 'the prompt that was undone'])
      expect(response.stopReason).toBe('end_turn')
    } finally {
      fixture.close()
    }
  })

  it('refuses a command that carries additional content blocks', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.clearRecordedCalls()

      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [
            { type: 'text', text: '/status' },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          ],
        }),
      ).rejects.toThrow(/cannot carry additional content blocks/)
      // Refused before anything was staged or executed.
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('follows an alias exactly once', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.clearRecordedCalls()
      fixture.clearTranscript()
      // A quick command of type "alias": the target is a whole command line,
      // whose own arguments win over the invocation's.
      fixture.gateway.setResult('slashExec', { type: 'alias', target: '/status --brief' })
      fixture.gateway.setResult('commandDispatch', { type: 'exec', output: 'idle' })

      const response = await fixture.client.request(acp.methods.agent.session.prompt, {
        sessionId: STORED_SESSION_ID,
        prompt: [{ type: 'text', text: '/retry ignored' }],
      })

      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'slashExec', args: [{ session_id: SESSION_ID, command: '/retry ignored' }] },
        { method: 'commandDispatch', args: [{ name: 'status', arg: '--brief', session_id: SESSION_ID }] },
      ])
      expect(messageChunks(fixture)).toEqual(['idle'])
      expect(response.stopReason).toBe('end_turn')
    } finally {
      fixture.close()
    }
  })

  it('refuses an alias that resolves to another alias', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('slashExec', { type: 'alias', target: '/status' })
      fixture.gateway.setResult('commandDispatch', { type: 'alias', target: '/retry' })

      // command.dispatch resolves aliases itself, so a second one is a cycle in
      // the user's quick_commands config rather than a hop worth chasing.
      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [{ type: 'text', text: '/retry' }],
        }),
      ).rejects.toThrow(/aliases through \/status to another alias/)
    } finally {
      fixture.close()
    }
  })

  it('reports a command cancelled mid-flight without submitting its message', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.clearRecordedCalls()
      // The command is still running when the user cancels; it would otherwise
      // have started a whole new Hermes turn.
      let release: (result: { readonly type: 'send'; readonly message: string }) => void = () => undefined
      fixture.gateway.setResult(
        'slashExec',
        new Promise((resolve) => {
          release = resolve
        }),
      )
      fixture.gateway.setResult('sessionInterrupt', { status: 'ok' })

      const response = fixture.client.request(acp.methods.agent.session.prompt, {
        sessionId: STORED_SESSION_ID,
        prompt: [{ type: 'text', text: '/retry' }],
      })
      await new Promise((resolve) => setTimeout(resolve, CALL_POLL_INTERVAL_MS))
      await fixture.client.notify(acp.methods.agent.session.cancel, { sessionId: STORED_SESSION_ID })
      // The cancel races the release below; the session.interrupt call is its
      // observable effect, so wait for it rather than for a wall-clock delay.
      await waitForGatewayCall(fixture.gateway, 'sessionInterrupt')
      release({ type: 'send', message: 'summarize the repo' })

      expect((await response).stopReason).toBe('cancelled')
      expect(fixture.gateway.recordedCalls().map((call) => call.method)).toEqual(['slashExec', 'sessionInterrupt'])
    } finally {
      fixture.close()
    }
  })

  it('surfaces a real slash.exec failure as a protocol error', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setFailure('slashExec', new GatewayRpcError('slash worker start failed: no python', 5030))

      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [{ type: 'text', text: '/status' }],
        }),
      ).rejects.toThrow(/gateway method slash.exec failed: slash worker start failed/)
    } finally {
      fixture.close()
    }
  })
})
