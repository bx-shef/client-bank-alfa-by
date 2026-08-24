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

// Мёртвое банковское подключение (#497 §3): нет refresh-токена ⇒ продлить нечем, чинит человек.
const deadBankRow = {
  id: 1,
  memberId: 'M1',
  provider: 'alfa-by' as const,
  accountKey: 'BY01',
  connectedAt: T0,
  expiresAt: T0 + 3_600_000,
  hasRefresh: false
}

describe('мёртвые банковские подключения — в тот же канал (#497 §3)', () => {
  it('уходят в пуш, а не только на экран', async () => {
    // Смысл всей правки: карточку на `/queues` надо ОТКРЫТЬ, а refresh Альфы умирает под утро,
    // когда на экран никто не смотрит.
    const { d, pushed } = deps({ bankRows: async () => [deadBankRow] })
    const r = await runQueueHealthTick(emptyDeliveryState(), d)
    expect(r.announced).toBe(1)
    expect(pushed.join('\n')).toContain('Альфа-Банк')
  })

  it('попадают в вердикт для `/queues` тем же списком', async () => {
    const { d, recorded } = deps({ bankRows: async () => [deadBankRow] })
    await runQueueHealthTick(emptyDeliveryState(), d)
    expect(recorded[0]?.alerts.map(a => a.kind)).toContain('bank-dead')
  })

  it('НЕДОСТУПНАЯ БАЗА не отменяет проверку конвейера', async () => {
    // Отказ чтения подключений изолирован: проверка очередей уже отработала, и терять её вердикт
    // из-за второго источника нельзя. Молчание про банки честнее выдумки.
    const { d, pushed, errored, recorded } = deps({
      pending: stalledCrm,
      bankRows: async () => { throw new Error('ECONNREFUSED') }
    })
    const r = await runQueueHealthTick(emptyDeliveryState(), d)
    expect(r.failed).toBe(false)
    expect(r.announced).toBe(1)
    expect(pushed.join('\n')).toContain('crm-sync')
    expect(recorded[0]?.alerts.map(a => a.kind)).not.toContain('bank-dead')
    expect(errored.join('\n')).toContain('bank health read failed')
  })

  it('без зависимости тик работает ровно как прежде', async () => {
    const { d, pushed } = deps()
    const r = await runQueueHealthTick(emptyDeliveryState(), d)
    expect(r.announced).toBe(0)
    expect(pushed).toEqual([])
  })

  it('эпизод НЕ повторяется на каждом тике, а восстановление объявляется', async () => {
    const broken = deps({ bankRows: async () => [deadBankRow] })
    const first = await runQueueHealthTick(emptyDeliveryState(), broken.d)
    const still = deps({ bankRows: async () => [deadBankRow] })
    const second = await runQueueHealthTick(first.state, still.d)
    expect(second.announced).toBe(0) // уже сказали — канал, который повторяется, перестают читать
    const healed = deps({ bankRows: async () => [] })
    const third = await runQueueHealthTick(second.state, healed.d)
    expect(third.recovered).toBe(1)
    expect(healed.pushed.join('\n')).toContain('мёртвых подключений больше нет')
  })
})

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
    // ⚠ Маркер `[queue-alert]` теперь печатает КАНАЛ (#529) — в тексте тревоги его быть не
    // должно, иначе строка выйдет с двумя одинаковыми префиксами. Проверяем суть сообщения.
    expect(warned[0]).not.toContain('[queue-alert]')
    expect(warned[0]).toContain('crm-sync')
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

describe('пульс продления токенов (#504)', () => {
  const stalePulse = {
    pulse: { atMs: T0 - 5 * 60 * MIN, summary: { selected: 0, refreshed: 0, skipped: 0, failed: 0, unrefreshable: 0, expired: 0 } },
    intervalMs: 60 * MIN
  }

  it('встало продление — уходит в пуш отдельным эпизодом', async () => {
    // Смысл #504: остановку продления сегодня видно только в логе, а лог требует, чтобы кто-то уже
    // смотрел. Диагноз здесь НАШ («машинерия встала»), а не «банк отверг» — потому и эпизод свой.
    const { d, pushed } = deps({ keepAlive: () => stalePulse })
    const r = await runQueueHealthTick(emptyDeliveryState(), d)
    expect(r.announced).toBe(1)
    expect(pushed.join('\n')).toContain('продление банковских токенов')
  })

  it('свежий пульс — тишина', async () => {
    const { d, pushed } = deps({
      keepAlive: () => ({ pulse: { ...stalePulse.pulse, atMs: T0 - 10 * MIN }, intervalMs: 60 * MIN })
    })
    const r = await runQueueHealthTick(emptyDeliveryState(), d)
    expect(r.announced).toBe(0)
    expect(pushed).toEqual([])
  })

  it('без зависимости тик работает ровно как прежде', async () => {
    const { d } = deps()
    expect((await runQueueHealthTick(emptyDeliveryState(), d)).announced).toBe(0)
  })

  it('эпизод не повторяется, а восстановление объявляется связной фразой', async () => {
    const broken = deps({ keepAlive: () => stalePulse })
    const first = await runQueueHealthTick(emptyDeliveryState(), broken.d)
    const still = deps({ keepAlive: () => stalePulse })
    const second = await runQueueHealthTick(first.state, still.d)
    expect(second.announced).toBe(0)
    const healed = deps({ keepAlive: () => ({ pulse: { ...stalePulse.pulse, atMs: T0 }, intervalMs: 60 * MIN }) })
    const third = await runQueueHealthTick(second.state, healed.d)
    expect(third.recovered).toBe(1)
    expect(healed.pushed.join('\n')).toContain('снова отрабатывает')
  })

  it('попадает и в вердикт для `/queues`, а не только в чат', async () => {
    const { d, recorded } = deps({ keepAlive: () => stalePulse })
    await runQueueHealthTick(emptyDeliveryState(), d)
    expect(recorded[0]?.alerts.map(a => a.kind)).toContain('keepalive-stale')
  })
})

