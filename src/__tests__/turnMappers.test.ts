/** Unit tests for the pure gateway-event → ACP-update mappers. */

import { describe, expect, it } from 'vitest'

import type { ToolCompleteEvent, Usage } from '../gateway/types.js'
import { SESSION_TITLE_MAX_CHARS } from '../constants.js'
import {
  DEFAULT_TOOL_KIND,
  TOOL_KIND_BY_NAME,
  planFromTodos,
  sanitizeSessionTitle,
  toolCallComplete,
  toolCallFromComplete,
  toolCallLocations,
  toolCallStart,
  toolCallTitle,
  toolKindForName,
  toolResultFailed,
  usageGauge,
} from '../turn/mappers.js'

const TOOL_ID = 'call-1'
const SESSION_CWD = '/repo'

// `patch` rather than `terminal`: a terminal call maps through the terminal-entry
// path, which is exercised by its own cases below.
function completePayload(overrides: Partial<ToolCompleteEvent['payload']> = {}): ToolCompleteEvent['payload'] {
  return { tool_id: TOOL_ID, name: 'patch', ...overrides }
}

function usage(overrides: Partial<Usage> = {}): Usage {
  return { model: 'hermes', input: 1, output: 1, reasoning: 0, prompt: 1, completion: 1, total: 2, calls: 1, ...overrides }
}

describe('toolKindForName', () => {
  it('maps the ported Hermes tool table', () => {
    expect(toolKindForName('read_file')).toBe('read')
    expect(toolKindForName('write_file')).toBe('edit')
    expect(toolKindForName('patch')).toBe('edit')
    expect(toolKindForName('search_files')).toBe('search')
    expect(toolKindForName('terminal')).toBe('execute')
    expect(toolKindForName('web_search')).toBe('fetch')
    expect(toolKindForName('browser_navigate')).toBe('fetch')
    expect(toolKindForName('browser_click')).toBe('execute')
    expect(toolKindForName('_thinking')).toBe('think')
    expect(toolKindForName('todo')).toBe('other')
  })

  it('falls back to the default kind for unknown and inherited names', () => {
    expect(toolKindForName('some_mcp_tool')).toBe(DEFAULT_TOOL_KIND)
    // Not an own property of the table, so it must not leak Object.prototype.
    expect(toolKindForName('constructor')).toBe(DEFAULT_TOOL_KIND)
  })

  it('only advertises kinds ACP defines', () => {
    const validKinds = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])
    for (const kind of Object.values(TOOL_KIND_BY_NAME)) {
      expect(validKinds).toContain(kind)
    }
  })
})

describe('toolCallStart', () => {
  it('titles the call with the gateway display preview when there is one', () => {
    expect(toolCallTitle({ tool_id: TOOL_ID, name: 'terminal', context: '$ ls -la' })).toBe('$ ls -la')
    expect(toolCallTitle({ tool_id: TOOL_ID, name: 'terminal' })).toBe('terminal')
  })

  it('opens the call as in_progress', () => {
    expect(toolCallStart({ tool_id: TOOL_ID, name: 'patch', context: 'patch src/a.ts' }, SESSION_CWD)).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: TOOL_ID,
      title: 'patch src/a.ts',
      name: 'patch',
      kind: 'edit',
      status: 'in_progress',
    })
  })

  it('carries the call arguments as rawInput and the file they name as a location', () => {
    const args = { path: '/repo/src/a.ts', offset: 12, limit: 40 }
    expect(toolCallStart({ tool_id: TOOL_ID, name: 'read_file', args }, SESSION_CWD)).toMatchObject({
      rawInput: args,
      locations: [{ path: '/repo/src/a.ts', line: 12 }],
    })
  })

  it('opens a terminal call as a terminal entry rooted at its workdir, else the session cwd', () => {
    expect(toolCallStart({ tool_id: TOOL_ID, name: 'terminal', context: '$ ls', args: { command: 'ls' } }, SESSION_CWD)).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: TOOL_ID,
      title: '$ ls',
      name: 'terminal',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'ls' },
      content: [{ type: 'terminal', terminalId: TOOL_ID }],
      _meta: { terminal_info: { terminal_id: TOOL_ID, cwd: SESSION_CWD } },
    })
    expect(
      toolCallStart({ tool_id: TOOL_ID, name: 'terminal', args: { command: 'ls', workdir: '/repo/src' } }, SESSION_CWD),
    ).toMatchObject({
      _meta: { terminal_info: { terminal_id: TOOL_ID, cwd: '/repo/src' } },
    })
  })
})

