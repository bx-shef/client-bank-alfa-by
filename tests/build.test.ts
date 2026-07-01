import { describe, expect, it } from 'vitest'
import { REPO_URL, commitUrl, shortSha } from '~/utils/build'

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
