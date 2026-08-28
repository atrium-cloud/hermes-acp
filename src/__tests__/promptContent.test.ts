/**
 * Prompt content-block tests: rich blocks in, staged gateway attachments plus
 * one flat prompt text out. Scripted gateway, no real Hermes.
 */

import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { GatewayRpcError } from '../gateway/GatewayClient.js'
import type { AcpTestFixture, GatewayRequestMethod, ScriptedGateway } from './acpTestFixture.js'
import { createAcpTestFixture, scriptSessionSettings } from './acpTestFixture.js'

// ── Constants ───────────────────────────────────────────────────────────────

const TEST_CWD = '/tmp/hermes-acp-prompt-content'
// Live gateway id (events, attachment/prompt.submit calls); the ACP sessionId
// is the stored key below, distinct on purpose.
const SESSION_ID = 'gw-session-1'
const STORED_SESSION_ID = 'stored-session-1'

const CALL_POLL_INTERVAL_MS = 1
const CALL_POLL_ATTEMPTS = 500

const IMAGE_BASE64 = 'aW1hZ2UtYnl0ZXM='
const PDF_BASE64 = 'JVBERi0xLjQK'
const BINARY_BASE64 = 'YmluYXJ5'
const RESOURCE_TEXT = 'line one\nline two'
/** base64 of RESOURCE_TEXT — file.attach uploads text resources as bytes. */
const RESOURCE_TEXT_BASE64 = 'bGluZSBvbmUKbGluZSB0d28='

const STAGED_IMAGE_PATH = '/home/hermes/.hermes/images/upload_1.png'
const IMAGE_MARKER = '[User attached image: upload_1.png]'
const FILE_REF_TEXT = '@file:.hermes/attachments/notes.txt'

const IMAGE_ATTACH_RESULT = {
  attached: true,
  path: STAGED_IMAGE_PATH,
  count: 1,
  remainder: '',
  text: IMAGE_MARKER,
  bytes: 12,
  name: 'upload_1.png',
} as const

const FILE_ATTACH_RESULT = {
  attached: true,
  name: 'notes.txt',
  path: '/home/hermes/work/.hermes/attachments/notes.txt',
  ref_path: '.hermes/attachments/notes.txt',
  ref_text: FILE_REF_TEXT,
  uploaded: true,
} as const

// ── Helpers ─────────────────────────────────────────────────────────────────

async function waitForGatewayCall(gateway: ScriptedGateway, method: GatewayRequestMethod): Promise<void> {
  for (let attempt = 0; attempt < CALL_POLL_ATTEMPTS; attempt += 1) {
    if (gateway.recordedCalls().some((call) => call.method === method)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, CALL_POLL_INTERVAL_MS))
  }
  throw new Error(`scripted gateway: ${method}() was never called`)
}

async function openSession(fixture: AcpTestFixture): Promise<void> {
  fixture.gateway.setResult('sessionCreate', { session_id: SESSION_ID, stored_session_id: STORED_SESSION_ID })
  scriptSessionSettings(fixture.gateway)
  await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })
  fixture.gateway.clearRecordedCalls()
  fixture.clearTranscript()
}

/** Run a prompt to completion and return its stop reason. */
async function runPrompt(fixture: AcpTestFixture, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
  fixture.gateway.setResult('promptSubmit', { status: 'streaming' })
  const response = fixture.client.request(acp.methods.agent.session.prompt, { sessionId: STORED_SESSION_ID, prompt })
  await waitForGatewayCall(fixture.gateway, 'promptSubmit')
  fixture.gateway.emit({ type: 'message.complete', session_id: SESSION_ID, payload: { status: 'complete' } })
  return response
}

