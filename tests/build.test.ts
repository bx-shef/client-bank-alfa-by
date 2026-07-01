import { describe, expect, it } from 'vitest'
import { REPO_URL, commitUrl, healthInfo, shortSha } from '~/utils/build'

describe('shortSha', () => {
  it('takes the first 7 chars', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456')
  })
  it('is empty for missing/blank', () => {
    expect(shortSha('')).toBe('')
    expect(shortSha(undefined)).toBe('')
    expect(shortSha(null)).toBe('')
  })
})

describe('commitUrl', () => {
  it('links to the exact commit when a SHA is given', () => {
    expect(commitUrl('abc123')).toBe(`${REPO_URL}/commit/abc123`)
  })
  it('falls back to the repo root when unknown', () => {
    expect(commitUrl('')).toBe(REPO_URL)
    expect(commitUrl(undefined)).toBe(REPO_URL)
  })
})

describe('healthInfo', () => {
  const now = '2026-07-01T10:00:00.000Z'
  it('reports status ok, the time, and the build commit + link', () => {
    expect(healthInfo('abc123', now)).toEqual({
      status: 'ok',
      time: now,
      commit: 'abc123',
      commitUrl: `${REPO_URL}/commit/abc123`
    })
  })
  it('falls back to "dev" and the repo root when no SHA is injected', () => {
    expect(healthInfo('', now)).toEqual({ status: 'ok', time: now, commit: 'dev', commitUrl: REPO_URL })
    expect(healthInfo(undefined, now)).toEqual({ status: 'ok', time: now, commit: 'dev', commitUrl: REPO_URL })
  })
})
