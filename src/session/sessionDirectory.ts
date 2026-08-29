/**
 * Persisted stored-session-id → cwd cache.
 *
 * The gateway's `session.list` projects no cwd (methods_session.py ~163), but
 * ACP's `SessionInfo.cwd` is required and `session/list`'s cwd filter must be
 * truthful. Hermes only reports a session's cwd while it is live, so the cwd
 * of every session this adapter opens is recorded here, in a JSON file under
 * the Hermes home (`<hermes-home>/hermes-acp/sessions.json`), and `session/list`
 * only surfaces rows the cache can vouch for.
 *
 * The file is shared state, not a lock-holder: it is rewritten wholesale on
 * every mutation (tmp + rename, so a crash mid-write cannot truncate it), and
 * every failure — an unreadable file at load, an unwritable directory at save
 * — is logged and degrades to an in-memory cache. That is the same call as
 * `commands.catalog`: the session surface still works, `session/list` is just
 * sparse. Losing the cache never loses a session.
 *
 * Nor is it multi-process safe: two adapter processes sharing one Hermes home
 * each load the file once and rewrite it from their own in-memory map, so
 * entries one of them records between the other's load and persist are
 * silently dropped from the file. Accepted — the entry returns the next time
 * that process opens the session.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { SESSION_DIRECTORY_DIRNAME, SESSION_DIRECTORY_FILENAME } from '../constants.js'
import { resolveHermesHome } from '../gateway/options.js'

export interface SessionDirectoryEntry {
  readonly cwd: string
  /** ISO 8601; bumped on open and on turn activity. */
  readonly updatedAt: string
}

/** Where the cache lives for a given process environment. */
export function sessionDirectoryPath(env: NodeJS.ProcessEnv): string {
  return join(resolveHermesHome(env), SESSION_DIRECTORY_DIRNAME, SESSION_DIRECTORY_FILENAME)
}

/** The parsed file, validated field by field; anything else is corrupt. */
function parseEntries(raw: string): Map<string, SessionDirectoryEntry> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const sessions: unknown = (parsed as Record<string, unknown>)['sessions']
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) {
    return null
  }
  const entries = new Map<string, SessionDirectoryEntry>()
  for (const [sessionId, entry] of Object.entries(sessions)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return null
    }
    const fields = entry as Record<string, unknown>
    if (typeof fields['cwd'] !== 'string' || typeof fields['updatedAt'] !== 'string') {
      return null
    }
    entries.set(sessionId, { cwd: fields['cwd'], updatedAt: fields['updatedAt'] })
  }
  return entries
}

export class SessionDirectory {
  private readonly filePath: string
  private readonly entries: Map<string, SessionDirectoryEntry>

  private constructor(filePath: string, entries: Map<string, SessionDirectoryEntry>) {
    this.filePath = filePath
    this.entries = entries
  }

  /**
   * Load the cache from disk. A missing file is a fresh cache, not an error;
   * an unreadable or corrupt one logs and starts empty — persisting again on
   * the next mutation, which is also the self-repair path.
   */
  static load(filePath: string): SessionDirectory {
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[hermes-agent-acp] session directory at ${filePath} could not be read; starting empty: ${message}`)
      }
      return new SessionDirectory(filePath, new Map())
    }
    const entries = parseEntries(raw)
    if (entries === null) {
      console.error(`[hermes-agent-acp] session directory at ${filePath} is corrupt; starting empty`)
      return new SessionDirectory(filePath, new Map())
    }
    return new SessionDirectory(filePath, entries)
  }

  get(sessionId: string): SessionDirectoryEntry | undefined {
    return this.entries.get(sessionId)
  }

  /** Record (or refresh) the cwd of a session this adapter just opened. */
  remember(sessionId: string, cwd: string): void {
    this.entries.set(sessionId, { cwd, updatedAt: new Date().toISOString() })
    this.persist()
  }

  /**
   * Bump the activity timestamp of a known session; a no-op for unknown ids.
   * In memory only: it runs on every turn's end, `updatedAt` is an optional
   * `session/list` field, and the next remember/forget writes it out anyway.
   */
  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry === undefined) {
      return
    }
    this.entries.set(sessionId, { ...entry, updatedAt: new Date().toISOString() })
  }

  /** Drop a deleted session's entry; a no-op for unknown ids. */
  forget(sessionId: string): void {
    if (this.entries.delete(sessionId)) {
      this.persist()
    }
  }

  /**
   * Rewrite the file atomically. A failed write is logged and the in-memory
   * state keeps serving this process — refusing to open sessions over a cache
   * write would fail the wrong subsystem.
   */
  private persist(): void {
    const temporaryPath = `${this.filePath}.tmp`
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(
        temporaryPath,
        JSON.stringify({ sessions: Object.fromEntries(this.entries) }, null, 2),
        'utf8',
      )
      renameSync(temporaryPath, this.filePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[hermes-agent-acp] session directory at ${this.filePath} could not be written: ${message}`)
    }
  }
}
