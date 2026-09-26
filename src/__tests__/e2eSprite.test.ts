import { basename, dirname } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  evidenceDirName,
  findExecutable,
  markerValue,
  overallVerdict,
  parseArgs,
  parseProviderKeyLine,
  resolveVerifiedTag,
  scrubSecrets,
  summarizeTests,
  testsPassed,
  utcStamp,
} from '../../scripts/e2eSprite.js'

describe('parseArgs', () => {
  it('reads --tag and --keep, defaulting keep to false', () => {
    expect(parseArgs([])).toEqual({ tag: undefined, keep: false })
    expect(parseArgs(['--tag', 'v2026.9.11'])).toEqual({ tag: 'v2026.9.11', keep: false })
    expect(parseArgs(['--keep', '--tag', 'v1'])).toEqual({ tag: 'v1', keep: true })
  })

  it('fails fast on a value-less --tag and on unknown flags', () => {
    expect(() => parseArgs(['--tag'])).toThrow(/--tag requires a value/)
    expect(() => parseArgs(['--tag', '--keep'])).toThrow(/--tag requires a value/)
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/)
  })
})

describe('parseProviderKeyLine', () => {
  it('reads the key, allowing an export prefix and surrounding whitespace', () => {
    expect(parseProviderKeyLine('OPENROUTER_API_KEY=sk-or-v1-abc')).toBe('sk-or-v1-abc')
    expect(parseProviderKeyLine('  export OPENROUTER_API_KEY = sk-or-v1-abc  ')).toBe('sk-or-v1-abc')
  })

  it('strips a trailing comment from an unquoted value only', () => {
    expect(parseProviderKeyLine('OPENROUTER_API_KEY=sk-or-v1-abc # rotated 2026-09')).toBe('sk-or-v1-abc')
    expect(parseProviderKeyLine('OPENROUTER_API_KEY="sk-or-v1-a#b" # rotated')).toBe('sk-or-v1-a#b')
    expect(parseProviderKeyLine("OPENROUTER_API_KEY='sk-or-v1-a#b'")).toBe('sk-or-v1-a#b')
  })

  it('returns null for other lines and empty values', () => {
    expect(parseProviderKeyLine('# OPENROUTER_API_KEY=commented-out')).toBeNull()
    expect(parseProviderKeyLine('OTHER_KEY=sk-or-v1-abc')).toBeNull()
    expect(parseProviderKeyLine('OPENROUTER_API_KEY=')).toBeNull()
    expect(parseProviderKeyLine('OPENROUTER_API_KEY=""')).toBeNull()
    expect(parseProviderKeyLine('')).toBeNull()
  })
})

describe('resolveVerifiedTag', () => {
  it('extracts the tag from the docs/refs.md verified line, not the floor line', () => {
    const refs =
      'blah\n- Floor: Hermes 0.20.5 (tag `v2026.8.19`), the oldest...\n- Verified against: Hermes 0.20.6 (tag `v2026.8.27`), the release...\nmore'
    expect(resolveVerifiedTag(refs)).toBe('v2026.8.27')
  })

  it('fails fast when the verified line is absent', () => {
    expect(() => resolveVerifiedTag('no verified release here')).toThrow(/verified Hermes tag/)
  })
})

describe('scrubSecrets', () => {
  it('redacts the known key value and secret-shaped substrings', () => {
    const scrubbed = scrubSecrets('key=sk-or-v1-abc123 and header Authorization: Bearer tok', ['sk-or-v1-abc123'])
    expect(scrubbed).not.toContain('sk-or-v1-abc123')
    expect(scrubbed).not.toContain('tok')
    expect(scrubbed).toContain('<redacted>')
  })

  it('leaves unrelated text intact and ignores empty secrets', () => {
    expect(scrubSecrets('plain output line', [''])).toBe('plain output line')
  })
})

