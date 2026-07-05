import { describe, expect, it } from 'vitest'
import {
  hasMoreResults,
  isQueryReady,
  mergePages,
  normalizeSearchTerm,
  resolveHasMore
} from '~/utils/remoteSearch'

describe('normalizeSearchTerm', () => {
  it('trims edges, keeps inner spaces', () => {
    expect(normalizeSearchTerm('  АО Ромашка  ')).toBe('АО Ромашка')
    expect(normalizeSearchTerm('\t\nx\n')).toBe('x')
    expect(normalizeSearchTerm('')).toBe('')
  })
})

describe('isQueryReady', () => {
  it('empty term is always ready (default/recent list)', () => {
    expect(isQueryReady('', 3)).toBe(true)
    expect(isQueryReady('', 0)).toBe(true)
  })

  it('non-empty term needs at least minChars', () => {
    expect(isQueryReady('ab', 3)).toBe(false)
    expect(isQueryReady('abc', 3)).toBe(true)
    expect(isQueryReady('abcd', 3)).toBe(true)
  })

  it('minChars <= 0 means every non-empty term searches', () => {
    expect(isQueryReady('a', 0)).toBe(true)
    expect(isQueryReady('a', -5)).toBe(true)
  })
})

describe('mergePages', () => {
  const key = (x: { id: string }) => x.id

  it('appends new rows, preserving order', () => {
    const a = [{ id: '1' }, { id: '2' }]
    const b = [{ id: '3' }, { id: '4' }]
    expect(mergePages(a, b, key).map(key)).toEqual(['1', '2', '3', '4'])
  })

  it('de-dupes overlapping rows (server returned an overlapping window)', () => {
    const a = [{ id: '1' }, { id: '2' }]
    const b = [{ id: '2' }, { id: '3' }]
    expect(mergePages(a, b, key).map(key)).toEqual(['1', '2', '3'])
  })

  it('empty incoming leaves the list unchanged', () => {
    const a = [{ id: '1' }]
    expect(mergePages(a, [], key)).toEqual(a)
  })
})

describe('hasMoreResults', () => {
  it('true while loaded < total', () => {
    expect(hasMoreResults(10, 42)).toBe(true)
    expect(hasMoreResults(42, 42)).toBe(false)
    expect(hasMoreResults(50, 42)).toBe(false) // over-count is safe
    expect(hasMoreResults(0, 0)).toBe(false)
  })
})

describe('resolveHasMore', () => {
  it('explicit hasMore wins over total', () => {
    expect(resolveHasMore(1, { hasMore: true, total: 1 })).toBe(true)
    expect(resolveHasMore(0, { hasMore: false, total: 99 })).toBe(false)
  })

  it('falls back to total when hasMore absent', () => {
    expect(resolveHasMore(2, { total: 5 })).toBe(true)
    expect(resolveHasMore(5, { total: 5 })).toBe(false)
  })

  it('no signal at all ⇒ no next page (single complete page)', () => {
    expect(resolveHasMore(3, {})).toBe(false)
  })
})
