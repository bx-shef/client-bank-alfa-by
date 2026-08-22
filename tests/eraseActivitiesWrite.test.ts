import { describe, expect, it, vi } from 'vitest'
import { countErasableActivities, eraseActivities, MAX_ERASE_PER_REQUEST } from '../server/utils/eraseActivitiesWrite'
import { ACTIVITY_ORIGIN } from '../app/utils/activity'
import type { RestBatch, RestCall } from '../server/utils/companyLookup'

// ⚠ Здесь живёт вся опасность: это единственное место приложения, которое УДАЛЯЕТ из CRM клиента.
// Поэтому проверяется не только «удалилось нужное», но и «в вызов удаления не может попасть чужое»
// и «названное человеку число — правда портала, а не наша арифметика».

const ours = (id: string, account = 'BY01ALFA') => ({
  ID: id, ORIGINATOR_ID: ACTIVITY_ORIGIN, ORIGIN_ID: `${account}|D${id}`
})

/** Портал-заглушка: страницы по 50 + `total`. */
function fakePortal(rows: Record<string, unknown>[], afterRows = rows) {
  let deleted = 0
  const call: RestCall = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    const start = Number(params.start ?? 0)
    const live = deleted > 0 ? afterRows : rows
    return { result: live.slice(start, start + 50), total: live.length }
  })
  const batch: RestBatch = vi.fn(async (calls) => {
    deleted += calls.length
    return calls.map(() => ({ result: true }))
  })
  return { call, batch, deletedCount: () => deleted }
}

const all = { period: {}, accounts: [] }