describe('utcStamp / evidenceDirName', () => {
  it('formats a filesystem-safe UTC stamp and folder name', () => {
    const date = new Date('2026-09-12T17:30:45.123Z')
    expect(utcStamp(date)).toBe('20260912T173045Z')
    expect(evidenceDirName(date, 'v2026.9.11')).toBe('20260912T173045Z-v2026.9.11')
  })

  it('reduces unsafe tag characters to dashes', () => {
    expect(evidenceDirName(new Date('2026-01-02T03:04:05.000Z'), 'feature/x y')).toBe('20260102T030405Z-feature-x-y')
  })
})

describe('findExecutable', () => {
  it('returns null when PATH is empty or the name is absent', () => {
    expect(findExecutable('sprite', '')).toBeNull()
    expect(findExecutable('definitely-not-a-real-binary', undefined)).toBeNull()
  })

  it('finds an executable that exists on PATH', () => {
    // The runtime binary is a real executable in a real dir — a stable positive.
    expect(findExecutable(basename(process.execPath), dirname(process.execPath))).toBe(process.execPath)
  })
})

describe('markerValue', () => {
  it('extracts a trimmed KEY=value from multiline output', () => {
    const output = 'some log\nHERMES_VERSION= 0.20.6 \nVENV_BIN=/tree/.venv/bin\n'
    expect(markerValue(output, 'HERMES_VERSION')).toBe('0.20.6')
    expect(markerValue(output, 'VENV_BIN')).toBe('/tree/.venv/bin')
  })

  it('returns undefined for an absent key or an empty value', () => {
    expect(markerValue('HERMES_VERSION=0.20.6', 'NOPE')).toBeUndefined()
    expect(markerValue('KEY=\nOTHER=1', 'KEY')).toBeUndefined()
  })
})

describe('overallVerdict', () => {
  it('passes only when every critical step is ok and tests passed', () => {
    expect(overallVerdict(['ok', 'ok', 'ok'], true)).toBe('passed')
    expect(overallVerdict(['ok', 'ok', 'ok'], false)).toBe('failed')
    expect(overallVerdict(['ok', 'timeout', 'ok'], true)).toBe('failed')
    expect(overallVerdict(['ok', 'skipped'], true)).toBe('failed')
  })
})

describe('summarizeTests', () => {
  it('returns null for absent or unparseable reports', () => {
    expect(summarizeTests(null)).toBeNull()
    expect(summarizeTests('not json')).toBeNull()
    expect(summarizeTests('{"noCounts":true}')).toBeNull()
  })

  it('reduces a vitest report to counts and failed names', () => {
    const report = JSON.stringify({
      numTotalTests: 4,
      numPassedTests: 2,
      numFailedTests: 1,
      numPendingTests: 1,
      testResults: [
        {
          name: 'halfDeadClient.e2e.test.ts',
          assertionResults: [
            { fullName: 'a passes', status: 'passed' },
            { fullName: 'floods the pipe', status: 'failed' },
          ],
        },
      ],
    })
    expect(summarizeTests(report)).toEqual({ total: 4, passed: 2, failed: 1, pending: 1, failedNames: ['floods the pipe'] })
  })
})

describe('testsPassed', () => {
  it('is green only when tests actually ran clean', () => {
    expect(testsPassed({ total: 5, passed: 5, failed: 0, pending: 0, failedNames: [] })).toBe(true)
  })

  it('is not green for a failure, a skip, or a zero-ran (all-skipped) suite', () => {
    expect(testsPassed(null)).toBe(false)
    expect(testsPassed({ total: 5, passed: 4, failed: 1, pending: 0, failedNames: ['x'] })).toBe(false)
    expect(testsPassed({ total: 5, passed: 4, failed: 0, pending: 1, failedNames: [] })).toBe(false)
    // The laundering case: vitest exits 0 with total > 0 but nothing executed.
    expect(testsPassed({ total: 6, passed: 0, failed: 0, pending: 6, failedNames: [] })).toBe(false)
  })
})
