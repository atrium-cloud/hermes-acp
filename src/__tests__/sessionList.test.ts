/**
 * `session/list`: one bounded gateway fetch in, adapter-side source/cwd
 * filtering and offset pagination out. Scripted gateway, no real Hermes.
 */

import * as acp from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { GATEWAY_SESSION_SOURCE, SESSION_LIST_FETCH_CAP, SESSION_LIST_PAGE_SIZE } from '../constants.js'
import type { SessionListItem } from '../gateway/types.js'
import { createAcpTestFixture, scriptSessionSettings } from './acpTestFixture.js'

const TEST_CWD = '/tmp/hermes-acp-session-list'
const GATEWAY_SESSION_ID = 'gw-session-1'
const STORED_SESSION_ID = 'stored-1'

function listItem(id: string, overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id,
    title: `chat ${id}`,
    preview: '',
    started_at: 0,
    message_count: 0,
    source: GATEWAY_SESSION_SOURCE,
    ...overrides,
  }
}

describe('session/list', () => {
  it('returns only adapter-source rows whose cwd is known, as ACP SessionInfo', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.sessionDirectory.remember('stored-a', '/work/a')
      fixture.sessionDirectory.remember('stored-b', '/work/b')
      fixture.gateway.setResult('sessionList', {
        sessions: [
          // Titles are model-generated and relayed verbatim upstream: one line.
          listItem('stored-a', { title: 'chat\n  stored-a' }),
          // Old `hermes acp` sessions and TUI/desktop sessions never appear.
          listItem('other-1', { source: 'acp' }),
          listItem('other-2', { source: 'tui' }),
          // Adapter-created, but this process never learned its cwd: unservable.
          listItem('stored-unknown'),
          listItem('stored-b', { title: '' }),
        ],
      })

      const response = await fixture.client.request(acp.methods.agent.session.list, {})

      const expectedA = fixture.sessionDirectory.get('stored-a')
      expect(response.sessions).toEqual([
        { sessionId: 'stored-a', cwd: '/work/a', title: 'chat stored-a', updatedAt: expectedA?.updatedAt },
        // An empty gateway title maps to null, not "".
        { sessionId: 'stored-b', cwd: '/work/b', title: null, updatedAt: expect.any(String) },
      ])
      expect(response.nextCursor ?? null).toBeNull()
      // One bounded fetch; upstream has no cursor or cwd params to forward.
      expect(fixture.gateway.recordedCalls()).toEqual([
        { method: 'sessionList', args: [{ limit: SESSION_LIST_FETCH_CAP }] },
      ])
    } finally {
      fixture.close()
    }
  })

  it('resolves a live session from its record as well as from the cache', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setResult('sessionCreate', { session_id: GATEWAY_SESSION_ID, stored_session_id: STORED_SESSION_ID })
      scriptSessionSettings(fixture.gateway)
      await fixture.client.request(acp.methods.agent.session.new, { cwd: TEST_CWD, mcpServers: [] })

      fixture.gateway.setResult('sessionList', { sessions: [listItem(STORED_SESSION_ID)] })
      const response = await fixture.client.request(acp.methods.agent.session.list, {})

      expect(response.sessions).toEqual([
        { sessionId: STORED_SESSION_ID, cwd: TEST_CWD, title: `chat ${STORED_SESSION_ID}`, updatedAt: expect.any(String) },
      ])
    } finally {
      fixture.close()
    }
  })

  it('filters by cwd after normalizing both sides', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.sessionDirectory.remember('stored-a', '/work/a')
      fixture.sessionDirectory.remember('stored-b', '/work/b')
      fixture.gateway.setResult('sessionList', { sessions: [listItem('stored-a'), listItem('stored-b')] })

      const response = await fixture.client.request(acp.methods.agent.session.list, { cwd: '/work/../work/b' })

      expect(response.sessions.map((session) => session.sessionId)).toEqual(['stored-b'])
    } finally {
      fixture.close()
    }
  })

  it('rejects a relative cwd filter without touching the gateway', async () => {
    const fixture = createAcpTestFixture()
    try {
      await expect(
        fixture.client.request(acp.methods.agent.session.list, { cwd: 'relative/dir' }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('absolute'),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('rejects a cursor this adapter never issued', async () => {
    const fixture = createAcpTestFixture()
    try {
      await expect(
        fixture.client.request(acp.methods.agent.session.list, { cursor: 'not-a-cursor' }),
      ).rejects.toMatchObject({
        code: acp.RequestError.invalidParams().code,
        message: expect.stringContaining('cursor'),
      })
      expect(fixture.gateway.recordedCalls()).toEqual([])
    } finally {
      fixture.close()
    }
  })

  it('pages by a decimal-offset cursor that round-trips to the end of the list', async () => {
    const fixture = createAcpTestFixture()
    try {
      const rowCount = SESSION_LIST_PAGE_SIZE + 10
      const rows: SessionListItem[] = []
      for (let index = 0; index < rowCount; index += 1) {
        fixture.sessionDirectory.remember(`stored-${index}`, '/work/a')
        rows.push(listItem(`stored-${index}`))
      }
      fixture.gateway.setResult('sessionList', { sessions: rows })

      const firstPage = await fixture.client.request(acp.methods.agent.session.list, {})
      expect(firstPage.sessions).toHaveLength(SESSION_LIST_PAGE_SIZE)
      expect(firstPage.sessions[0]?.sessionId).toBe('stored-0')
      expect(firstPage.nextCursor).toBe(String(SESSION_LIST_PAGE_SIZE))

      const secondPage = await fixture.client.request(acp.methods.agent.session.list, {
        cursor: firstPage.nextCursor ?? null,
      })
      expect(secondPage.sessions).toHaveLength(10)
      expect(secondPage.sessions[0]?.sessionId).toBe(`stored-${SESSION_LIST_PAGE_SIZE}`)
      expect(secondPage.nextCursor ?? null).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it('frames a gateway failure with the failed method', async () => {
    const fixture = createAcpTestFixture()
    try {
      fixture.gateway.setFailure('sessionList')

      await expect(fixture.client.request(acp.methods.agent.session.list, {})).rejects.toMatchObject({
        code: acp.RequestError.internalError().code,
        message: expect.stringContaining('gateway method session.list failed'),
      })
    } finally {
      fixture.close()
    }
  })
})
