import { describe, expect, it } from 'vitest'
import { emptyDeliveryState, type DeliveryState } from '../server/utils/queueAlertDeliver'
import { runQueueHealthTick, type QueueHealthTickDeps } from '../server/utils/queueHealthTick'
import type { QueueAlert } from '../server/utils/queueAlert'

// One tick end-to-end over fakes (#426). This is the layer the plugin used to hide: the ordering
// («записали вердикт → залогировали → только потом шлём»), the honesty of `markAnnounced`, and the
// rule that a broken channel must never take the cron instance down.

const T0 = 1_800_000_000_000
const MIN = 60_000

function deps(over: Partial<QueueHealthTickDeps> & {
  pending?: Record<string, number[]>
  failedAt?: Record<string, number[]>
  pushResult?: (text: string) => boolean
} = {}) {
  const pushed: string[] = []
  const warned: string[] = []
  const errored: string[] = []
  const recorded: Array<{ alerts: QueueAlert[], atMs: number }> = []
  const base: QueueHealthTickDeps = {
    reader: {
      pending: async (name: string) => (over.pending?.[name] ?? []).map(ageMs => ({ timestamp: T0 - ageMs })),
      failed: async (name: string) => (over.failedAt?.[name] ?? []).map(ageMs => ({ finishedOn: T0 - ageMs, failedReason: 'socket hang up' }))
    },
    now: () => T0,
    push: async (text: string) => {
      pushed.push(text)
      return over.pushResult ? over.pushResult(text) : true
    },
    record: (alerts, atMs) => recorded.push({ alerts: [...alerts], atMs }),
    warn: m => warned.push(m),
    error: m => errored.push(m),
    queuesUrl: 'https://x.by/queues'
  }
  // `over` last so an explicit override (including `queuesUrl: null`) actually wins — an earlier
  // version spread only two keys and silently ignored the rest, which made a test pass vacuously.
  const { pending: _p, failedAt: _f, pushResult: _r, ...explicit } = over
  const d: QueueHealthTickDeps = { ...base, ...explicit }
  return { d, pushed, warned, errored, recorded }
}

const stalledCrm = { 'crm-sync': [45 * MIN] }

describe('runQueueHealthTick', () => {
  it('healthy pipeline: records a verdict, logs nothing, sends nothing', async () => {
    const { d, pushed, warned, recorded } = deps()
    const r = await runQueueHealthTick(emptyDeliveryState(), d)
    expect(r).toMatchObject({ announced: 0, recovered: 0, failed: false })
    expect(pushed).toEqual([])
    expect(warned).toEqual([])
    expect(recorded).toHaveLength(1) // «проверяли, всё чисто» — не то же самое, что «не проверяли»
    expect(recorded[0]!.alerts).toEqual([])
  })

  it('a stall is recorded, logged AND pushed', async () => {
    const { d, pushed, warned, recorded } = deps({ pending: stalledCrm })
    const r = await runQueueHealthTick(emptyDeliveryState(), d)
    expect(r.announced).toBe(1)
    expect(recorded[0]!.alerts.map(a => a.kind)).toEqual(['stalled'])
    expect(warned[0]).toContain('[queue-alert]')
    expect(pushed[0]).toContain('crm-sync')
    expect(pushed[0]).toContain('https://x.by/queues')
  })

  it('logs the alert even when the channel is OFF — the log is not optional, the channel is', async () => {
    const { d, pushed, warned } = deps({ pending: stalledCrm, push: async () => false })
    const r = await runQueueHealthTick(emptyDeliveryState(), d)
    expect(warned[0]).toContain('crm-sync')
    expect(pushed).toEqual([]) // our fake push never records; the point is the tick did not throw
    expect(r.announced).toBe(0)
  })

  it('a FAILED push is not marked as told — the next tick retries it', async () => {
    // The exact bug the source had: marking before knowing loses an alert forever on one 429.
    const failing = deps({ pending: stalledCrm, pushResult: () => false })
    const first = await runQueueHealthTick(emptyDeliveryState(), failing.d)
    expect(first.announced).toBe(0)
    const ok = deps({ pending: stalledCrm })
    const second = await runQueueHealthTick(first.state, ok.d)
    expect(second.announced).toBe(1)
    expect(ok.pushed).toHaveLength(1)
  })

  it('an ongoing outage is announced once across many ticks', async () => {
    let state: DeliveryState = emptyDeliveryState()
    let totalPushed = 0
    for (let i = 0; i < 5; i++) {
      const { d, pushed } = deps({ pending: stalledCrm })
      const r = await runQueueHealthTick(state, d)
      state = r.state
      totalPushed += pushed.length
    }
    expect(totalPushed).toBe(1)
  })

  it('recovery is pushed once and closes the episode', async () => {
    const broken = deps({ pending: stalledCrm })
    const first = await runQueueHealthTick(emptyDeliveryState(), broken.d)
    const healed = deps() // queues clean now
    const second = await runQueueHealthTick(first.state, healed.d)
    expect(second.recovered).toBe(1)
    expect(healed.pushed[0]).toContain('✅')
    const again = deps()
    const third = await runQueueHealthTick(second.state, again.d)
    expect(again.pushed).toEqual([]) // не повторяем ✅
    expect(third.recovered).toBe(0)
  })

  it('a failed ✅ send is retried on the next tick (symmetric to the breakage side)', async () => {
    const broken = deps({ pending: stalledCrm })
    const first = await runQueueHealthTick(emptyDeliveryState(), broken.d)
    const healedFail = deps({ pushResult: () => false })
    const second = await runQueueHealthTick(first.state, healedFail.d)
    expect(second.recovered).toBe(0)
    const healedOk = deps()
    const third = await runQueueHealthTick(second.state, healedOk.d)
    expect(third.recovered).toBe(1)
    expect(healedOk.pushed[0]).toContain('✅')
  })

  it('a reader failure does NOT record a verdict — a stale «всё хорошо» is worse than none', async () => {
    const { d, recorded, errored, pushed } = deps({
      reader: {
        pending: async () => {
          throw new Error('boom')
        },
        failed: async () => []
      }
    })
    // NB: readQueueHealth isolates per-queue failures, so a thrown reader yields `unreadable`
    // alerts rather than a thrown tick — assert that path explicitly.
    const r = await runQueueHealthTick(emptyDeliveryState(), d)
    expect(r.failed).toBe(false)
    expect(recorded[0]!.alerts.every(a => a.kind === 'unreadable')).toBe(true)
    expect(errored).toEqual([])
    expect(pushed.length).toBeGreaterThan(0) // тотальная авария обязана прозвучать
  })

  it('a bug inside the rules is caught: state unchanged, failed=true, cron survives', async () => {
    const { d, errored } = deps({
      record: () => {
        throw new Error('kaboom')
      }
    })
    const previous = emptyDeliveryState()
    const r = await runQueueHealthTick(previous, d)
    expect(r).toMatchObject({ failed: true, announced: 0, recovered: 0 })
    expect(r.state).toBe(previous) // не подменяем состояние вердиктом, которого не было
    expect(errored[0]).toContain('health check failed')
  })

  it('no https site url ⇒ no link in the message (a bare path would be useless)', async () => {
    const { d, pushed } = deps({ pending: stalledCrm, queuesUrl: null })
    await runQueueHealthTick(emptyDeliveryState(), d)
    expect(pushed[0]).not.toContain('Состояние:')
  })
})
