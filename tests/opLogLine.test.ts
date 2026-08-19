import { describe, expect, it } from 'vitest'
import { buildOpLogLine } from '../server/utils/opLogLine'
import type { StatementItem } from '../app/types/statement'

// Исполняемый тест гейта объёма и текста строки `[op]` (#498).
//
// ⚠ Заведён по находке ревью. Пока гейт жил в теле колбэка `onOperation`, проверить его можно было
// только архитектурным тестом по ТЕКСТУ исходника — и мутация `if (false && !shouldLogOperation(…))
// return` оставляла весь набор зелёным: подстрока на месте, порядок верный, гейт мёртв, объём лога
// молча вернулся к прежнему. Текстовая проверка такое не ловит принципиально: она не знает, что
// значит `false &&`. Здесь решение проверяется вызовом — `null` против строки.

function op(over: Partial<StatementItem> = {}): StatementItem {
  return {
    account: 'BY11AAAA00000000000000000001',
    docId: '42',
    date: '2026-08-19',
    amount: 100,
    currency: 'BYN',
    direction: 'credit',
    purpose: 'оплата по счёту СЧ-1',
    counterparty: { name: 'ООО Ромашка', account: 'BY22BBBB00000000000000000002' },
    ...over
  } as StatementItem
}

const landed = { owner: 'client', recognized: 1, activityId: '7' } as const
const stuck = { owner: 'none', recognized: 0, activityId: null } as const

describe('гейт объёма — исполняемый, а не текстовый', () => {
  it('приземлившаяся операция НЕ печатается по умолчанию', () => {
    expect(buildOpLogLine(op(), landed, 'M1', 'notable', false)).toBeNull()
  })

  it('не приземлившаяся печатается — это и есть диагностика', () => {
    const line = buildOpLogLine(op(), stuck, 'M1', 'notable', false)
    expect(line).toContain('[op] portal M1')
    expect(line).toContain('NO OWNER')
  })

  it('`all` печатает и приземлившуюся, `off` не печатает ничего', () => {
    expect(buildOpLogLine(op(), landed, 'M1', 'all', false)).not.toBeNull()
    expect(buildOpLogLine(op(), stuck, 'M1', 'off', false)).toBeNull()
    expect(buildOpLogLine(op(), landed, 'M1', 'off', false)).toBeNull()
  })

  it('возвращает `null`, а не пустую строку — иначе в логе была бы пустая строка', () => {
    // Мусор занимает место ровно там, где мы его экономим; вызывающий обязан различать
    // «нечего печатать» и «печатать пустое».
    expect(buildOpLogLine(op(), landed, 'M1', 'notable', false)).not.toBe('')
  })
})

describe('содержимое строки', () => {
  it('ФОРМА строки закреплена целиком — её цитирует runbook и по ней грепают', () => {
    // ⚠ Строка `[op]` это не внутренняя деталь: `docs/OPERATIONS.md` приводит её образец в таблице
    // диагностики («credit BYN ← BY… → NO OWNER, intents 0»), а оператор при инциденте ищет по ней
    // глазами и грепом. Значит форма — контракт с документацией, и менять её можно только
    // осознанно, вместе с документом. Ловится это только точным сравнением: проверки по кусочкам
    // пропустили бы и лишний пробел, и переставленные местами поля.
    //
    // Поводом стал перенос построения строки в этот модуль: шаблон переехал целиком, и молчаливая
    // правка формы при таком переезде — самый вероятный вид регрессии.
    const line = buildOpLogLine(
      op({ account: 'BY11X', docId: 'd1', counterparty: { name: 'N', account: 'BY22Y' } }),
      { owner: 'none', recognized: 0, activityId: null }, 'M1', 'notable', false)
    expect(line).toBe('[op] portal M1, op BY11X|d1: credit BYN ← BY22Y → NO OWNER, intents 0, activity —')
  })

  it('несёт то, что делает `unmatched` действием, и НЕ несёт сумму', () => {
    const line = buildOpLogLine(op({ amount: 987654.32 }), stuck, 'M1', 'notable', false)!
    // Счёт контрагента — ровно то значение, которое ищет `findCompany` в реквизитах портала.
    expect(line).toContain('BY22BBBB00000000000000000002')
    expect(line).toContain('BY11AAAA00000000000000000001|42')
    expect(line).toContain('credit')
    expect(line).toContain('BYN')
    // ⚠ Суммы в логах нет нигде (docs/PRIVACY.md §Логи).
    expect(line).not.toContain('987654')
  })

  it('назначение платежа скрыто по умолчанию и раскрывается ТОЛЬКО опт-ином', () => {
    expect(buildOpLogLine(op(), stuck, 'M1', 'notable', false)).not.toContain('СЧ-1')
    expect(buildOpLogLine(op(), stuck, 'M1', 'notable', true)).toContain('СЧ-1')
  })

  it('ОБА флага действуют независимо: `all` возвращает строку, опт-ин наполняет её назначением', () => {
    // Ровно та комбинация, которую предписывает калибровочная процедура в OPERATIONS.md, и
    // которую до сих пор никто не проверял выполнением — только чтением кода.
    const line = buildOpLogLine(op(), landed, 'M1', 'all', true)
    expect(line).not.toBeNull()
    expect(line).toContain('СЧ-1')
    // ⚠ И обратное: `all` сам по себе назначение НЕ раскрывает.
    expect(buildOpLogLine(op(), landed, 'M1', 'all', false)).not.toContain('СЧ-1')
  })

  it('внешние поля санитизируются — строка лога не склеивается инъекцией', () => {
    const line = buildOpLogLine(
      op({ account: 'BY11\nПОДДЕЛКА', counterparty: { name: 'X', account: 'BY22\rXX' } }),
      stuck, 'M1', 'notable', false)!
    expect(line).not.toContain('\n')
    expect(line).not.toContain('\r')
  })

  it('пустой счёт контрагента назван словами, а не пустотой', () => {
    const line = buildOpLogLine(op({ counterparty: { name: 'X', account: '' } }), stuck, 'M1', 'notable', false)!
    expect(line).toContain('счёт не указан')
  })

  it('владелец назван по-разному во всех трёх исходах', () => {
    const one = (owner: 'client' | 'my-company' | 'none') =>
      buildOpLogLine(op(), { owner, recognized: 0, activityId: null }, 'M1', 'all', false)!
    expect(one('client')).toContain('company')
    expect(one('my-company')).toContain('my-company (fallback)')
    expect(one('none')).toContain('NO OWNER')
  })
})