describe('toolCallLocations', () => {
  it('reads path plus offset or line, trusting nothing about the untyped arguments', () => {
    expect(toolCallLocations({ path: '/a.ts' })).toEqual([{ path: '/a.ts' }])
    expect(toolCallLocations({ path: '/a.ts', offset: 3, line: 7 })).toEqual([{ path: '/a.ts', line: 3 }])
    expect(toolCallLocations({ path: '/a.ts', line: '7' })).toEqual([{ path: '/a.ts' }])
    expect(toolCallLocations({ path: 42 })).toEqual([])
    expect(toolCallLocations(undefined)).toEqual([])
  })
})

describe('sanitizeSessionTitle', () => {
  it('flattens whitespace to one line and caps the length', () => {
    expect(sanitizeSessionTitle('  Fix the\n\n  build\tscript ')).toBe('Fix the build script')
    expect(sanitizeSessionTitle('x'.repeat(SESSION_TITLE_MAX_CHARS + 50))).toHaveLength(SESSION_TITLE_MAX_CHARS)
  })
})

describe('toolResultFailed', () => {
  it('treats the tool executor exception wrapper as a failure', () => {
    expect(toolResultFailed(completePayload({ result: "Error executing tool 'terminal': boom" }))).toBe(true)
    expect(toolResultFailed(completePayload({ result_text: "Error executing tool 'terminal': boom" }))).toBe(true)
  })

  it('treats structured failure flags as failures', () => {
    expect(toolResultFailed(completePayload({ result: { success: false } }))).toBe(true)
    expect(toolResultFailed(completePayload({ result: { ok: false } }))).toBe(true)
    expect(toolResultFailed(completePayload({ result: { exit_code: 1 } }))).toBe(true)
    expect(toolResultFailed(completePayload({ result: { returncode: 2 } }))).toBe(true)
  })

  it('keys a bare error payload off the polished-tool list only', () => {
    expect(toolResultFailed(completePayload({ name: 'terminal', result: { error: 'nope' } }))).toBe(true)
    expect(toolResultFailed(completePayload({ name: 'some_mcp_tool', result: { error: 'nope' } }))).toBe(false)
    // A polished tool that still returned content is reporting a warning.
    expect(toolResultFailed(completePayload({ name: 'terminal', result: { error: 'nope', content: 'output' } }))).toBe(false)
  })

  it('stays conservative about plain text and successful results', () => {
    expect(toolResultFailed(completePayload({ result: 'error: 3 tests failed' }))).toBe(false)
    expect(toolResultFailed(completePayload({ result: { exit_code: 0 } }))).toBe(false)
    expect(toolResultFailed(completePayload({ result: ['error'] }))).toBe(false)
    expect(toolResultFailed(completePayload())).toBe(false)
  })
})

