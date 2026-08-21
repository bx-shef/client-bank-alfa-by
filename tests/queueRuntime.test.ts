import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REQUESTS_PER_ACCOUNT, providerJobRate } from '../server/queue/pollCapacity'
import {
  DEFAULT_FETCH_RATE_DURATION_MS, DEFAULT_PRIOR_CONCURRENCY, DEFAULT_FETCH_RATE_MAX, MAX_CONCURRENCY,
  MAX_FETCH_RATE_MAX, MIN_FETCH_RATE_DURATION_MS, envFlag, queueRuntimeConfig,
  ALFA_DOCUMENTED_RATE_MAX, FETCH_RATE_HEADROOM
} from '../server/queue/runtime'

describe('envFlag', () => {
  it('defaults when unset or blank', () => {
    expect(envFlag(undefined, true)).toBe(true)
    expect(envFlag('', true)).toBe(true)
    expect(envFlag('   ', false)).toBe(false)
  })
  it('treats 0/false/no/off (any case) as false', () => {
    for (const v of ['0', 'false', 'FALSE', 'No', 'off', ' off ']) expect(envFlag(v, true)).toBe(false)
  })
  it('treats anything else as true', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'x']) expect(envFlag(v, false)).toBe(true)
  })
})

// ⚠ С #561 задача Альфы стоит ДВА банковских запроса (выписка + проход по странице), поэтому
// лимитер, который считает ЗАДАЧИ, получает бюджет ЗАПРОСОВ, делённый на стоимость — как у Приора.
// Бюджет банка при этом НЕ меняется: вдвое меньше задач по вдвое большей цене это те же запросы.
// Ожидания ниже считаются тем же хелпером, что и продовый код: захардкоженное число разъехалось бы
// с моделью стоимости молча, а именно её незаметный сдвиг и порождает перерасход лимита банка.
const alfaJobs = (requests: number) => providerJobRate(requests, REQUESTS_PER_ACCOUNT['alfa-by'] ?? 1)

