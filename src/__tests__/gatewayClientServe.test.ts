import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ENV_SESSION_TOKEN } from '../constants.js'
import { createHarness, startServe, waitFor } from './gatewayTestDoubles.js'

describe('GatewayClient managed serve mode', () => {
  it('spawns hermes serve isolated on an ephemeral loopback port and connects to /api/ws with session token', async () => {
    const harness = createHarness({ mode: 'serve', gatewayUrl: undefined })
    const socket = await startServe(harness)

    const spawn = harness.spawns[0]!
    expect(spawn.command).toBe('hermes')
    expect(spawn.args).toEqual(['serve', '--host', '127.0.0.1', '--port', '0', '--isolated'])
    expect(spawn.options.env?.['HERMES_PARENT_PID']).toBe(String(process.pid))
    const token = spawn.options.env?.['HERMES_DASHBOARD_SESSION_TOKEN']
    expect(token).toBeDefined()
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(socket.url).toBe(`ws://127.0.0.1:45678/api/ws?token=${token}`)

    // Non-sentinel stdout is diagnostics, not protocol.
    spawn.spawnedProcess.stdoutLine('  Hermes backend listening on 127.0.0.1:45678')
    await waitFor(() => {
      if (!harness.logs.join('\n').includes('Hermes backend listening')) {
        throw new Error('stdout line not forwarded yet')
      }
    })
  })

  it('uses configured session token in serve mode', async () => {
    const harness = createHarness({
      mode: 'serve',
      gatewayUrl: undefined,
      sessionToken: 'custom-secret-token',
    })
    const socket = await startServe(harness)
    expect(harness.spawns[0]!.options.env?.['HERMES_DASHBOARD_SESSION_TOKEN']).toBe('custom-secret-token')
    expect(socket.url).toBe('ws://127.0.0.1:45678/api/ws?token=custom-secret-token')
  })

  it('mints a fresh token when the token env var is whitespace-only', async () => {
    // Discriminates || from ??: with ??, ''.trim() would shadow the
    // randomBytes fallback and hand the gateway process an empty token (guaranteed 4401).
    const harness = createHarness({
      mode: 'serve',
      gatewayUrl: undefined,
      env: { [ENV_SESSION_TOKEN]: '   ' },
    })
    await startServe(harness)
    expect(harness.spawns[0]!.options.env?.['HERMES_DASHBOARD_SESSION_TOKEN']).toMatch(/^[a-f0-9]{64}$/)
  })

  it('expands a tilde in the configured hermes binary path', async () => {
    const harness = createHarness({ mode: 'serve', gatewayUrl: undefined, hermesBin: '~/bin/hermes' })
    await startServe(harness)
    expect(harness.spawns[0]!.command).toBe(resolve(homedir(), 'bin/hermes'))
  })

  it('forwards gateway stderr to the diagnostics sink and stays functional', async () => {
    const harness = createHarness({ mode: 'serve', gatewayUrl: undefined })
    const socket = await startServe(harness)

    harness.spawns[0]!.spawnedProcess.stderrLine('WARNING: uvicorn reload disabled')
    await waitFor(() => {
      if (!harness.logs.join('\n').includes('WARNING: uvicorn reload disabled')) {
        throw new Error('stderr line not forwarded yet')
      }
    })

    const response = harness.client.request('session.list', {})
    const sent = JSON.parse(socket.sent[0]!) as { id: number }
    socket.serverSend({ jsonrpc: '2.0', id: sent.id, result: { sessions: [] } })
    await expect(response).resolves.toEqual({ sessions: [] })
  })

  it('redacts the minted serve token from connect-failure errors and logs', async () => {
    const harness = createHarness({ mode: 'serve', gatewayUrl: undefined })
    const started = harness.client.start()
    harness.spawns[0]!.spawnedProcess.stdoutLine('HERMES_BACKEND_READY port=45678')
    await waitFor(() => {
      if (harness.sockets.length === 0) {
        throw new Error('gateway websocket not created yet')
      }
    })
    harness.sockets[0]!.serverError()

    const error = await started.then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    const token = harness.spawns[0]!.options.env?.['HERMES_DASHBOARD_SESSION_TOKEN'] as string
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(error?.message).toContain('token=<redacted>')
    expect(error?.message).not.toContain(token)
    expect(harness.logs.join('\n')).not.toContain(token)
  })

  it('rejects start when the process exits before announcing a port, with the stderr tail', async () => {
    const harness = createHarness({ mode: 'serve', gatewayUrl: undefined })
    const started = harness.client.start()
    harness.spawns[0]!.spawnedProcess.stderrLine('ImportError: no module named hermes')
    await waitFor(() => {
      if (harness.logs.length === 0) {
        throw new Error('stderr not drained yet')
      }
    })
    harness.spawns[0]!.spawnedProcess.die(1)
    await expect(started).rejects.toThrow(
      /hermes serve exited before announcing its port \(code 1\)[\s\S]*ImportError: no module named hermes/,
    )
  })

  it('rejects start and kills the process when port discovery hangs (sentinel never printed)', async () => {
    const harness = createHarness({ mode: 'serve', gatewayUrl: undefined, startupTimeoutMs: 20 })
    const started = harness.client.start()
    harness.spawns[0]!.spawnedProcess.stdoutLine('Loading Hermes components...')
    await expect(started).rejects.toThrow(
      'timed out after 20ms starting Hermes gateway (serve mode)',
    )
    expect(harness.spawns[0]!.spawnedProcess.killed).toBe(true)
  })

  it('rejects start when the process fails to spawn (error without exit)', async () => {
    const harness = createHarness({ mode: 'serve', gatewayUrl: undefined })
    const started = harness.client.start()
    harness.spawns[0]!.spawnedProcess.fail(new Error('spawn /nonexistent-hermes ENOENT'))
    await expect(started).rejects.toThrow(
      /hermes serve failed to start: spawn \/nonexistent-hermes ENOENT/,
    )
  })

  it('rejects in-flight requests with the stderr tail when the serve process dies post-ready', async () => {
    const harness = createHarness({ mode: 'serve', gatewayUrl: undefined })
    await startServe(harness)

    const exits: (number | null)[] = []
    harness.client.onExit((code) => exits.push(code))

    const pending = harness.client.request('session.list', {})
    harness.spawns[0]!.spawnedProcess.stderrLine('RuntimeError: gateway crashed mid-turn')
    await waitFor(() => {
      if (!harness.logs.some((line) => line.includes('RuntimeError: gateway crashed mid-turn'))) {
        throw new Error('stderr not drained yet')
      }
    })
    harness.spawns[0]!.spawnedProcess.die(1)

    await expect(pending).rejects.toThrow(
      /gateway process exited \(code 1\)[\s\S]*RuntimeError: gateway crashed mid-turn/,
    )
    expect(exits).toEqual([1])
  })

  it('SIGTERMs a live process on kill and skips signaling an already-exited one', async () => {
    const harness = createHarness({ mode: 'serve', gatewayUrl: undefined })
    await startServe(harness)

    await harness.client.kill('done')
    expect(harness.spawns[0]!.spawnedProcess.signals).toEqual(['SIGTERM'])
  })

  it('escalates to SIGKILL if the process ignores SIGTERM', async () => {
    const harness = createHarness({ mode: 'serve', gatewayUrl: undefined, killGraceMs: 20 })
    await startServe(harness)

    const spawnedProcess = harness.spawns[0]!.spawnedProcess
    spawnedProcess.ignoreSigterm = true

    const killPromise = harness.client.kill('escalation test')
    expect(spawnedProcess.signals).toEqual(['SIGTERM'])

    await killPromise
    expect(spawnedProcess.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })
})
