import { describe, expect, it } from 'vitest'
import { claimProgramFeedbackSlot, type ProgramFeedbackGateDeps } from '../server/utils/programFeedbackCap'

// In-memory Redis stand-ins: a dedup NX set + an INCR counter map.
function fakeDeps(nowMs = 0): ProgramFeedbackGateDeps & { dedup: Set<string>, counts: Map<string, number> } {
  const dedup = new Set<string>()
  const counts = new Map<string, number>()
  return {
    dedup,
    counts,
    claimDedup: async (key) => {
      if (dedup.has(key)) return false
      dedup.add(key)
      return true
    },
    incrCap: async (key) => {
      const v = (counts.get(key) ?? 0) + 1
      counts.set(key, v)
      return v
    },
    now: () => nowMs
  }
}

describe('claimProgramFeedbackSlot', () => {
  it('files a fresh signature, then dedups the same signature', async () => {
    const d = fakeDeps()
    expect(await claimProgramFeedbackSlot(d, 'm1', 'unmatched')).toEqual({ file: true })
    expect(await claimProgramFeedbackSlot(d, 'm1', 'unmatched')).toEqual({ file: false, reason: 'dup' })
  })

  it('a duplicate signature does NOT consume a cap slot', async () => {
    const d = fakeDeps()
    await claimProgramFeedbackSlot(d, 'm1', 'manual')
    await claimProgramFeedbackSlot(d, 'm1', 'manual') // deduped
    // only one cap increment happened
    expect([...d.counts.values()]).toEqual([1])
  })

  it('enforces the per-portal hourly cap across distinct signatures', async () => {
    const d = fakeDeps()
    const results = []
    for (let i = 0; i < 12; i++) {
      results.push(await claimProgramFeedbackSlot(d, 'm1', `sig${i}`, { hourlyCap: 10 }))
    }
    expect(results.slice(0, 10).every(r => r.file)).toBe(true)
    expect(results[10]).toEqual({ file: false, reason: 'cap' })
    expect(results[11]).toEqual({ file: false, reason: 'cap' })
  })

  it('scopes dedup + cap per portal (m2 unaffected by m1)', async () => {
    const d = fakeDeps()
    await claimProgramFeedbackSlot(d, 'm1', 'unmatched')
    expect(await claimProgramFeedbackSlot(d, 'm2', 'unmatched')).toEqual({ file: true })
  })

  it('cap resets in a new hour bucket', async () => {
    const d1 = fakeDeps(0)
    await claimProgramFeedbackSlot(d1, 'm1', 's', { hourlyCap: 1 })
    expect(await claimProgramFeedbackSlot(d1, 'm1', 's2', { hourlyCap: 1 })).toEqual({ file: false, reason: 'cap' })
    // Next hour → different bucket key → cap fresh (same fake counters, new key).
    const d2 = fakeDeps(3_600_000)
    // reuse d1's counters/dedup to prove only the bucket key changes
    d2.incrCap = d1.incrCap
    d2.claimDedup = d1.claimDedup
    expect(await claimProgramFeedbackSlot(d2, 'm1', 's3', { hourlyCap: 1 })).toEqual({ file: true })
  })
})