describe('queueRuntimeConfig', () => {
  it('defaults to a single-container role (workers + cron, concurrency 1, 40 jobs/60s fetch rate)', () => {
    expect(queueRuntimeConfig({})).toEqual({
      workers: true,
      cron: true,
      concurrency: 1,
      fetchRate: { max: alfaJobs(DEFAULT_FETCH_RATE_MAX), duration: DEFAULT_FETCH_RATE_DURATION_MS },
      // Prior's limiter is in JOBS: its 100-request budget ÷ ~10 requests per job = 10 jobs/min.
      priorFetchRate: { max: 10, duration: DEFAULT_FETCH_RATE_DURATION_MS },
      priorConcurrency: DEFAULT_PRIOR_CONCURRENCY
    })
  })

  it('sizes the Alfa limiter in JOBS too — 80 requests ÷ 2 per job = 40', () => {
    // ⚠ Один якорь РУКОПИСНЫМ числом, а не только через `alfaJobs`. Формула проверяет проводку, но
    // читателю нужно значение, которое реально уедет в лимитер, — и сосед по этому файлу
    // (`priorFetchRate`, 200÷10=20) держит его именно так. Разъедется модель — здесь станет красным.
    expect(queueRuntimeConfig({}).fetchRate.max).toBe(40)
    expect(DEFAULT_FETCH_RATE_MAX).toBe(80)
    expect(REQUESTS_PER_ACCOUNT['alfa-by']).toBe(2)
  })

  it('sizes the Prior limiter in JOBS from its REQUEST budget (per-request accounting)', () => {
    // 200 requests/min ÷ ~10 per Prior job = 20 jobs/min — NOT 200, which would overspend ~10×.
    expect(queueRuntimeConfig({ QUEUE_PRIOR_RATE_MAX: '200' }).priorFetchRate.max).toBe(20)
    // Garbage/non-positive falls back to the default budget (never disables the cap).
    expect(queueRuntimeConfig({ QUEUE_PRIOR_RATE_MAX: '0' }).priorFetchRate.max)
      .toBe(queueRuntimeConfig({}).priorFetchRate.max)
    expect(queueRuntimeConfig({ QUEUE_PRIOR_RATE_MAX: 'nope' }).priorFetchRate.max)
      .toBe(queueRuntimeConfig({}).priorFetchRate.max)
  })

  it('Prior has its OWN concurrency knob (its jobs hold a slot for minutes)', () => {
    expect(queueRuntimeConfig({ QUEUE_PRIOR_CONCURRENCY: '8' }).priorConcurrency).toBe(8)
    // Independent of the shared QUEUE_CONCURRENCY.
    expect(queueRuntimeConfig({ QUEUE_CONCURRENCY: '3' }).priorConcurrency).toBe(DEFAULT_PRIOR_CONCURRENCY)
  })

  it('parses QUEUE_FETCH_RATE_* and falls back to defaults on garbage/non-positive (never disables)', () => {
    expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_MAX: '40', QUEUE_FETCH_RATE_DURATION_MS: '30000' }).fetchRate)
      .toEqual({ max: alfaJobs(40), duration: 30_000 })
    // A 0/negative/garbage value must NOT disable the cap — fall back to the default.
    for (const v of ['0', '-5', 'abc', '']) {
      expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_MAX: v }).fetchRate.max).toBe(alfaJobs(DEFAULT_FETCH_RATE_MAX))
      expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_DURATION_MS: v }).fetchRate.duration).toBe(DEFAULT_FETCH_RATE_DURATION_MS)
    }
  })

  it('clamps the UPPER edges so a fat-fingered value cannot effectively disable the cap', () => {
    // Huge max → clamped to MAX_FETCH_RATE_MAX (else 999999/min ≈ no cap).
    expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_MAX: '999999' }).fetchRate.max).toBe(alfaJobs(MAX_FETCH_RATE_MAX))
    // Tiny duration → floored to MIN_FETCH_RATE_DURATION_MS (else a 1ms window ≈ no cap).
    expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_DURATION_MS: '1' }).fetchRate.duration).toBe(MIN_FETCH_RATE_DURATION_MS)
    // A sane override within bounds is preserved.
    expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_MAX: '250', QUEUE_FETCH_RATE_DURATION_MS: '30000' }).fetchRate)
      .toEqual({ max: alfaJobs(250), duration: 30_000 })
  })

  it('parseInt leniency: trailing garbage keeps the leading number (still a positive cap)', () => {
    // Consistent with clampConcurrency's idiom; safe because it yields a positive cap, never 0/disabled.
    expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_MAX: '100abc' }).fetchRate.max).toBe(alfaJobs(100))
  })

  it('HTTP/primary role: QUEUE_WORKERS=0 disables workers, cron stays', () => {
    expect(queueRuntimeConfig({ QUEUE_WORKERS: '0' })).toMatchObject({ workers: false, cron: true })
  })

  it('worker role: QUEUE_CRON=0 disables the scheduler, workers stay', () => {
    expect(queueRuntimeConfig({ QUEUE_CRON: '0' })).toMatchObject({ workers: true, cron: false })
  })

  it('parses and clamps QUEUE_CONCURRENCY', () => {
    expect(queueRuntimeConfig({ QUEUE_CONCURRENCY: '5' }).concurrency).toBe(5)
    expect(queueRuntimeConfig({ QUEUE_CONCURRENCY: String(MAX_CONCURRENCY + 500) }).concurrency).toBe(MAX_CONCURRENCY)
    // Non-positive / garbage / empty → floor of 1 (never 0, which BullMQ would reject).
    for (const v of ['0', '-3', 'abc', '']) expect(queueRuntimeConfig({ QUEUE_CONCURRENCY: v }).concurrency).toBe(1)
  })
})