describe('toolCallComplete', () => {
  it('prefers result_text over summary and appends the rendered diff', () => {
    expect(
      toolCallComplete(completePayload({ name: 'patch', result_text: 'patched', summary: 'ignored', inline_diff: '- a\n+ b' })),
    ).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: TOOL_ID,
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'patched' } },
        { type: 'content', content: { type: 'text', text: '- a\n+ b' } },
      ],
      rawOutput: 'patched',
    })
  })

  it('falls back to the summary and omits content entirely when there is none', () => {
    expect(toolCallComplete(completePayload({ summary: '3 files' }))).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: TOOL_ID,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '3 files' } }],
    })
    expect(toolCallComplete(completePayload())).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: TOOL_ID,
      status: 'completed',
    })
  })

  it('builds a whole tool_call from a completion with no start', () => {
    expect(
      toolCallFromComplete(
        completePayload({ name: 'patch', args: { path: '/a.ts' }, summary: 'patched', result: { exit_code: 1 } }),
        SESSION_CWD,
      ),
    ).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: TOOL_ID,
      title: 'patch',
      name: 'patch',
      kind: 'edit',
      rawInput: { path: '/a.ts' },
      locations: [{ path: '/a.ts' }],
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'patched' } }],
      rawOutput: { exit_code: 1 },
    })
  })

  it('reports a failed status for a failed result', () => {
    expect(toolCallComplete(completePayload({ result: { exit_code: 127 }, summary: 'command not found' }))).toMatchObject({
      status: 'failed',
    })
  })

  it('maps a terminal completion onto the terminal _meta keys with no text content', () => {
    expect(
      toolCallComplete(
        completePayload({ name: 'terminal', summary: 'ok', result: { output: 'a.ts\nb.ts\n', exit_code: 0 } }),
      ),
    ).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: TOOL_ID,
      status: 'completed',
      rawOutput: { output: 'a.ts\nb.ts\n', exit_code: 0 },
      _meta: {
        terminal_output: { terminal_id: TOOL_ID, data: 'a.ts\nb.ts\n' },
        terminal_exit: { terminal_id: TOOL_ID, exit_code: 0, signal: null },
      },
    })
    // The failure envelope: empty output, the explanation in `error`.
    expect(
      toolCallComplete(
        completePayload({ name: 'terminal', result: { output: '', exit_code: 124, error: 'Command timed out after 30 seconds' } }),
      ),
    ).toMatchObject({
      status: 'failed',
      _meta: {
        terminal_output: { terminal_id: TOOL_ID, data: 'Command timed out after 30 seconds' },
        terminal_exit: { terminal_id: TOOL_ID, exit_code: 124, signal: null },
      },
    })
  })

  it('omits the exit when Hermes reported none', () => {
    // Yielded to background: the command is still running, so there is no code
    // and the notice saying so follows the output so far.
    const yielded = { output: 'starting', exit_code: null, error: null, status: 'yielded_to_background', note: 'Still running.' }
    expect(toolCallComplete(completePayload({ name: 'terminal', result: yielded }))).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: TOOL_ID,
      status: 'completed',
      rawOutput: yielded,
      _meta: { terminal_output: { terminal_id: TOOL_ID, data: 'starting\nStill running.' } },
    })
    // A result the gateway could not decode (the executor's exception wrapper):
    // its text is the terminal's data, since the row carries no text content.
    expect(
      toolCallComplete(completePayload({ name: 'terminal', result: "Error executing tool 'terminal': boom" })),
    ).toMatchObject({
      status: 'failed',
      _meta: { terminal_output: { terminal_id: TOOL_ID, data: "Error executing tool 'terminal': boom" } },
    })
  })

  it('announces a terminal call and its outcome together when there was no start', () => {
    expect(
      toolCallFromComplete(
        completePayload({ name: 'terminal', args: { command: 'ls', workdir: '/repo/src' }, result: { output: 'a.ts\n', exit_code: 0 } }),
        SESSION_CWD,
      ),
    ).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: TOOL_ID,
      title: 'terminal',
      name: 'terminal',
      kind: 'execute',
      rawInput: { command: 'ls', workdir: '/repo/src' },
      status: 'completed',
      rawOutput: { output: 'a.ts\n', exit_code: 0 },
      content: [{ type: 'terminal', terminalId: TOOL_ID }],
      _meta: {
        terminal_info: { terminal_id: TOOL_ID, cwd: '/repo/src' },
        terminal_output: { terminal_id: TOOL_ID, data: 'a.ts\n' },
        terminal_exit: { terminal_id: TOOL_ID, exit_code: 0, signal: null },
      },
    })
  })
})

describe('planFromTodos', () => {
  it('maps the three statuses ACP defines and sets a uniform priority', () => {
    expect(
      planFromTodos([
        { id: '1', content: 'a', status: 'pending' },
        { id: '2', content: 'b', status: 'in_progress' },
        { id: '3', content: 'c', status: 'completed' },
      ]),
    ).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'a', priority: 'medium', status: 'pending' },
        { content: 'b', priority: 'medium', status: 'in_progress' },
        { content: 'c', priority: 'medium', status: 'completed' },
      ],
    })
  })

  it('keeps cancelled todos out of the entries', () => {
    const cancelled = { id: '2', content: 'b', status: 'cancelled' as const }
    expect(planFromTodos([{ id: '1', content: 'a', status: 'pending' }, cancelled])).toEqual({
      sessionUpdate: 'plan',
      entries: [{ content: 'a', priority: 'medium', status: 'pending' }],
    })
  })
})

describe('usageGauge', () => {
  it('maps the context gauge when the gateway reports one', () => {
    expect(usageGauge(usage({ context_used: 900, context_max: 64000 }))).toEqual({
      sessionUpdate: 'usage_update',
      used: 900,
      size: 64000,
    })
  })

  it('maps to nothing rather than a zeroed gauge when the context fields are absent', () => {
    expect(usageGauge(usage())).toBeNull()
    expect(usageGauge(usage({ context_used: 900 }))).toBeNull()
    expect(usageGauge(undefined)).toBeNull()
  })
})