/** The `text` the adapter handed `prompt.submit`. */
function submittedText(fixture: AcpTestFixture): string {
  const submit = fixture.gateway.recordedCalls().find((call) => call.method === 'promptSubmit')
  if (!submit) {
    throw new Error('promptSubmit was never called')
  }
  return (submit.args[0] as { text: string }).text
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('prompt content blocks', () => {
  it('stages an image before submitting and leaves the prompt text as the user wrote it', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('imageAttachBytes', IMAGE_ATTACH_RESULT)

      expect(
        await runPrompt(fixture, [
          { type: 'text', text: 'what is this' },
          { type: 'image', data: IMAGE_BASE64, mimeType: 'image/png', uri: 'file:///tmp/shot.png' },
        ]),
      ).toEqual({ stopReason: 'end_turn' })

      // Order matters: staged images ride the NEXT submit, so an
      // attach after the submit would land on the following turn.
      expect(fixture.gateway.recordedCalls()).toEqual([
        {
          method: 'imageAttachBytes',
          args: [{ session_id: SESSION_ID, content_base64: IMAGE_BASE64, filename: 'shot.png' }],
        },
        { method: 'promptSubmit', args: [{ session_id: SESSION_ID, text: 'what is this' }] },
      ])
    } finally {
      fixture.close()
    }
  })

  it('names the image from its mime type when the block carries no uri', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('imageAttachBytes', IMAGE_ATTACH_RESULT)

      await runPrompt(fixture, [
        { type: 'text', text: 'look' },
        { type: 'image', data: IMAGE_BASE64, mimeType: 'image/jpeg' },
      ])

      expect(fixture.gateway.recordedCalls()[0]).toEqual({
        method: 'imageAttachBytes',
        args: [{ session_id: SESSION_ID, content_base64: IMAGE_BASE64, filename: 'image.jpeg' }],
      })
    } finally {
      fixture.close()
    }
  })

  it('submits the upstream attachment markers when the prompt is an image and nothing else', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('imageAttachBytes', IMAGE_ATTACH_RESULT)

      await runPrompt(fixture, [{ type: 'image', data: IMAGE_BASE64, mimeType: 'image/png' }])

      // prompt.submit accepts empty text, but no upstream client submits it
      // that way; the attach method's own marker stands in.
      expect(submittedText(fixture)).toBe(IMAGE_MARKER)
    } finally {
      fixture.close()
    }
  })

  it('fails the prompt and detaches what it already staged when an attach fails', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('imageAttachBytes', IMAGE_ATTACH_RESULT)
      fixture.gateway.setFailure('fileAttach', new GatewayRpcError('workspace is read-only', 5028))
      fixture.gateway.setResult('imageDetach', { detached: true, count: 0 })

      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [
            { type: 'image', data: IMAGE_BASE64, mimeType: 'image/png' },
            {
              type: 'resource',
              resource: { uri: 'file:///tmp/notes.txt', mimeType: 'text/plain', text: RESOURCE_TEXT },
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('gateway method file.attach failed: workspace is read-only'),
      })

      // The successfully staged image is unstaged again: left behind, it would
      // ride the next turn the user submits.
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'imageAttachBytes', args: [expect.anything()] },
        { method: 'fileAttach', args: [expect.anything()] },
        { method: 'imageDetach', args: [{ session_id: SESSION_ID, path: STAGED_IMAGE_PATH }] },
      ])
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('detaches staged images when the submit they were staged for fails', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('imageAttachBytes', IMAGE_ATTACH_RESULT)
      fixture.gateway.setResult('imageDetach', { detached: true, count: 0 })
      // A busy session rejects the submit after the image is already staged.
      fixture.gateway.setFailure('promptSubmit', new GatewayRpcError('session is already running', 4001))

      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [
            { type: 'text', text: 'what is this' },
            { type: 'image', data: IMAGE_BASE64, mimeType: 'image/png' },
          ],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('gateway method prompt.submit failed: session is already running'),
      })

      // Without the detach the gateway drains this image into whatever the
      // user prompts next (server.py `_run_prompt_submit`).
      expect(fixture.gateway.recordedCalls().map((call) => call.method)).toEqual([
        'imageAttachBytes',
        'promptSubmit',
        'imageDetach',
      ])
      expect(fixture.server.session(STORED_SESSION_ID)?.activeTurn).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('stages a pdf resource as a workspace file, not as rasterized pages', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('fileAttach', FILE_ATTACH_RESULT)

      await runPrompt(fixture, [
        { type: 'text', text: 'summarize' },
        { type: 'resource', resource: { uri: 'file:///tmp/spec.pdf', mimeType: 'application/pdf', blob: PDF_BASE64 } },
      ])

      // Handed the file, Hermes' read tool extracts the PDF's text itself and
      // warns the agent to OCR whatever it could not cover — no 25-page cap and
      // no poppler dependency, which the rasterizing path would have imposed.
      expect(fixture.gateway.recordedCalls()).toEqual([
        {
          method: 'fileAttach',
          args: [
            {
              session_id: SESSION_ID,
              data_url: `data:application/pdf;base64,${PDF_BASE64}`,
              name: 'spec.pdf',
            },
          ],
        },
        { method: 'promptSubmit', args: [{ session_id: SESSION_ID, text: `summarize\n${FILE_REF_TEXT}` }] },
      ])
    } finally {
      fixture.close()
    }
  })

  it('submits a pdf-only prompt as its file reference, with no marker fallback', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('fileAttach', FILE_ATTACH_RESULT)

      await runPrompt(fixture, [
        { type: 'resource', resource: { uri: 'file:///tmp/spec.pdf', mimeType: 'application/pdf', blob: PDF_BASE64 } },
      ])

      // Unlike an image, a file attachment contributes text of its own, so the
      // empty-prompt marker fallback never comes into play here.
      expect(submittedText(fixture)).toBe(FILE_REF_TEXT)
    } finally {
      fixture.close()
    }
  })

  it('stages a text resource as a workspace file and splices its ref in place', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('fileAttach', FILE_ATTACH_RESULT)

      await runPrompt(fixture, [
        { type: 'text', text: 'before' },
        { type: 'resource', resource: { uri: 'file:///tmp/notes.txt', mimeType: 'text/plain', text: RESOURCE_TEXT } },
        { type: 'text', text: 'after' },
      ])

      expect(fixture.gateway.recordedCalls()[0]).toEqual({
        method: 'fileAttach',
        args: [
          {
            session_id: SESSION_ID,
            data_url: `data:text/plain;base64,${RESOURCE_TEXT_BASE64}`,
            name: 'notes.txt',
          },
        ],
      })
      // file.attach stages nothing for the turn: the ref is the only way the
      // file reaches the model, and it has to sit where the block sat.
      expect(submittedText(fixture)).toBe(`before\n${FILE_REF_TEXT}\nafter`)
    } finally {
      fixture.close()
    }
  })

  it('uploads a blob resource of an unhandled mime type as a workspace file', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('fileAttach', FILE_ATTACH_RESULT)

      await runPrompt(fixture, [
        { type: 'resource', resource: { uri: 'file:///tmp/archive.bin', blob: BINARY_BASE64 } },
      ])

      expect(fixture.gateway.recordedCalls()[0]).toEqual({
        method: 'fileAttach',
        args: [
          {
            session_id: SESSION_ID,
            data_url: `data:application/octet-stream;base64,${BINARY_BASE64}`,
            name: 'archive.bin',
          },
        ],
      })
      expect(submittedText(fixture)).toBe(FILE_REF_TEXT)
    } finally {
      fixture.close()
    }
  })

  it('stages an image resource through the image path, not the file path', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('imageAttachBytes', IMAGE_ATTACH_RESULT)

      await runPrompt(fixture, [
        { type: 'text', text: 'describe' },
        { type: 'resource', resource: { uri: 'file:///tmp/shot.png', mimeType: 'image/png', blob: IMAGE_BASE64 } },
      ])

      expect(fixture.gateway.recordedCalls()[0]).toEqual({
        method: 'imageAttachBytes',
        args: [{ session_id: SESSION_ID, content_base64: IMAGE_BASE64, filename: 'shot.png' }],
      })
    } finally {
      fixture.close()
    }
  })

  it('renders a resource link into the prompt without calling the gateway', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await runPrompt(fixture, [
        { type: 'text', text: 'check' },
        { type: 'resource_link', name: 'report.txt', uri: 'file:///tmp/report.txt' },
      ])

      // The link's path is the client's, not the gateway host's; rendering it
      // is the ACP baseline behavior codex-acp settled on.
      expect(fixture.gateway.recordedCalls().map((call) => call.method)).toEqual(['promptSubmit'])
      expect(submittedText(fixture)).toBe('check\n[@report.txt](file:///tmp/report.txt)')
    } finally {
      fixture.close()
    }
  })

  it('falls back to the file basename when a resource link carries an empty name', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await runPrompt(fixture, [{ type: 'resource_link', name: '', uri: 'file:///tmp/deep/report.txt' }])

      expect(submittedText(fixture)).toBe('[@report.txt](file:///tmp/deep/report.txt)')
    } finally {
      fixture.close()
    }
  })

  it('renders a non-file resource link as its bare uri', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await runPrompt(fixture, [{ type: 'resource_link', name: '', uri: 'https://example.com/spec' }])

      expect(submittedText(fixture)).toBe('https://example.com/spec')
    } finally {
      fixture.close()
    }
  })

  it('rejects an audio block without staging the attachments beside it', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      fixture.gateway.setResult('imageAttachBytes', IMAGE_ATTACH_RESULT)

      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [
            { type: 'image', data: IMAGE_BASE64, mimeType: 'image/png' },
            { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
          ],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('content block type "audio" is not supported'),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('rejects a prompt that carries neither text nor an attachment', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)

      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [{ type: 'text', text: '' }],
        }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('prompt carries no text'),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('aborts on a cancel arriving while staging: no submit, staged images detached', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      let releaseAttach!: () => void
      fixture.gateway.setResult(
        'imageAttachBytes',
        new Promise((resolve) => {
          releaseAttach = () => {
            resolve(IMAGE_ATTACH_RESULT)
          }
        }),
      )
      fixture.gateway.setResult('imageDetach', { detached: true, count: 0 })
      fixture.gateway.setResult('sessionInterrupt', { status: 'interrupted' })

      const response = fixture.client.request(acp.methods.agent.session.prompt, {
        sessionId: STORED_SESSION_ID,
        prompt: [{ type: 'image', data: IMAGE_BASE64, mimeType: 'image/png' }],
      })
      await waitForGatewayCall(fixture.gateway, 'imageAttachBytes')
      await fixture.client.notify(acp.methods.agent.session.cancel, { sessionId: STORED_SESSION_ID })
      // The cancel races the staging release below; the session.interrupt call
      // is its observable effect, so wait for it rather than a wall-clock delay.
      await waitForGatewayCall(fixture.gateway, 'sessionInterrupt')
      releaseAttach()

      await expect(response).resolves.toEqual({ stopReason: 'cancelled' })
      const methods = fixture.gateway.recordedCalls().map((call) => call.method)
      expect(methods).not.toContain('promptSubmit')
      expect(methods).toContain('imageDetach')
    } finally {
      fixture.close()
    }
  })

  it('rejects a second prompt that arrives while the first is still staging', async () => {
    const fixture = createAcpTestFixture()
    try {
      await openSession(fixture)
      let releaseAttach!: () => void
      fixture.gateway.setResult(
        'imageAttachBytes',
        new Promise((resolve) => {
          releaseAttach = () => {
            resolve(IMAGE_ATTACH_RESULT)
          }
        }),
      )
      fixture.gateway.setResult('promptSubmit', { status: 'streaming' })

      const first = fixture.client.request(acp.methods.agent.session.prompt, {
        sessionId: STORED_SESSION_ID,
        prompt: [{ type: 'image', data: IMAGE_BASE64, mimeType: 'image/png' }],
      })
      await waitForGatewayCall(fixture.gateway, 'imageAttachBytes')

      // The slot is reserved before staging, so the race where both prompts
      // stage onto the session and one submit drains both cannot happen.
      await expect(
        fixture.client.request(acp.methods.agent.session.prompt, {
          sessionId: STORED_SESSION_ID,
          prompt: [{ type: 'text', text: 'second' }],
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('already has a turn in flight'),
      })

      releaseAttach()
      await waitForGatewayCall(fixture.gateway, 'promptSubmit')
      fixture.gateway.emit({ type: 'message.complete', session_id: SESSION_ID, payload: { status: 'complete' } })
      await expect(first).resolves.toEqual({ stopReason: 'end_turn' })
      expect(fixture.gateway.recordedCalls().filter((call) => call.method === 'imageAttachBytes')).toHaveLength(1)
    } finally {
      fixture.close()
    }
  })
})
