import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

describe('проводка (#466)', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

  it('идентификатор пульса УНИКАЛЕН на процесс, а не производен от pid/hostname', () => {
    // ⚠ Реплики одного образа живут каждая в своём PID-неймспейсе, поэтому `process.pid` у них
    // совпадает БУКВАЛЬНО, а `HOSTNAME` docker проставляет неявно (гард паритета env на него
    // ругается — и справедливо). Совпавшие ключи схлопнули бы N живых воркеров в один и спрятали
    // смерть остальных, то есть сломали бы ровно то, ради чего пульс заведён.
    const src = read('server/plugins/queue.ts')
    const line = src.split('\n').find(l => l.includes('const beatId'))
    expect(line, 'пульс воркера не заводится').toBeTruthy()
    expect(line!, 'id пульса выводится из pid/hostname — реплики схлопнутся')
      .not.toMatch(/process\.pid|process\.env/)
    expect(line!, 'id пульса не случайный').toMatch(/randomUUID|randomBytes/)
  })

  it('сбой пульса НЕ роняет обработку задач', () => {
    // Пульс — диагностика. Уронив ею воркер, мы бы своими руками устроили ту аварию, которую он
    // призван замечать.
    const src = read('server/plugins/queue.ts')
    const i = src.indexOf('const beat = ()')
    expect(i, 'пульс не заводится').toBeGreaterThan(-1)
    expect(src.slice(i, i + 400), 'у пульса нет catch — он может уронить воркер').toContain('.catch(')
  })

  it('счётчик живых изолирован в тике — отказ Redis не отменяет вердикт по конвейеру', () => {
    // ⚠ И, что важнее, при недоступном Redis «ноль живых» — это НЕЗНАНИЕ, а не факт. Без изоляции
    // проверка здоровья сама бы порождала ложную тревогу ровно в аварию.
    const src = read('server/utils/queueHealthTick.ts')
    const i = src.indexOf('if (deps.workers)')
    expect(i, 'проводки счётчика воркеров нет').toBeGreaterThan(-1)
    expect(src.slice(i, i + 300)).toContain('catch')
  })

  it('SCAN, а не KEYS — проверка обязана быть дешевле проверяемого', () => {
    const src = read('server/queue/connection.ts')
    const i = src.indexOf('export async function countLiveWorkers')
    expect(i).toBeGreaterThan(-1)
    const body = src.slice(i, i + 700)
    expect(body).toContain('scan(')
    expect(body, 'KEYS блокирует Redis целиком').not.toMatch(/\bkeys\(/)
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
