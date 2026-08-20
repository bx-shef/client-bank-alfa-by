import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Гард проводки продления банковских токенов (#489).
//
// ⚠ Мутационная проверка показала, что этот кусок не защищён НИЧЕМ: удаление вызова из плагина
// оставляет весь набор зелёным. А это ровно то место, из-за которого подключения умирали —
// продление стояло ПОСЛЕ `if (!queueEnabled()) return`, то есть простой Redis уносил с собой
// банковские подключения, хотя банку до нашей очереди дела нет.
//
// Юнит-тестом плагин не покрыть (Nitro-хуки, живые транспорты), поэтому сверяется исходник.

const ROOT = join(import.meta.dirname, '..')
const PLUGIN = readFileSync(join(ROOT, 'server/plugins/queue.ts'), 'utf8')
const SCHEDULE = readFileSync(join(ROOT, 'server/utils/bankKeepAliveSchedule.ts'), 'utf8')

describe('продление банк-токенов не зависит от очереди (#489)', () => {
  it('исходники читаются и содержат обе точки', () => {
    expect(PLUGIN).toContain('queueEnabled()')
    expect(PLUGIN).toContain('scheduleBankKeepAlive')
  })

  it('заводится ДО гейта Redis, а не после', () => {
    // ⚠ Суть issue. Продлению нужны Postgres и банк; очередь не нужна вовсе. Любой простой Redis
    // не должен стоить владельцу счёта похода в интернет-банк.
    const scheduleAt = PLUGIN.indexOf('scheduleBankKeepAlive(')
    const gateAt = PLUGIN.indexOf('if (!queueEnabled())')
    expect(scheduleAt).toBeGreaterThan(-1)
    expect(gateAt).toBeGreaterThan(-1)
    expect(scheduleAt, 'продление снова под гейтом Redis').toBeLessThan(gateAt)
  })

  it('и НЕ гейтится флагом опроса выписки', () => {
    // ⚠ `CRON_REAL_POLL` существует, чтобы не долбить API выписки. Обновление токена выписку не
    // читает и её бюджет не тратит. Связать одно с другим — значит убивать подключение каждый раз,
    // когда опрос ставят на паузу; именно это и происходило.
    // ⚠ Смотрим САМ БЛОК планирования, а не всё до гейта: выше лежат импорты и шапка файла, где
    // флаг упоминается прозой. Тест, спотыкающийся о комментарий, заставляет править не то.
    const from = PLUGIN.indexOf('const role = queueRuntimeConfig()')
    const to = PLUGIN.indexOf('if (!queueEnabled())')
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    expect(PLUGIN.slice(from, to), 'планирование продления гейтится флагом опроса').not.toMatch(/CRON_REAL_POLL[^`\n]*\)/)
    expect(SCHEDULE, 'модуль планирования смотрит на флаг опроса').not.toMatch(/CRON_REAL_POLL/)
  })

  it('первый прогон — немедленный, а не через интервал', () => {
    // Сервис мог простоять ночь, и подключение за это время как раз доживает. Ждать ещё час после
    // старта — гарантированно опоздать в самом частом сценарии.
    const setIntervalAt = SCHEDULE.indexOf('setInterval(tick')
    const immediateAt = SCHEDULE.indexOf('void tick()')
    expect(setIntervalAt).toBeGreaterThan(-1)
    expect(immediateAt).toBeGreaterThan(setIntervalAt)
  })

  it('обновление ПРИНУДИТЕЛЬНОЕ и попытка отмечается', () => {
    // ⚠ Без `force` смотрели бы на срок ACCESS-токена — не тот сигнал: access бывает свежим, пока
    // refresh за ним доживает последние часы. Без `markAttempt` редкие повторы просроченных
    // подключений превращаются в повторы на каждом тике.
    expect(SCHEDULE).toContain('force: true')
    expect(SCHEDULE).toContain('markAttempt')
  })

  it('оператор узнаёт, что очереди выключены, а продление — нет', () => {
    // Иначе «Redis не настроен» читается как «ничего не работает», и владелец идёт чинить не то.
    expect(PLUGIN).toMatch(/продление банк-токенов работает независимо/)
  })
})
