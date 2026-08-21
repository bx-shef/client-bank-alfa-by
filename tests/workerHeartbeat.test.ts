import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { alertChannelState, recordAlertChannelConfigured, recordAlertDelivery, resetQueueAlertState } from '../server/utils/queueAlertState'
import {
  evaluateWorkerLiveness, workerBeatKey,
  WORKER_BEAT_INTERVAL_MS, WORKER_BEAT_PREFIX, WORKER_BEAT_TTL_SEC
} from '../app/utils/workerHeartbeat'
import { presentAlertChannel } from '../app/utils/queueHealthView'

// #466 §1. Все правила здоровья очередей выведены из НАЛИЧИЯ застрявшей работы, поэтому мёртвый
// воркер на тихом портале выглядел здоровым, а `/queues` показывал зелёное. Пульс закрывает
// единственный случай, который нельзя вывести из содержимого очередей.

describe('evaluateWorkerLiveness', () => {
  it('ноль живых при включённых очередях — тревога', () => {
    const a = evaluateWorkerLiveness({ live: 0, queuesEnabled: true })
    expect(a?.kind).toBe('no-workers')
    expect(a?.text, 'текст не говорит о последствии').toMatch(/копятся|стоят/)
  })

  it('хотя бы один живой — молчим', () => {
    expect(evaluateWorkerLiveness({ live: 1, queuesEnabled: true })).toBeNull()
  })

  it('очереди выключены — молчим ПО ФАКТУ выключенности, а не потому что счётчик ноль', () => {
    // ⚠ Без Redis воркеров нет по построению, а события Б24 идут синхронным фолбэком. Кричать
    // «нет воркеров» на такой конфигурации значит приучить не читать канал.
    expect(evaluateWorkerLiveness({ live: 0, queuesEnabled: false })).toBeNull()
  })
})

describe('каденция пульса', () => {
  it('TTL заметно длиннее интервала — пропущенный удар не хоронит живой воркер', () => {
    // ⚠ Цена ложной тревоги здесь выше цены задержки: проверка идёт раз в тик здоровья, а не
    // непрерывно, поэтому запас нужен, чтобы пауза GC или сетевой блип не объявляли воркер мёртвым.
    expect(WORKER_BEAT_TTL_SEC * 1000).toBeGreaterThanOrEqual(WORKER_BEAT_INTERVAL_MS * 2)
  })

  it('ключ несёт префикс — иначе SCAN подберёт чужое', () => {
    expect(workerBeatKey('w1')).toBe(`${WORKER_BEAT_PREFIX}w1`)
  })
})

describe('состояние канала: два писателя одного объекта (#466 §3)', () => {
  // ⚠ ПОВЕДЕНЧЕСКИЙ тест, а не греп. Ревью мутацией доказало, что перетирание `configured` в
  // `recordAlertDelivery` не ловилось ничем: инвариант «два писателя, каждый не задевает чужое
  // поле» нетривиален и мутирует незаметно при рефакторинге.
  it('запись доставки НЕ перетирает признак «канал настроен»', () => {
    resetQueueAlertState()
    recordAlertChannelConfigured(true)
    recordAlertDelivery(false, 123)
    const st = alertChannelState()
    expect(st.configured, 'запись доставки стёрла факт настройки канала').toBe(true)
    expect(st.lastOk).toBe(false)
    expect(st.lastAtMs).toBe(123)
  })

  it('и наоборот: повторная запись «настроен» не стирает исход доставки', () => {
    resetQueueAlertState()
    recordAlertDelivery(true, 7)
    recordAlertChannelConfigured(true)
    expect(alertChannelState().lastOk, 'исход доставки потерян').toBe(true)
  })

  it('состояние копируется наружу — вызывающий не может переписать хранимое', () => {
    resetQueueAlertState()
    recordAlertChannelConfigured(true)
    const st = alertChannelState()
    st.configured = false
    expect(alertChannelState().configured).toBe(true)
  })
})

describe('канал оповещений говорит о себе (#466 §3)', () => {
  it('выключён и «включён, но не доходит» — РАЗНЫЕ строки, а не общая тишина', () => {
    const off = presentAlertChannel({ configured: false, lastOk: null, lastAtMs: null })
    const broken = presentAlertChannel({ configured: true, lastOk: false, lastAtMs: 1 })
    const ok = presentAlertChannel({ configured: true, lastOk: true, lastAtMs: 1 })
    expect(new Set([off.tone, broken.tone, ok.tone]).size, 'три состояния схлопнулись').toBe(3)
    expect(off.note).toMatch(/выключены/)
    expect(broken.note).toMatch(/НЕ прошла/)
  })

  it('нет данных вовсе — считаем выключённым, а не исправным', () => {
    // Fail-safe: «не знаем» про сигнализацию обязано читаться как «на неё не рассчитывай».
    expect(presentAlertChannel(null).tone).toBe('off')
    expect(presentAlertChannel(undefined).tone).toBe('off')
  })

  it('включён, но отправлять было нечего — это НЕ поломка', () => {
    expect(presentAlertChannel({ configured: true, lastOk: null, lastAtMs: null }).tone).toBe('ok')
  })
})

describe('виды тревог на экране совпадают с видами в правилах', () => {
  it('union экрана не отстаёт от QueueAlertKind', () => {
    // ⚠ Список уже расходился: у экрана не было ни `bank-dead`, ни `keepalive-stale`, хотя API их
    // отдавал — тип молча описывал не то, что приходит. Второй раз это должно падать.
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')
    const kinds = (src: string, marker: string) => {
      const line = src.split('\n').find(l => l.includes(marker))
      return new Set([...(line ?? '').matchAll(/'([a-z-]+)'/g)].map(m => m[1]!))
    }
    const rules = kinds(read('server/utils/queueAlert.ts'), 'export type QueueAlertKind')
    const view = kinds(read('app/utils/queueHealthView.ts'), 'kind: \'stalled\'')
    expect(rules.size).toBeGreaterThan(3)
    expect([...rules].filter(k => !view.has(k)), 'экран не знает про эти виды тревог').toEqual([])
  })
})
