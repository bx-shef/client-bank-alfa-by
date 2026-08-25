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

const all = { period: {}, accounts: [], counterpartyAccounts: [] }

describe('countErasableActivities — показать до удаления', () => {
  it('перепроверяет метку в ОТВЕТЕ даже без отбора по счетам', async () => {
    // ⚠ Прежняя версия здесь возвращала сырой `total` портала, не заглянув в строки, — и подсчёт
    // считался ОДНИМ правилом, а стирание шло по ДРУГОМУ. Человек увидел бы «удалено 287 из 300»
    // на необратимом действии и не понял бы, что произошло (находка ревью).
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => ours(String(i))),
      { ID: '900', ORIGINATOR_ID: 'SomeOtherApp', ORIGIN_ID: 'BY01ALFA|D900' },
      { ID: '', ORIGINATOR_ID: ACTIVITY_ORIGIN, ORIGIN_ID: 'BY01ALFA|D901' }
    ]
    const { call } = fakePortal(rows)
    expect(await countErasableActivities(all, call)).toEqual({ count: 10, capped: false })
  })

  it('подсчёт и стирание дают ОДНО И ТО ЖЕ число', async () => {
    // Инвариант, ради которого подсчёт и был приведён к общему правилу: обещанное в подтверждении
    // обязано совпасть с удалённым.
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => ours(String(i))),
      { ID: '900', ORIGINATOR_ID: 'SomeOtherApp', ORIGIN_ID: 'BY01ALFA|D900' }
    ]
    const counted = await countErasableActivities(all, fakePortal(rows).call)
    const { call, batch } = fakePortal(rows, [rows[30]!])
    const erased = await eraseActivities(all, call, batch)
    expect(erased.deleted).toBe(counted.count)
  })

  it('с отбором по счетам считает ТОЧНО, пройдя страницы', async () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => ours(`a${i}`, 'BY01ALFA')),
      ...Array.from({ length: 40 }, (_, i) => ours(`p${i}`, 'BY02PJCB'))
    ]
    const { call } = fakePortal(rows)
    expect(await countErasableActivities({ period: {}, accounts: ['BY02PJCB'], counterpartyAccounts: [] }, call)).toEqual({ count: 40, capped: false })
  })

  it('упёрлись в потолок — говорим об этом, а не показываем усечённое число как точное', async () => {
    const { call } = fakePortal(Array.from({ length: MAX_ERASE_PER_REQUEST + 50 }, (_, i) => ours(String(i))))
    const res = await countErasableActivities(all, call)
    expect(res.count).toBe(MAX_ERASE_PER_REQUEST)
    expect(res.capped).toBe(true)
  })

  it('потолок достигнут, а страницы ещё остались — честно «и более»', async () => {
    // ⚠ Ветка `start < total` не проверялась ничем: её удаление проходило зелёным. А это ровно тот
    // случай, ради которого фича и делается — дел больше, чем стирается за раз.
    const rows = Array.from({ length: 200 }, (_, i) => ours(String(i)))
    const { call } = fakePortal(rows)
    expect(await countErasableActivities(all, call, 60)).toEqual({ count: 60, capped: true })
  })

  it('ровно потолок и страницы кончились — «и более» НЕТ', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ours(String(i)))
    const { call } = fakePortal(rows)
    expect(await countErasableActivities(all, call, 100)).toEqual({ count: 100, capped: false })
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
    await eraseActivities({ period: {}, accounts: ['BY02PJCB'], counterpartyAccounts: [] }, call, batch)
    const sent = (batch as unknown as { mock: { calls: [{ params?: { id?: string } }[]][] } }).mock.calls
    expect(sent.flatMap(c => c[0].map(x => x.params?.id))).toEqual(['2'])
  })

  it('фильтр по счёту контрагента (#591): DESCRIPTION запрашивается и решает удаление', async () => {
    const withCp = (id: string, cp: string) => ({
      ID: id, ORIGINATOR_ID: ACTIVITY_ORIGIN, ORIGIN_ID: `BY01ALFA|D${id}`,
      DESCRIPTION: `[B]Приход:[/B] 100 BYN\n[B]Счёт:[/B] ${cp}`
    })
    const rows = [withCp('1', 'BY99PAYER0001'), withCp('2', 'BY88OTHER0002')]
    const { call, batch } = fakePortal(rows, [])
    const selection = { period: {}, accounts: [], counterpartyAccounts: ['BY99PAYER0001'] }
    await eraseActivities(selection, call, batch)
    const sent = (batch as unknown as { mock: { calls: [{ params?: { id?: string } }[]][] } }).mock.calls
    expect(sent.flatMap(c => c[0].map(x => x.params?.id))).toEqual(['1'])
    // ⚠ DESCRIPTION обязано быть в select — иначе счёт контрагента прочитать неоткуда, и фильтр
    // молча совпал бы с пустой строкой (не удалил бы ничего).
    const listParams = (call as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls[0]![1]
    expect(listParams.select).toContain('DESCRIPTION')
  })

  it('без фильтра по контрагенту DESCRIPTION НЕ запрашивается (общий путь лёгкий)', async () => {
    const { call, batch } = fakePortal([ours('1')], [])
    await eraseActivities({ period: {}, accounts: [], counterpartyAccounts: [] }, call, batch)
    const listParams = (call as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls[0]![1]
    expect(listParams.select).not.toContain('DESCRIPTION')
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