describe('воркеры: тревога, изоляция и эпизод (#466 §1)', () => {
  // ⚠ Эти проверки ВЫПОЛНЯЮТ тик через `deps`, а не грепают исходник. Первая редакция PR грепала —
  // и ревью прошло её пятью мутациями подряд: пульс можно завести и не запустить, `catch` оставить
  // и всё равно уронить процесс, изоляцию оставить текстом и превратить в ложную тревогу, `scan`
  // вызвать и выбросить результат. Шаблон взят у соседних блоков `bankRows`/`keepAlive` в этом же
  // файле — он тут был всё это время.

  it('ноль живых воркеров ⇒ тревога уходит в канал', async () => {
    const { d, pushed } = deps({ workers: async () => ({ live: 0, queuesEnabled: true, startedAtMs: T0 - 60 * MIN }) })
    await runQueueHealthTick(emptyDeliveryState(), d)
    expect(pushed.join('\n')).toMatch(/ни один воркер не отметился/)
  })

  it('есть живой ⇒ молчим', async () => {
    const { d, pushed } = deps({ workers: async () => ({ live: 2, queuesEnabled: true, startedAtMs: T0 - 60 * MIN }) })
    await runQueueHealthTick(emptyDeliveryState(), d)
    expect(pushed).toEqual([])
  })

  it('ХОЛОДНЫЙ СТАРТ не будит ложной тревогой', async () => {
    // ⚠ Ровно сценарий выката: ключи пульса истекли за простой, backend поднялся первым, первый тик
    // идёт сразу и видит ноль живых, пока воркер грузится. Без отсрочки владелец получал бы
    // «нет воркеров» + «✅ восстановлено» на КАЖДОМ `docker compose up`.
    const { d, pushed } = deps({ workers: async () => ({ live: 0, queuesEnabled: true, startedAtMs: T0 - 10_000 }) })
    await runQueueHealthTick(emptyDeliveryState(), d)
    expect(pushed, 'холодный старт разбудил владельца').toEqual([])
  })

  it('отказ чтения Redis НЕ превращается в тревогу «нет воркеров»', async () => {
    // ⚠ При недоступном Redis «ноль живых» — это НЕЗНАНИЕ, а не факт. Ложная тревога здесь
    // сработала бы ровно в аварию, когда канал и так под нагрузкой.
    const { d, recorded, errored } = deps({
      workers: async () => { throw new Error('ECONNREFUSED') }
    })
    await runQueueHealthTick(emptyDeliveryState(), d)
    // ⚠ Проверяем ФАКТ тревоги по виду, а не её текст: сверка текста пропускала мутацию, которая
    // поднимала `no-workers` с другой формулировкой прямо внутри `catch`.
    expect(
      recorded[0]?.alerts.some(a => a.kind === 'no-workers'),
      'отказ чтения выдан за отсутствие воркеров'
    ).toBe(false)
    expect(errored.join('\n')).toMatch(/worker liveness/)
  })

  it('отказ чтения воркеров не отменяет уже посчитанный вердикт по очередям', async () => {
    const { d, recorded } = deps({
      pending: { 'crm-sync': [40 * MIN, 40 * MIN, 40 * MIN] },
      workers: async () => { throw new Error('ECONNREFUSED') }
    })
    await runQueueHealthTick(emptyDeliveryState(), d)
    expect(recorded[0]?.alerts.some(a => a.kind === 'stalled'), 'вердикт по очередям потерян').toBe(true)
  })

  it('эпизод не повторяется: на втором тике тревога не шлётся заново', async () => {
    const first = deps({ workers: async () => ({ live: 0, queuesEnabled: true, startedAtMs: T0 - 60 * MIN }) })
    const state = (await runQueueHealthTick(emptyDeliveryState(), first.d)).state
    const second = deps({ workers: async () => ({ live: 0, queuesEnabled: true, startedAtMs: T0 - 60 * MIN }) })
    await runQueueHealthTick(state, second.d)
    expect(second.pushed, 'та же поломка объявлена дважды').toEqual([])
  })

  it('воркеры вернулись ⇒ восстановление объявлено ПО-РУССКИ, а не «workers — восстановлено»', async () => {
    // ⚠ `RECOVERY_SENTENCE` — `Record<string, …>`, поэтому забытый вид не ловится типами и падает
    // в фолбэк, вклеивающий английское имя очереди в русскую фразу.
    const down = deps({ workers: async () => ({ live: 0, queuesEnabled: true, startedAtMs: T0 - 60 * MIN }) })
    const state = (await runQueueHealthTick(emptyDeliveryState(), down.d)).state
    const up = deps({ workers: async () => ({ live: 1, queuesEnabled: true, startedAtMs: T0 - 60 * MIN }) })
    await runQueueHealthTick(state, up.d)
    const text = up.pushed.join('\n')
    expect(text, 'восстановление не объявлено вовсе').toMatch(/✅/)
    expect(text, 'в русскую фразу вклеилось имя очереди').not.toMatch(/\bworkers\b/)
    expect(text, 'ушёл общий фолбэк вместо своей фразы').toMatch(/воркеры снова на связи/)
  })
})
