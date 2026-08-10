import { describe, expect, it } from 'vitest'
import { evaluateQueueHealth, type QueueAlert } from '../server/utils/queueAlert'
import {
  MIN_REANNOUNCE_MS, alertMessage, emptyDeliveryState, episodeKey,
  markAnnounced, markRecovered, planAlertDelivery, recoveryMessage
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

  it('recovery is announced exactly ONCE — markRecovered closes the episode', () => {
    // Without the awaitingRecovery filter the ✅ repeats on every tick: 12 an hour, forever.
    const a = stalled('crm-sync')
    let state = markAnnounced(planAlertDelivery([a], emptyDeliveryState(), T0).state, episodeKey(a), T0)
    const first = planAlertDelivery([], state, T0 + 5 * 60_000)
    expect(first.recovered).toEqual(['stalled:crm-sync'])
    state = markRecovered(first.state, 'stalled:crm-sync')
    expect(planAlertDelivery([], state, T0 + 10 * 60_000).recovered).toEqual([])
    expect(planAlertDelivery([], state, T0 + 60 * 60_000).recovered).toEqual([])
  })

  it('a FAILED recovery send is retried next tick (symmetric to the breakage side)', () => {
    // The episode stays «awaiting» until markRecovered — so one 429 no longer loses the ✅ for good,
    // which used to leave the channel with an unclosed «сломалось».
    const a = stalled('crm-sync')
    const state = markAnnounced(planAlertDelivery([a], emptyDeliveryState(), T0).state, episodeKey(a), T0)
    const first = planAlertDelivery([], state, T0 + 5 * 60_000)
    expect(first.recovered).toEqual(['stalled:crm-sync'])
    // Do NOT markRecovered — models the send failing.
    expect(planAlertDelivery([], first.state, T0 + 10 * 60_000).recovered).toEqual(['stalled:crm-sync'])
  })

  it('РЕГРЕСС: повторно сломавшаяся очередь НЕ замолкает навсегда после мерцания', () => {
    // Реальная авария могла молчать сутками: эпизод сломался → объявлен → починился → ✅ →
    // сломался снова внутри окна (подавлено) — и с этого момента ветка «уже сообщали»
    // срабатывала раньше проверки окна, поэтому переобъявления не случалось НИКОГДА.
    const a = stalled('crm-sync')
    let state = markAnnounced(planAlertDelivery([a], emptyDeliveryState(), T0).state, episodeKey(a), T0)
    const cleared = planAlertDelivery([], state, T0 + 5 * 60_000)
    state = markRecovered(cleared.state, 'stalled:crm-sync') // ✅ доставлено
    // Ломается снова внутри окна — молчим (защита от мерцания).
    state = planAlertDelivery([a], state, T0 + 10 * 60_000).state
    // Продолжает лежать. За окном обязано прозвучать снова, а не молчать вечно.
    const later = planAlertDelivery([a], state, T0 + MIN_REANNOUNCE_MS + 15 * 60_000)
    expect(later.opened.map(x => x.queue)).toEqual(['crm-sync'])
  })

  it('идущая авария не переобъявляется, сколько бы ни длилась (пока не закрыта)', () => {
    const a = stalled('crm-sync')
    let state = markAnnounced(planAlertDelivery([a], emptyDeliveryState(), T0).state, episodeKey(a), T0)
    for (const t of [1, 2, 6, 24]) {
      const plan = planAlertDelivery([a], state, T0 + t * 60 * 60_000)
      expect(plan.opened, `через ${t} ч`).toEqual([])
      state = plan.state
    }
  })

  it('граница окна: на миллисекунду раньше молчит, ровно на окне — уже говорит', () => {
    // Строгое `<` в правиле: окно ИСТЕКЛО ровно в MIN_REANNOUNCE_MS, значит объявлять уже можно.
    // Фиксируем именно эту границу, иначе мутация `<`↔`<=` прошла бы незамеченной.
    const a = stalled('crm-sync')
    let state = markAnnounced(planAlertDelivery([a], emptyDeliveryState(), T0).state, episodeKey(a), T0)
    state = markRecovered(planAlertDelivery([], state, T0 + 60_000).state, 'stalled:crm-sync')
    expect(planAlertDelivery([a], state, T0 + MIN_REANNOUNCE_MS - 1).opened).toEqual([])
    expect(planAlertDelivery([a], state, T0 + MIN_REANNOUNCE_MS).opened).toHaveLength(1)
  })

  it('a SUPPRESSED flap produces no ✅ either (otherwise the recovery half alone is 12 msgs/hour)', () => {
    const a = stalled('crm-sync')
    // Never announced (send failed) → its clearing must stay silent too.
    const state = planAlertDelivery([a], emptyDeliveryState(), T0).state
    expect(planAlertDelivery([], state, T0 + 60_000).recovered).toEqual([])
  })

  it('a flapping problem is not re-announced within the floor', () => {
    const a = stalled('crm-sync')
    let state = markAnnounced(planAlertDelivery([a], emptyDeliveryState(), T0).state, episodeKey(a), T0)
    state = markRecovered(planAlertDelivery([], state, T0 + 5 * 60_000).state, episodeKey(a)) // cleared
    const again = planAlertDelivery([a], state, T0 + 10 * 60_000) // tripped again, well inside the floor
    expect(again.opened).toEqual([])
  })

  it('…but a genuinely new incident past the floor IS announced again', () => {
    const a = stalled('crm-sync')
    let state = markAnnounced(planAlertDelivery([a], emptyDeliveryState(), T0).state, episodeKey(a), T0)
    state = markRecovered(planAlertDelivery([], state, T0 + 5 * 60_000).state, episodeKey(a))
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
    state = markRecovered(planAlertDelivery([], state, T0 + 60_000).state, episodeKey(a)) // gone
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

  it('приватность СКВОЗНАЯ: текст выводим только из имени очереди и счётчиков (docs/PRIVACY.md)', () => {
    // Проверять регексами литерал, который сам же и собрал тест, — театр: он пройдёт и с
    // `alertMessage = () => ''`. Гоним настоящий путь `QueueHealthInput → evaluate → plan →
    // message` и требуем, чтобы КАЖДЫЙ непробельный кусок итога был выводим из входа, где
    // денежных полей нет по типу. Подмешать в сообщение платёж, не уронив этот тест, нельзя.
    const input = [{ queue: 'crm-sync', pending: 7, oldestPendingAgeMs: 45 * 60_000, recentFailures: 4 }]
    const alerts = evaluateQueueHealth(input)
    const plan = planAlertDelivery(alerts, emptyDeliveryState(), T0)
    const texts = [...plan.opened.map(a => alertMessage(a, 'https://x.by/queues')), recoveryMessage('stalled:crm-sync')]

    // Единственные «данные» на входе — имя очереди и три числа. Всё остальное обязано быть
    // статическим текстом модуля.
    const allowedNumbers = new Set(['7', '4', '45'])
    for (const t of texts) {
      for (const n of t.match(/\d+/g) ?? []) {
        expect(allowedNumbers.has(n), `в сообщении появилось число «${n}», которого нет во входе: ${t}`).toBe(true)
      }
      expect(t).not.toMatch(/BY\d{2}[A-Z]{4}/) // IBAN
      expect(t).not.toMatch(/\d+[.,]\d{2}/) // деньги
    }
    // И сам вход по типу не умеет нести платёж: полей суммы/счёта/назначения в нём нет.
    expect(Object.keys(input[0]!).sort()).toEqual(['oldestPendingAgeMs', 'pending', 'queue', 'recentFailures'])
  })
})
