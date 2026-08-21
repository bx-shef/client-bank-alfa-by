import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Structural guard: the sweep estimate must be fed a REQUEST budget, never a JOB rate.
//
// ⚠ Why a guard and not a behavioural test. `estimateProviderCycles(plan, rateFor, tick)` takes a
// callback that returns `{ requests, durationMs }`, and `role.fetchRate.max` is a plain number that
// fits that shape perfectly — so passing the limiter's JOB rate straight through compiles, runs,
// and is wrong by exactly `REQUESTS_PER_ACCOUNT`. That is precisely what happened when Alfa's
// limiter started dividing (#561): the Alfa branch kept reading `fetchRate.max` raw while the Prior
// branch multiplied back, so the cron printed a doubled sweep and tripped `exceedsInterval` early —
// telling the operator to raise CRON_LOOKBACK_DAYS for a fleet nowhere near the cap. Nothing
// throttles from that number, so no test could have caught it by observing behaviour.
//
// ⚠ The call lives inside a Nitro plugin (`server/plugins/queue.ts`) behind Redis + a live poll
// plan; there is no seam to mount it from a unit test. The choke point is what we can pin: whatever
// the estimate is called with, it must come through `providerRequestBudget`.

const QUEUE_PLUGIN = resolve(import.meta.dirname, '../server/plugins/queue.ts')

/** The argument list of every `estimateProviderCycles(...)` call in the file (line-break tolerant). */
function estimateCalls(src: string): string[] {
  const out: string[] = []
  const marker = 'estimateProviderCycles('
  let from = 0
  for (;;) {
    const at = src.indexOf(marker, from)
    if (at < 0) break
    let depth = 0
    let i = at + marker.length - 1
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    out.push(src.slice(at + marker.length, i))
    from = i + 1
  }
  return out
}

describe('#561: the poll-cycle estimate is fed requests, not jobs', () => {
  const src = readFileSync(QUEUE_PLUGIN, 'utf8')

  it('finds the call it is guarding (the guard cannot pass by finding nothing)', () => {
    expect(estimateCalls(src)).toHaveLength(1)
  })

  it('converts every rate through providerRequestBudget', () => {
    for (const args of estimateCalls(src)) {
      // Both provider branches must convert; a raw `fetchRate`/`priorFetchRate` read is the bug.
      expect(args).toContain('providerRequestBudget')
      expect(args).not.toMatch(/requests:\s*role\./)
    }
  })

  it('imports the helper rather than open-coding the multiplication', () => {
    // Open-coding `role.fetchRate.max * (REQUESTS_PER_ACCOUNT[...] ?? 1)` twice is how the two
    // branches drifted apart in the first place — one was updated, the other was not.
    expect(src).toContain('providerRequestBudget')
    expect(src).not.toMatch(/\.max\s*\*\s*\(REQUESTS_PER_ACCOUNT/)
  })
})
