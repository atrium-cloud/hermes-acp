import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CLIENT_PATHS,
  diffSurfaces,
  extractOurEventTypes,
  extractOurMethods,
  extractOurServerRequestMethods,
  extractUpstreamSurface,
} from '../../scripts/check-hermes-drift.js'

const FAKE_SERVER_PY = `
@method("session.create")
async def _session_create(params):
    pass

@method("prompt.submit")
async def _prompt_submit(params):
    pass

@_session_method("session.branch", live=True)
async def _session_branch(rid, params, session):
    pass

@_rpc("commands.catalog", 5020)
async def _commands_catalog(rid, params):
    pass

_correction_method("session.steer", "steer", "queued", lambda agent: hasattr(agent, "steer"), "unsupported")

@_pet_method("pet.hatch")
async def _pet_hatch(rid, params):
    pass

def _push(sid):
    _emit("message.delta", sid, {"text": "hi"})
    _emit(
        "tool.start", sid, {"tool_id": "t1"})

def _clarify_block(sid, q):
    result = server_requests.send("clarify", sid, {"question": q}, timeout=300)

def _emit_approval_request(sid, data):
    settle = server_requests.send_async("approval", sid, data, on_result)
`

const FAKE_WS_PY = `
async def accept(ws):
    await ws.send_json({
        "jsonrpc": "2.0",
        "method": "event",
        "params": {
            "type": "gateway.ready",
        },
    })
    await ws.send_json({"type": "hb"})
`

const upstream = () =>
  extractUpstreamSurface(
    new Map([
      ['tui_gateway/server.py', FAKE_SERVER_PY],
      ['tui_gateway/ws.py', FAKE_WS_PY],
    ]),
  )

describe('extractUpstreamSurface', () => {
  it('collects the base decorator and the helper registrars, first arg only', () => {
    const surface = upstream()
    // session.steer comes from a bare `_correction_method(...)` call whose 2nd
    // and 3rd string args ("steer", "queued") must not leak in as methods;
    // pet.hatch uses an omitted registrar and must stay out.
    expect([...surface.methods.keys()].sort()).toEqual([
      'commands.catalog',
      'prompt.submit',
      'session.branch',
      'session.create',
      'session.steer',
    ])
    // Single site at its own line — the decorator registers once, so the
    // registrar must not double-count. (The `\b` guard itself is what the
    // pet.hatch exclusion above exercises: `_pet_method` must not match via
    // its inner `method(` substring.)
    expect(surface.methods.get('session.branch')).toEqual([{ file: 'tui_gateway/server.py', line: 10 }])
  })

  it('collects _emit event names including multi-line calls, but not ws control frames', () => {
    const surface = upstream()
    expect([...surface.emittedEvents.keys()].sort()).toEqual(['message.delta', 'tool.start'])
  })

  it('collects server request methods from both send forms', () => {
    const surface = upstream()
    expect([...surface.serverRequests.keys()].sort()).toEqual(['approval', 'clarify'])
  })

  it('records gateway.ready in the literal existence oracle', () => {
    const surface = upstream()
    expect(surface.literals.has('gateway.ready')).toBe(true)
  })
})

describe('extractOurEventTypes / extractOurMethods', () => {
  it('parses quoted and bare keys from a KNOWN_EVENT_TYPES block', () => {
    const source = `
const KNOWN_EVENT_TYPES: Record<GatewayEvent['type'], true> = {
  'gateway.ready': true,
  'message.delta': true,
  error: true,
}
`
    expect(extractOurEventTypes(source)).toEqual(['gateway.ready', 'message.delta', 'error'])
  })

  it('fails fast when the registry block is missing or empty', () => {
    expect(() => extractOurEventTypes('const other = {}')).toThrow(/KNOWN_EVENT_TYPES/)
    expect(() => extractOurServerRequestMethods('const other = {}')).toThrow(/KNOWN_SERVER_REQUEST_METHODS/)
  })

  it('parses the KNOWN_SERVER_REQUEST_METHODS block', () => {
    const source = `
const KNOWN_SERVER_REQUEST_METHODS: Record<GatewayServerRequest['method'], true> = {
  approval: true,
  clarify: true,
}
`
    expect(extractOurServerRequestMethods(source)).toEqual(['approval', 'clarify'])
  })

  it('dedupes gateway.request method names', () => {
    const source = `
    a() { return this.gateway.request('session.create', params) }
    b() { return this.gateway.request('session.create', other) }
    c() { return this.gateway.request('prompt.submit', params) }
`
    expect(extractOurMethods(source)).toEqual(['session.create', 'prompt.submit'])
  })

  it('fails fast when no request calls parse', () => {
    expect(() => extractOurMethods('nothing here')).toThrow(/request/)
  })
})

describe('diffSurfaces', () => {
  it('flags removed methods, events, and server requests as breaking', () => {
    const report = diffSurfaces(
      upstream(),
      ['session.create', 'session.vanished'],
      ['message.delta', 'gone.event'],
      ['approval', 'clarify.request'],
    )
    expect(report.missingMethods).toEqual(['session.vanished'])
    expect(report.missingEvents).toEqual(['gone.event'])
    expect(report.missingServerRequests).toEqual(['clarify.request'])
    expect(report.breaking).toBe(true)
  })

  it('passes gateway.ready through the literal oracle and reports new upstream events and requests as info only', () => {
    const report = diffSurfaces(upstream(), ['prompt.submit'], ['gateway.ready', 'message.delta'], ['clarify'])
    expect(report.missingEvents).toEqual([])
    expect(report.newUpstreamEvents).toEqual(['tool.start'])
    expect(report.newUpstreamServerRequests).toEqual(['approval'])
    expect(report.breaking).toBe(false)
  })

  it('does not let generic names survive on dict-key literals alone', () => {
    // "text" appears as a payload dict key in the fixture but is never
    // emitted as an event; only oracle-listed names may use the literal
    // fallback, so this must count as missing.
    const report = diffSurfaces(upstream(), [], ['text'], [])
    expect(report.missingEvents).toEqual(['text'])
    expect(report.breaking).toBe(true)
  })
})

describe('against the real adapter sources', () => {
  const repoRoot = resolve(__dirname, '../..')

  it('parses the actual KNOWN_EVENT_TYPES and KNOWN_SERVER_REQUEST_METHODS registries', () => {
    const typesSource = readFileSync(resolve(repoRoot, 'src/gateway/types.ts'), 'utf8')
    const events = extractOurEventTypes(typesSource)
    expect(events).toContain('gateway.ready')
    expect(events).toContain('error')
    expect(events.length).toBeGreaterThanOrEqual(13)
    expect(extractOurServerRequestMethods(typesSource)).toEqual(['approval', 'clarify'])
  })

  it('parses the actual gateway client method usage, including the startup handshake', () => {
    const methods = extractOurMethods(CLIENT_PATHS.map((path) => readFileSync(resolve(repoRoot, path), 'utf8')).join('\n'))
    expect(methods).toContain('session.create')
    expect(methods).toContain('prompt.submit')
    expect(methods).toContain('client.capabilities')
    expect(methods.length).toBeGreaterThanOrEqual(15)
  })
})