describe('лимит обращений к Альфе держит запас (замечание владельца, 2026-08-20)', () => {
  it('дефолт НИЖЕ документированного потолка банка', () => {
    // ⚠ Раньше дефолт стоял РОВНО на 100 — на самой границе, без запаса. Сторона не та: наш
    // лимитер считает то, что мы СТАВИМ В ОЧЕРЕДЬ, а банк — то, что ПОЛУЧАЕТ, и совпадают эти два
    // счёта никогда: ретрай после сетевого блипа, опрос на краю окна лимитера, расхождение часов
    // между репликами. Стоя на границе, первое же такое расхождение — это 429, а 429 на выписке
    // читается оператором как «банк лежит», а не как «мы спросили на чуть-чуть чаще».
    expect(DEFAULT_FETCH_RATE_MAX).toBeLessThan(ALFA_DOCUMENTED_RATE_MAX)
    expect(DEFAULT_FETCH_RATE_MAX).toBe(80)
  })

  it('запас задан долей, а не переписанным числом', () => {
    // Чтобы документированный потолок банка и наша осторожность не слиплись в одну константу: когда
    // банк объявит другой лимит, менять надо ровно одно число, а доля останется долей.
    expect(FETCH_RATE_HEADROOM).toBeGreaterThan(0)
    expect(FETCH_RATE_HEADROOM).toBeLessThan(1)
    // ⚠ Сравнение ЗНАЧЕНИЙ этого не доказывает, и мутационное ревью показало прямо: литерал `80`
    // или формула `ALFA_DOCUMENTED_RATE_MAX - 20` дают то же число и проходят. Тест при этом
    // ЗАЯВЛЯЕТ, что проверяет связь, — то есть создаёт уверенность, которой не даёт. Связь живёт
    // в тексте исходника, там её и сверяем.
    const src = readFileSync(join(import.meta.dirname, '..', 'server/queue/runtime.ts'), 'utf8')
    expect(src, 'дефолт больше не выражен через потолок и долю')
      .toMatch(/DEFAULT_FETCH_RATE_MAX = ALFA_DOCUMENTED_RATE_MAX \* FETCH_RATE_HEADROOM/)
    expect(DEFAULT_FETCH_RATE_MAX).toBe(ALFA_DOCUMENTED_RATE_MAX * FETCH_RATE_HEADROOM)
  })

  it('дефолт — ЦЕЛОЕ число: BullMQ получает его как есть', () => {
    // ⚠ 100 × 0.8 = 80 ровно, но это свойство КОНКРЕТНОЙ доли, а не приёма: 100 × 0.55 даёт
    // 55.00000000000001. Дробный `max` воркер не уронит (сравнение в Lua-скрипте лимитера обычное),
    // но эффективный потолок молча скруглится, и объяснить расхождение будет нечем.
    expect(Number.isInteger(DEFAULT_FETCH_RATE_MAX)).toBe(true)
  })

  it('дефолт НЕ упоминается устаревшим числом в комментариях кода', () => {
    // ⚠ Обе рецензии нашли одно и то же: «Default 100/60s» осталось в четырёх местах, включая тот
    // же файл, где двадцатью строками ниже честно написано про 80. Разошедшийся дубль опаснее
    // отсутствующего описания — это прямое правило проекта.
    for (const rel of ['server/queue/runtime.ts', 'server/queue/worker.ts', 'server/queue/saturation.ts']) {
      const src = readFileSync(join(import.meta.dirname, '..', rel), 'utf8')
      expect(src, `${rel}: остался старый дефолт 100/60s`).not.toMatch(/default 100\/60s/i)
    }
  })

  it('запас нельзя обойти опечаткой в env', () => {
    // Клампы существуют ровно для этого — потолок не выключается кривым значением. Проверяем через
    // публичный вход, а не внутреннюю функцию: оператор задаёт именно переменную окружения.
    const at = (v: string | undefined) => queueRuntimeConfig({ QUEUE_FETCH_RATE_MAX: v } as NodeJS.ProcessEnv).fetchRate.max
    // ⚠ Потолок и дефолт заданы в ЗАПРОСАХ, а `fetchRate.max` — в ЗАДАЧАХ (#561), поэтому сравнение
    // идёт через ту же модель стоимости, что у продового кода. Сырое число здесь означало бы, что
    // тест закрепляет одну модель, а лимитер живёт по другой.
    expect(at('999999')).toBeLessThanOrEqual(alfaJobs(MAX_FETCH_RATE_MAX))
    expect(at('0')).toBe(alfaJobs(DEFAULT_FETCH_RATE_MAX))
    expect(at('мусор')).toBe(alfaJobs(DEFAULT_FETCH_RATE_MAX))
    expect(at(undefined)).toBe(alfaJobs(DEFAULT_FETCH_RATE_MAX))
    // ⚠ Поднять ВЫШЕ документированного потолка по-прежнему можно осознанно (у банка бывает
    // другой тариф) — запрещать это здесь значило бы решать за владельца договора.
    expect(at('100')).toBe(alfaJobs(100))
  })
})
