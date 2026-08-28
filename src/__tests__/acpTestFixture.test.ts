import * as acp from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { createAcpTestFixture, ScriptedGateway, type AcpTestFixture } from './acpTestFixture.js'

const SESSION_ID = 'session-under-test'

let fixture: AcpTestFixture | null = null

const openFixture = (): AcpTestFixture => {
  fixture = createAcpTestFixture()
  return fixture
}

afterEach(() => {
  fixture?.close()
  fixture = null
})

describe('scripted gateway', () => {
  it('records calls and answers with the scripted result', async () => {
    const gateway = new ScriptedGateway()
    gateway.setResult('sessionCreate', { session_id: SESSION_ID })

    const result = await gateway.sessionCreate({ cwd: '/workspace' })

    expect(result.session_id).toBe(SESSION_ID)
    expect(gateway.recordedCalls()).toEqual([{ method: 'sessionCreate', args: [{ cwd: '/workspace' }] }])
  })

  it('rejects a call with no scripted result instead of returning a placeholder', async () => {
    const gateway = new ScriptedGateway()

    await expect(gateway.promptSubmit({ session_id: SESSION_ID, text: 'hi' })).rejects.toThrow(
      /no result configured for promptSubmit/,
    )
    expect(gateway.recordedCalls()).toHaveLength(1)
  })

  it('delivers emitted events to subscribers until they unsubscribe', () => {
    const gateway = new ScriptedGateway()
    const seen: string[] = []
    const unsubscribe = gateway.onEvent((event) => {
      seen.push(event.type)
    })

    gateway.emit({ type: 'message.delta', session_id: SESSION_ID, payload: { text: 'chunk' } })
    unsubscribe()
    gateway.emit({ type: 'message.complete', session_id: SESSION_ID, payload: { status: 'complete' } })

    expect(seen).toEqual(['message.delta'])
  })
})

describe('recorded acp client', () => {
  it('denies permission requests that a test has not answered', async () => {
    const scenario = openFixture()

    const response = await scenario.agent.request(acp.methods.client.session.requestPermission, {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: 'tool-1' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    })

    expect(response.outcome).toEqual({ outcome: 'cancelled' })
  })

  it('cancels elicitations that a test has not answered', async () => {
    const scenario = openFixture()

    const response = await scenario.agent.request(acp.methods.client.elicitation.create, {
      mode: 'form',
      sessionId: SESSION_ID,
      message: 'Which branch?',
      requestedSchema: { type: 'object', properties: {} },
    })

    expect(response.action).toBe('cancel')
  })

  it('honors a scripted permission answer', async () => {
    const scenario = openFixture()
    scenario.setPermissionResponse({ outcome: { outcome: 'selected', optionId: 'allow' } })

    const response = await scenario.agent.request(acp.methods.client.session.requestPermission, {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: 'tool-1' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    })

    expect(response.outcome).toEqual({ outcome: 'selected', optionId: 'allow' })
  })

  it('transcribes client-bound messages and anonymizes ignored fields', async () => {
    const scenario = openFixture()

    await scenario.agent.notify(acp.methods.client.session.update, {
      sessionId: SESSION_ID,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    })

    expect(scenario.transcript()).toEqual([
      {
        kind: 'notification',
        method: acp.methods.client.session.update,
        params: {
          sessionId: SESSION_ID,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
        },
      },
    ])

    scenario.clearTranscript()
    expect(scenario.transcript()).toEqual([])
  })
})
