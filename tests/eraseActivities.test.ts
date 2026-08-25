import { describe, expect, it } from 'vitest'
import {
  accountOfOrigin,
  buildEraseListFilter,
  counterpartyAccountOf,
  isCalendarDay,
  parsePeriod,
  periodLabel,
  selectDeletable,
  type ActivityRow
} from '~/utils/eraseActivities'
import { buildActivityDescription } from '~/utils/todoActivity'
import type { StatementItem } from '~/types/statement'
import { ACTIVITY_ORIGIN } from '~/utils/activity'

// ⚠ Действие НЕОБРАТИМО, поэтому здесь проверяется в первую очередь не «удалилось ли нужное», а
// «не может ли удалиться чужое». Ошибка в одну сторону — остался мусор, в другую — снесённые
// звонки и встречи сотрудников клиента, которых никто не восстановит.

const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  id: '1',
  originatorId: ACTIVITY_ORIGIN,
  originId: 'BY01ALFA|D1',
  description: '',
  ...over
})

describe('parsePeriod — все четыре формы периода (просьба владельца)', () => {
  it('пусто = «за всё время»', () => {
    expect(parsePeriod({})).toEqual({})
    expect(parsePeriod({ from: '', to: '' })).toEqual({})
  })

  it('только «от», только «до», и обе границы', () => {
    expect(parsePeriod({ from: '2026-08-01' })).toEqual({ from: '2026-08-01' })
    expect(parsePeriod({ to: '2026-08-31' })).toEqual({ to: '2026-08-31' })
    expect(parsePeriod({ from: '2026-08-01', to: '2026-08-31' })).toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('кривая дата — ОТКАЗ, а не «сотрём всё»', () => {
    // ⚠ Несущее. Пустой период означает «все дела», поэтому опечатка, молча превращённая в
    // пустоту, РАСШИРИЛА бы стирание вместо того, чтобы его сузить.
    expect(parsePeriod({ from: '01.08.2026' })).toBeNull()
    expect(parsePeriod({ to: '2026-8-1' })).toBeNull()
    expect(parsePeriod({ from: 'вчера' })).toBeNull()
    expect(parsePeriod({ from: 42 })).toBeNull()
  })

  it('перевёрнутый период — тоже отказ', () => {
    // «Удалили 0 дел» человек прочитает как «нечего было удалять», хотя он опечатался в дате.
    expect(parsePeriod({ from: '2026-08-31', to: '2026-08-01' })).toBeNull()
    // Совпадающие границы — законный однодневный период, не отказ.
    expect(parsePeriod({ from: '2026-08-05', to: '2026-08-05' })).toEqual({ from: '2026-08-05', to: '2026-08-05' })
  })

  it('isCalendarDay не принимает момент времени', () => {
    expect(isCalendarDay('2026-08-05')).toBe(true)
    expect(isCalendarDay('2026-08-05T10:00:00')).toBe(false)
  })
})

describe('buildEraseListFilter — граница «только наши дела»', () => {
  it('ORIGINATOR_ID стоит ВСЕГДА, даже при пустом периоде', () => {
    // ⚠ Без него список вернул бы ВСЕ дела портала — звонки, встречи, задачи сотрудников, — и
    // «стереть всё за всё время» снесло бы CRM клиента.
    expect(buildEraseListFilter({})).toEqual({ ORIGINATOR_ID: ACTIVITY_ORIGIN })
  })

  it('период уходит границами по DEADLINE — там лежит дата ОПЕРАЦИИ', () => {
    expect(buildEraseListFilter({ from: '2026-08-01', to: '2026-08-31' })).toEqual({
      'ORIGINATOR_ID': ACTIVITY_ORIGIN,
      '>=DEADLINE': '2026-08-01T00:00:00',
      '<=DEADLINE': '2026-08-31T23:59:59'
    })
  })

  it('«до» включает весь последний день, а не его полночь', () => {
    // Иначе «по 31 августа» не стёрло бы ни одной операции 31 августа — самый частый случай.
    expect(buildEraseListFilter({ to: '2026-08-31' })['<=DEADLINE']).toBe('2026-08-31T23:59:59')
  })
})

describe('selectDeletable — вторая граница безопасности', () => {
  it('строка БЕЗ нашего ORIGINATOR_ID не удаляется, даже если пришла в ответе', () => {
    // ⚠ Это не дубль фильтра. Фильтр — наш код; здесь смотрим на то, что ОТВЕТИЛ портал. Ошибка в
    // сборке фильтра тогда даёт пустой результат, а не удаление чужих дел.
    const rows = [row(), row({ id: '2', originatorId: 'SomeOtherApp' }), row({ id: '3', originatorId: '' })]
    expect(selectDeletable(rows, { period: {}, accounts: [], counterpartyAccounts: [] }).map(r => r.id)).toEqual(['1'])
  })

  it('пустой список счетов = по всем нашим счетам', () => {
    const rows = [row({ id: '1', originId: 'BY01ALFA|D1' }), row({ id: '2', originId: 'BY02PJCB|D2' })]
    expect(selectDeletable(rows, { period: {}, accounts: [], counterpartyAccounts: [] })).toHaveLength(2)
  })

  it('счёт сравнивается ТОЧНО, а не «содержит»', () => {
    // ⚠ Ради этого отбор и делается у нас, а не подстрочным фильтром B24: подстрока совпала бы с
    // счётом, оказавшимся ВНУТРИ чужого идентификатора, и удалила бы не то. Для необратимого
    // действия это неприемлемо.
    const rows = [
      row({ id: '1', originId: 'BY01ALFA|D1' }),
      row({ id: '2', originId: 'XXBY01ALFA|D2' }),
      row({ id: '3', originId: 'BY01ALFA0001|D3' })
    ]
    expect(selectDeletable(rows, { period: {}, accounts: ['BY01ALFA'], counterpartyAccounts: [] }).map(r => r.id)).toEqual(['1'])
  })

  it('маркер без разделителя не даёт счёта — и под фильтр по счёту не попадает', () => {
    expect(accountOfOrigin('BY01ALFA|D1')).toBe('BY01ALFA')
    expect(accountOfOrigin('|D1')).toBe('')
    expect(accountOfOrigin('нетразделителя')).toBe('')
    const rows = [row({ id: '9', originId: 'нетразделителя' })]
    expect(selectDeletable(rows, { period: {}, accounts: ['BY01ALFA'], counterpartyAccounts: [] })).toEqual([])
    // Но под «все счета» попадает: это наше дело, просто маркер старой/иной формы.
    expect(selectDeletable(rows, { period: {}, accounts: [], counterpartyAccounts: [] })).toHaveLength(1)
  })

  it('пустая строка в списке счетов не превращает отбор во «все»', () => {
    // Пустое поле ввода не должно молча расширять стирание.
    const rows = [row({ id: '1', originId: 'BY01ALFA|D1' }), row({ id: '2', originId: 'BY02PJCB|D2' })]
    expect(selectDeletable(rows, { period: {}, accounts: ['', 'BY02PJCB'], counterpartyAccounts: [] }).map(r => r.id)).toEqual(['2'])
  })

  it('строка без id не удаляется — удалять нечего, а вызов ушёл бы с пустым параметром', () => {
    expect(selectDeletable([row({ id: '' })], { period: {}, accounts: [], counterpartyAccounts: [] })).toEqual([])
  })
})

describe('фильтр по счёту контрагента (#591)', () => {
  const item = (over: Partial<StatementItem> = {}): StatementItem => ({
    account: 'BY01ALFA', docId: 'D1', direction: 'credit', amount: 100, currency: 'BYN',
    purpose: 'оплата', acceptDate: '2026-08-05',
    counterparty: { name: 'ООО Ромашка', unp: '191', account: 'BY99PAYER0001', bank: '', bic: '' },
    ...over
  })

  it('counterpartyAccountOf достаёт счёт из строки описания', () => {
    const desc = buildActivityDescription(item())
    expect(counterpartyAccountOf(desc)).toBe('BY99PAYER0001')
  })

  it('нет строки счёта в описании (банк не сообщил) → пустая строка', () => {
    const desc = buildActivityDescription(item({ counterparty: { name: 'Физлицо', unp: '', account: '', bank: '' } }))
    expect(counterpartyAccountOf(desc)).toBe('')
  })

  it('метка [B]Счёт:[/B] неподделываема — плательщик не подсунет чужой счёт через имя', () => {
    // Имя плательщика прогоняется через neutralizeBb: его ASCII-скобки станут полноширинными,
    // поэтому вписанное в имя «[B]Счёт:[/B] CHUJOY» не создаст второй метки нашего формата.
    const desc = buildActivityDescription(item({
      counterparty: { name: '[B]Счёт:[/B] CHUJOY', unp: '', account: 'BY99PAYER0001', bank: '' }
    }))
    expect(counterpartyAccountOf(desc)).toBe('BY99PAYER0001')
  })

  it('стирает только дела с точно совпавшим счётом контрагента', () => {
    const rows = [
      row({ id: '1', description: buildActivityDescription(item({ counterparty: { name: 'A', unp: '', account: 'BY99PAYER0001', bank: '' } })) }),
      row({ id: '2', description: buildActivityDescription(item({ counterparty: { name: 'B', unp: '', account: 'BY88OTHER0002', bank: '' } })) })
    ]
    const got = selectDeletable(rows, { period: {}, accounts: [], counterpartyAccounts: ['BY99PAYER0001'] })
    expect(got.map(r => r.id)).toEqual(['1'])
  })

  it('оба фильтра — И: наш счёт И счёт контрагента должны совпасть', () => {
    const desc = buildActivityDescription(item({ counterparty: { name: 'A', unp: '', account: 'BY99PAYER0001', bank: '' } }))
    const rows = [
      row({ id: '1', originId: 'BY01ALFA|D1', description: desc }),
      row({ id: '2', originId: 'BY02PJCB|D2', description: desc })
    ]
    const got = selectDeletable(rows, { period: {}, accounts: ['BY01ALFA'], counterpartyAccounts: ['BY99PAYER0001'] })
    expect(got.map(r => r.id)).toEqual(['1'])
  })

  it('пустой список счетов контрагента ⇒ фильтр не применяется', () => {
    const rows = [row({ id: '1', description: 'что угодно' }), row({ id: '2', description: '' })]
    expect(selectDeletable(rows, { period: {}, accounts: [], counterpartyAccounts: [] })).toHaveLength(2)
  })
})

describe('periodLabel — что человек прочитает в подтверждении', () => {
  it('называет все четыре формы словами', () => {
    expect(periodLabel({})).toBe('за всё время')
    expect(periodLabel({ from: '2026-08-01' })).toBe('с 2026-08-01')
    expect(periodLabel({ to: '2026-08-31' })).toBe('по 2026-08-31')
    expect(periodLabel({ from: '2026-08-01', to: '2026-08-31' })).toBe('с 2026-08-01 по 2026-08-31')
  })
})