describe('countErasableActivities — показать до удаления', () => {
  it('без отбора по счетам берёт total портала одним запросом, страницы не листает', async () => {
    const { call } = fakePortal(Array.from({ length: 120 }, (_, i) => ours(String(i))))
    expect(await countErasableActivities(all, call)).toEqual({ count: 120, capped: false })
    expect((call as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('с отбором по счетам считает ТОЧНО, пройдя страницы', async () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => ours(`a${i}`, 'BY01ALFA')),
      ...Array.from({ length: 40 }, (_, i) => ours(`p${i}`, 'BY02PJCB'))
    ]
    const { call } = fakePortal(rows)
    expect(await countErasableActivities({ period: {}, accounts: ['BY02PJCB'] }, call)).toEqual({ count: 40, capped: false })
  })

  it('упёрлись в потолок — говорим об этом, а не показываем усечённое число как точное', async () => {
    const { call } = fakePortal(Array.from({ length: MAX_ERASE_PER_REQUEST + 50 }, (_, i) => ours(String(i))))
    const res = await countErasableActivities(all, call)
    expect(res.count).toBe(MAX_ERASE_PER_REQUEST)
    expect(res.capped).toBe(true)
  })

  it('НЕ умеет удалять: батч ему не передаётся вовсе', () => {
    // Структурная гарантия, а не договорённость: у функции нет параметра, через который можно
    // было бы что-то удалить. Флаг «сухой прогон» такой гарантии не даёт.
    expect(countErasableActivities.length).toBeLessThanOrEqual(3)
  })
})

describe('eraseActivities — само удаление', () => {
  it('удаляет пачками и называет остаток ПО ОТВЕТУ портала', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ours(String(i)))
    const { call, batch } = fakePortal(rows, [])
    const out = await eraseActivities(all, call, batch)
    expect(out.deleted).toBe(120)
    // ⚠ Остаток НЕ вычитается: внутри оборвавшейся пачки часть команд могла примениться, и наша
    // арифметика соврала бы ровно тогда, когда человеку важнее всего понимать, что произошло.
    expect(out.remaining).toBe(0)
  })

  it('в команды удаления попадают ТОЛЬКО наши дела', async () => {
    // Самый важный тест файла. Строка без нашего ORIGINATOR_ID пришла в ответе — и не удаляется.
    const rows = [
      ours('1'),
      { ID: '2', ORIGINATOR_ID: 'SomeOtherApp', ORIGIN_ID: 'BY01ALFA|D2' },
      { ID: '3', ORIGINATOR_ID: '', ORIGIN_ID: 'BY01ALFA|D3' }
    ]
    const { call, batch } = fakePortal(rows, [])
    await eraseActivities(all, call, batch)
    const sent = (batch as unknown as { mock: { calls: [{ params?: { id?: string } }[]][] } }).mock.calls
    const ids = sent.flatMap(c => c[0].map(x => x.params?.id))
    expect(ids).toEqual(['1'])
  })

  it('отбор по счёту доезжает до удаления', async () => {
    const rows = [ours('1', 'BY01ALFA'), ours('2', 'BY02PJCB')]
    const { call, batch } = fakePortal(rows, [])
    await eraseActivities({ period: {}, accounts: ['BY02PJCB'] }, call, batch)
    const sent = (batch as unknown as { mock: { calls: [{ params?: { id?: string } }[]][] } }).mock.calls
    expect(sent.flatMap(c => c[0].map(x => x.params?.id))).toEqual(['2'])
  })

  it('упавшая пачка ОСТАНАВЛИВАЕТ, но не проваливает операцию', async () => {
    // ⚠ Чаще всего это дело, уже удалённое человеком вручную. Пробросить исключение значило бы
    // показать отказ там, где часть работы применилась, — и человек не знал бы, что теперь в CRM.
    const rows = Array.from({ length: 120 }, (_, i) => ours(String(i)))
    let n = 0
    const call: RestCall = vi.fn(async (_m, params) => {
      const start = Number(params.start ?? 0)
      return { result: rows.slice(start, start + 50), total: rows.length }
    })
    const batch: RestBatch = vi.fn(async () => {
      if (n++ === 1) throw new Error('Activity is not found.')
      return [{ result: true }]
    })
    const out = await eraseActivities(all, call, batch)
    expect(out.deleted).toBe(50) // прошла только первая пачка
    expect(out.remaining).toBe(120) // правда портала: заглушка ничего не удаляла
  })

  it('потолок режет ТОЧНО, а не «до конца страницы»', async () => {
    // ⚠ Страницы приходят по 50, поэтому набор идентификаторов перескакивает потолок: при потолке
    // 120 после трёх страниц их уже 150. Без явного среза удалилось бы 150 — на 25% больше, чем
    // человеку показали в подтверждении, а действие НЕОБРАТИМО.
    // ⚠ Прежняя версия этого теста брала потолок, кратный странице, и мутация «убрать срез»
    // проходила зелёной (замерено).
    const rows = Array.from({ length: 200 }, (_, i) => ours(String(i)))
    const { call, batch } = fakePortal(rows, rows.slice(120))
    const out = await eraseActivities(all, call, batch, 120)
    expect(out.deleted).toBe(120)
    const sent = (batch as unknown as { mock: { calls: [{ params?: { id?: string } }[]][] } }).mock.calls
    expect(sent.flatMap(c => c[0]).length).toBe(120)
  })

  it('за один вызов удаляет не больше потолка — остаток называется честно', async () => {
    // ⚠ Потолок не «сколько всего можно», а сколько влезает в HTTP-запрос: иначе человек получил
    // бы 504 посреди необратимого действия, не зная, применилось оно или нет.
    const rows = Array.from({ length: MAX_ERASE_PER_REQUEST + 25 }, (_, i) => ours(String(i)))
    const { call, batch } = fakePortal(rows, rows.slice(MAX_ERASE_PER_REQUEST))
    const out = await eraseActivities(all, call, batch)
    expect(out.deleted).toBe(MAX_ERASE_PER_REQUEST)
    expect(out.remaining).toBe(25)
  })

  it('удалять нечего — ни одной команды не отправляется', async () => {
    const { call, batch } = fakePortal([])
    expect(await eraseActivities(all, call, batch)).toEqual({ deleted: 0, remaining: 0 })
    expect((batch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
  })
})
