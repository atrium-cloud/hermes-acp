import { describe, expect, it, vi } from 'vitest'

import { GatewayClient } from '../gateway/GatewayClient.js'
import { HermesGatewayClient } from '../gateway/HermesGatewayClient.js'

describe('HermesGatewayClient typed wrappers', () => {
  it('issues each method with pinned names and params', async () => {
    const gateway = new GatewayClient()
    const request = vi.spyOn(gateway, 'request')
    const hermes = new HermesGatewayClient(gateway)

    request.mockResolvedValue({ session_id: 's1' })
    await expect(hermes.sessionCreate({ cwd: '/tmp', cols: 120 })).resolves.toEqual({ session_id: 's1' })
    expect(request).toHaveBeenLastCalledWith('session.create', { cwd: '/tmp', cols: 120 })

    request.mockResolvedValue({ status: 'streaming' })
    await expect(hermes.promptSubmit({ session_id: 's1', text: 'hi' })).resolves.toEqual({ status: 'streaming' })
    expect(request).toHaveBeenLastCalledWith('prompt.submit', { session_id: 's1', text: 'hi' })

    const attachedImage = {
      name: 'shot.png',
      attached: true,
      path: '/w/shot.png',
      count: 1,
      remainder: '',
      text: '[User attached image: shot.png]',
      bytes: 3,
    }
    request.mockResolvedValue(attachedImage)
    await expect(
      hermes.imageAttachBytes({ session_id: 's1', content_base64: 'YWJj', ext: '.png' }),
    ).resolves.toEqual(attachedImage)
    expect(request).toHaveBeenLastCalledWith('image.attach_bytes', {
      session_id: 's1',
      content_base64: 'YWJj',
      ext: '.png',
    })

    const attachedFile = {
      attached: true,
      name: 'notes.md',
      path: '/w/notes.md',
      ref_path: 'notes.md',
      ref_text: '@file:notes.md',
      uploaded: true,
    }
    request.mockResolvedValue(attachedFile)
    await expect(
      hermes.fileAttach({ session_id: 's1', data_url: 'data:text/markdown;base64,YWJj', name: 'notes.md' }),
    ).resolves.toEqual(attachedFile)
    expect(request).toHaveBeenLastCalledWith('file.attach', {
      session_id: 's1',
      data_url: 'data:text/markdown;base64,YWJj',
      name: 'notes.md',
    })

    request.mockResolvedValue({ detached: true, count: 0 })
    await expect(hermes.imageDetach({ session_id: 's1', path: '/w/shot.png' })).resolves.toEqual({
      detached: true,
      count: 0,
    })
    expect(request).toHaveBeenLastCalledWith('image.detach', { session_id: 's1', path: '/w/shot.png' })

    request.mockResolvedValue({ status: 'interrupted' })
    await expect(hermes.sessionInterrupt('s1')).resolves.toEqual({ status: 'interrupted' })
    expect(request).toHaveBeenLastCalledWith('session.interrupt', { session_id: 's1' })

    request.mockResolvedValue({ status: 'queued', text: 'wait' })
    await expect(hermes.sessionSteer('s1', 'wait')).resolves.toEqual({ status: 'queued', text: 'wait' })
    expect(request).toHaveBeenLastCalledWith('session.steer', { session_id: 's1', text: 'wait' })

    request.mockResolvedValue({ session_id: 'b1' })
    await expect(hermes.sessionBranch({ session_id: 's1', count: 4 })).resolves.toEqual({ session_id: 'b1' })
    expect(request).toHaveBeenLastCalledWith('session.branch', { session_id: 's1', count: 4 })

    request.mockResolvedValue({ sessions: [] })
    await expect(hermes.sessionList({ limit: 10 })).resolves.toEqual({ sessions: [] })
    expect(request).toHaveBeenLastCalledWith('session.list', { limit: 10 })

    request.mockResolvedValue({ messages: [] })
    await expect(hermes.sessionResume({ session_id: 's1' })).resolves.toEqual({ messages: [] })
    expect(request).toHaveBeenLastCalledWith('session.resume', { session_id: 's1' })

    request.mockResolvedValue({ count: 0, messages: [] })
    await expect(hermes.sessionHistory('s1')).resolves.toEqual({ count: 0, messages: [] })
    expect(request).toHaveBeenLastCalledWith('session.history', { session_id: 's1' })

    request.mockResolvedValue({ closed: true })
    await expect(hermes.sessionClose('s1')).resolves.toEqual({ closed: true })
    expect(request).toHaveBeenLastCalledWith('session.close', { session_id: 's1' })

    request.mockResolvedValue({ deleted: 's1' })
    await expect(hermes.sessionDelete('s1')).resolves.toEqual({ deleted: 's1' })
    expect(request).toHaveBeenLastCalledWith('session.delete', { session_id: 's1' })

    request.mockResolvedValue({ status: 'ok', remaining: [] })
    await expect(hermes.clarifyLock({ request_id: 'srq-1', question_id: 'q1', answer: 'yes' })).resolves.toEqual({
      status: 'ok',
      remaining: [],
    })
    expect(request).toHaveBeenLastCalledWith('clarify.lock', { request_id: 'srq-1', question_id: 'q1', answer: 'yes' })

    request.mockResolvedValue({ providers: [] })
    await expect(hermes.modelOptions({ refresh: true })).resolves.toEqual({ providers: [] })
    // No budget passed: the call takes the client-wide default.
    expect(request).toHaveBeenLastCalledWith('model.options', { refresh: true }, undefined)

    await expect(hermes.modelOptions({}, 10_000)).resolves.toEqual({ providers: [] })
    expect(request).toHaveBeenLastCalledWith('model.options', {}, 10_000)

    request.mockResolvedValue({ value: 'manual', display: 'Manual' })
    await expect(hermes.configGet({ key: 'approval_mode', session_id: 's1' })).resolves.toEqual({
      value: 'manual',
      display: 'Manual',
    })
    expect(request).toHaveBeenLastCalledWith('config.get', { key: 'approval_mode', session_id: 's1' })

    request.mockResolvedValue({ key: 'model', value: 'gpt-x' })
    await expect(hermes.configSet({ key: 'model', value: 'gpt-x', session_id: 's1' })).resolves.toEqual({
      key: 'model',
      value: 'gpt-x',
    })
    expect(request).toHaveBeenLastCalledWith('config.set', { key: 'model', value: 'gpt-x', session_id: 's1' })

    request.mockResolvedValue({ pairs: [] })
    await expect(hermes.commandsCatalog()).resolves.toEqual({ pairs: [] })
    expect(request).toHaveBeenLastCalledWith('commands.catalog', {})

    request.mockResolvedValue({ output: 'ok' })
    await expect(hermes.slashExec({ session_id: 's1', command: '/status' })).resolves.toEqual({ output: 'ok' })
    expect(request).toHaveBeenLastCalledWith('slash.exec', { session_id: 's1', command: '/status' })

    // Names travel WITHOUT their leading slash here, unlike slash.exec's line.
    request.mockResolvedValue({ type: 'exec', output: 'restored' })
    await expect(hermes.commandDispatch({ name: 'snapshot', arg: 'restore', session_id: 's1' })).resolves.toEqual({
      type: 'exec',
      output: 'restored',
    })
    expect(request).toHaveBeenLastCalledWith('command.dispatch', {
      name: 'snapshot',
      arg: 'restore',
      session_id: 's1',
    })
  })

  it('propagates rejections from the underlying transport', async () => {
    const gateway = new GatewayClient()
    const request = vi.spyOn(gateway, 'request')
    const hermes = new HermesGatewayClient(gateway)

    request.mockRejectedValue(new Error('gateway not connected'))
    await expect(hermes.sessionCreate({})).rejects.toThrow('gateway not connected')
  })

  it('forwards event and server request subscriptions to the underlying transport', () => {
    const gateway = new GatewayClient()
    const onEvent = vi.spyOn(gateway, 'onEvent')
    const onServerRequest = vi.spyOn(gateway, 'onServerRequest')
    const hermes = new HermesGatewayClient(gateway)

    const handler = (): void => {}
    hermes.onEvent(handler)
    expect(onEvent).toHaveBeenCalledWith(handler)
    hermes.onServerRequest(handler)
    expect(onServerRequest).toHaveBeenCalledWith(handler)
  })

  it('answers server requests as response frames on the request id', () => {
    const gateway = new GatewayClient()
    const respond = vi.spyOn(gateway, 'respond').mockImplementation(() => undefined)
    const hermes = new HermesGatewayClient(gateway)

    hermes.answerApproval('srq-1', { choice: 'once' })
    expect(respond).toHaveBeenLastCalledWith('srq-1', { choice: 'once' })
    hermes.answerClarify('srq-2', { answer: 'postgres' })
    expect(respond).toHaveBeenLastCalledWith('srq-2', { answer: 'postgres' })
  })
})
