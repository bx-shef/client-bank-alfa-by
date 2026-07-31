import { describe, expect, it } from 'vitest'
import type { QueueAlert } from '../server/utils/queueAlert'
import {
  MIN_REANNOUNCE_MS, alertMessage, emptyDeliveryState, episodeKey,
  markAnnounced, planAlertDelivery, recoveryMessage
} from '../server/utils/queueAlertDeliver'

// Delivery rules (#426). The whole value of this module is negative: it decides what NOT to send.
// A channel that repeats itself stops being read, and then it fails on the one occasion it exists
// for — so «не отправили» is the behaviour under test, not an absence of behaviour.

const stalled = (queue: string): QueueAlert => ({ kind: 'stalled', queue, text: `очередь «${queue}» не разгребается` })
const failing = (queue: string): QueueAlert => ({ kind: 'failing', queue, text: `очередь «${queue}» падает` })

const T0 = 1_800_000_000_000

describe('planAlertDelivery', () => {
  it('announces a brand-new problem', () => {
    const plan = planAlertDelivery([stalled('crm-sync')], emptyDeliveryState(), T0)
    expect(plan.opened.map(a => a.queue)).toEqual(['crm-sync'])
    expect(plan.recovered).toEqual([])
  })

  it('stays SILENT while the same problem is ongoing (announced once, not every 5 min)', () => {
    const a = stalled('crm-sync')
    let state = planAlertDelivery([a], emptyDeliveryState(), T0).state
    state = markAnnounced(state, episodeKey(a), T0)
    const second = planAlertDelivery([a], state, T0 + 5 * 60_000)
    expect(second.opened).toEqual([])
  })

  it('an episode whose SEND FAILED is retried next check (one 429 must not bury an alert)', () => {
    const a = stalled('crm-sync')
    // Plan, but never markAnnounced — that models the send failing.
    const state = planAlertDelivery([a], emptyDeliveryState(), T0).state
    const second = planAlertDelivery([a], state, T0 + 5 * 60_000)
    expect(second.opened.map(x => x.queue)).toEqual(['crm-sync'])
  })

  it('reports recovery only for a breakage that was actually ANNOUNCED', () => {
    const a = stalled('crm-sync')
    let state = planAlertDelivery([a], emptyDeliveryState(), T0).state
    state = markAnnounced(state, episodeKey(a), T0)
    const cleared = planAlertDelivery([], state, T0 + 10 * 60_000)
    expect(cleared.recovered).toEqual(['stalled:crm-sync'])
  })

  it('a SUPPRESSED flap produces no ✅ either (otherwise the recovery half alone is 12 msgs/hour)', () => {
    const a = stalled('crm-sync')
    // Never announced (send failed) → its clearing must stay silent too.
    const state = planAlertDelivery([a], emptyDeliveryState(), T0).state
    expect(planAlertDelivery([], state, T0 + 60_000).recovered).toEqual([])
  })

  it('a flapping problem is not re-announced within the floor', () => {
    const a = stalled('crm-sync')
    let state = planAlertDelivery([a], emptyDeliveryState(), T0).state
    state = markAnnounced(state, episodeKey(a), T0)
    state = planAlertDelivery([], state, T0 + 5 * 60_000).state // cleared
    const again = planAlertDelivery([a], state, T0 + 10 * 60_000) // tripped again, well inside the floor
    expect(again.opened).toEqual([])
  })

  it('…but a genuinely new incident past the floor IS announced again', () => {
    const a = stalled('crm-sync')
    let state = planAlertDelivery([a], emptyDeliveryState(), T0).state
    state = markAnnounced(state, episodeKey(a), T0)
    state = planAlertDelivery([], state, T0 + 5 * 60_000).state
    const again = planAlertDelivery([a], state, T0 + MIN_REANNOUNCE_MS + 60_000)
    expect(again.opened.map(x => x.queue)).toEqual(['crm-sync'])
  })

  it('different kinds on the same queue are distinct episodes', () => {
    const plan = planAlertDelivery([stalled('crm-sync'), failing('crm-sync')], emptyDeliveryState(), T0)
    expect(plan.opened).toHaveLength(2)
    expect(new Set(plan.opened.map(episodeKey)).size).toBe(2)
  })

  it('prunes stale timestamps so the map cannot grow for the process lifetime', () => {
    const a = stalled('crm-sync')
    let state = markAnnounced(planAlertDelivery([a], emptyDeliveryState(), T0).state, episodeKey(a), T0)
    state = planAlertDelivery([], state, T0 + 60_000).state // gone
    const late = planAlertDelivery([], state, T0 + MIN_REANNOUNCE_MS + 60_000)
    expect(Object.keys(late.state.announcedAtMs)).toEqual([])
  })
})

describe('messages', () => {
  it('names the app — one operator may watch several services in the same chat', () => {
    expect(alertMessage(stalled('crm-sync'))).toContain('Импорт выписки клиент-банка')
  })

  it('appends the /queues link only when a https site url is configured', () => {
    expect(alertMessage(stalled('crm-sync'), 'https://x.by/queues')).toContain('https://x.by/queues')
    expect(alertMessage(stalled('crm-sync'), null)).not.toContain('Состояние:')
  })

  it('recovery message names the queue and what stopped', () => {
    const m = recoveryMessage('stalled:bank-fetch')
    expect(m).toContain('bank-fetch')
    expect(m).toContain('простой')
  })

  it('carries NO financial data — only queue names and counters (docs/PRIVACY.md)', () => {
    // Guards the privacy contract at the only place text is built. A future edit that interpolates
    // an operation into the alert would have to delete this test to pass.
    const text = alertMessage(stalled('crm-sync'), 'https://x.by/queues') + recoveryMessage('failing:crm-sync')
    expect(text).not.toMatch(/BY\d{2}[A-Z]{4}/) // IBAN
    expect(text).not.toMatch(/\d+[.,]\d{2}/) // money
  })
})
