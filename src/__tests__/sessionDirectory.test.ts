import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionDirectory } from '../session/sessionDirectory.js'

/**
 * The cwd cache is plain file IO, not a protocol surface, so these are unit
 * tests over real temp files rather than transcript snapshots.
 */

let scratchDir: string
let filePath: string

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'hermes-acp-directory-test-'))
  filePath = join(scratchDir, 'sessions.json')
})

afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('SessionDirectory', () => {
  it('round-trips entries through the file on disk', () => {
    const directory = SessionDirectory.load(filePath)
    directory.remember('stored-1', '/work/one')
    directory.remember('stored-2', '/work/two')

    const reloaded = SessionDirectory.load(filePath)
    expect(reloaded.get('stored-1')?.cwd).toBe('/work/one')
    expect(reloaded.get('stored-2')?.cwd).toBe('/work/two')
    expect(reloaded.get('stored-1')?.updatedAt).toEqual(expect.any(String))
  })

  it('creates the parent directory on the first write', () => {
    const nested = join(scratchDir, 'nested', 'deeper', 'sessions.json')
    const directory = SessionDirectory.load(nested)
    directory.remember('stored-1', '/work/one')

    expect(SessionDirectory.load(nested).get('stored-1')?.cwd).toBe('/work/one')
  })

  it('starts empty when the file does not exist, without logging', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const directory = SessionDirectory.load(filePath)

    expect(directory.get('stored-1')).toBeUndefined()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('starts empty over a corrupt file and re-persists on the next write', () => {
    writeFileSync(filePath, '{ not json', 'utf8')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const directory = SessionDirectory.load(filePath)
    expect(directory.get('stored-1')).toBeUndefined()
    expect(errorSpy).toHaveBeenCalledOnce()

    directory.remember('stored-1', '/work/one')
    expect(SessionDirectory.load(filePath).get('stored-1')?.cwd).toBe('/work/one')
  })

  it('treats a syntactically valid file with the wrong shape as corrupt', () => {
    // A single malformed entry invalidates the file: keeping half of it would
    // be guessing which rows the corruption spared.
    writeFileSync(filePath, JSON.stringify({ sessions: { 'stored-1': { cwd: 42 } } }), 'utf8')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(SessionDirectory.load(filePath).get('stored-1')).toBeUndefined()
  })

  it('forgets an entry on disk, and forget of an unknown id writes nothing', () => {
    const directory = SessionDirectory.load(filePath)
    directory.remember('stored-1', '/work/one')
    directory.forget('stored-1')
    expect(SessionDirectory.load(filePath).get('stored-1')).toBeUndefined()

    const before = readFileSync(filePath, 'utf8')
    directory.forget('never-known')
    expect(readFileSync(filePath, 'utf8')).toBe(before)
  })

  it('bumps updatedAt on touch and remember, never on an unknown id', () => {
    const directory = SessionDirectory.load(filePath)
    directory.remember('stored-1', '/work/one')
    const opened = directory.get('stored-1')?.updatedAt

    directory.touch('stored-1')
    const bumped = directory.get('stored-1')?.updatedAt
    expect(bumped).toEqual(expect.any(String))
    expect(Date.parse(bumped ?? '')).toBeGreaterThanOrEqual(Date.parse(opened ?? ''))

    directory.touch('never-known')
    expect(directory.get('never-known')).toBeUndefined()
  })
})
