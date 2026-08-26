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
    counterparty: { name: 'ООО Ромашка', unp: '', account: 'BY22BBBB00000000000000000002' },
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
    // ⚠ Маркера `[op]` в самой строке БОЛЬШЕ НЕТ — его печатает канал логгера (#529). Иначе вышло
    // бы `[op] INFO: [op] portal …`; совпадение канала с маркером стережёт `serverLogChannels`.
    expect(line).toContain('portal M1')
    expect(line).not.toContain('[op]')
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
  it('ФОРМА default-строки закреплена целиком — БЕЗ номеров счетов (#617)', () => {
    // ⚠ Строка `[op]` это не внутренняя деталь: `docs/OPERATIONS.md` приводит её образец в таблице
    // диагностики, а оператор при инциденте ищет по ней глазами и грепом. Значит форма — контракт с
    // документацией, и менять её можно только осознанно, вместе с документом. Ловится это только
    // точным сравнением: проверки по кусочкам пропустили бы и лишний пробел, и переставленные поля.
    //
    // ⚠ По умолчанию в строке НЕТ номеров счетов обеих сторон (#617): json-file режет лог по объёму,
    // не по сроку, и попавший IBAN лежит там годами. Остаётся `docId` (не счёт — id документа,
    // ключ дедупа), направление, валюта, владелец и счётчики.
    const line = buildOpLogLine(
      op({ account: 'BY11X', docId: 'd1', counterparty: { name: 'N', unp: '', account: 'BY22Y' } }),
      { owner: 'none', recognized: 0, activityId: null }, 'M1', 'notable', false)
    expect(line).toBe('portal M1, op d1: credit BYN → NO OWNER, intents 0, activity —')
  })

  it('ФОРМА debug-строки (опт-ин) закреплена целиком — с номерами счетов и назначением', () => {
    // Под `STATEMENT_DEBUG_LOG` строка раскрывает ПДн для калибровки — это прежняя полная форма
    // плюс назначение; порядок полей цитирует OPERATIONS.md.
    const line = buildOpLogLine(
      op({ account: 'BY11X', docId: 'd1', purpose: 'СЧ-9', counterparty: { name: 'N', unp: '', account: 'BY22Y' } }),
      { owner: 'none', recognized: 0, activityId: null }, 'M1', 'notable', true)
    expect(line).toBe('portal M1, op BY11X|d1: credit BYN ← BY22Y → NO OWNER, intents 0, activity — purpose="СЧ-9"')
  })

  it('номера счетов обеих сторон скрыты по умолчанию и раскрываются ТОЛЬКО опт-ином (#617)', () => {
    const def = buildOpLogLine(op({ amount: 987654.32 }), stuck, 'M1', 'notable', false)!
    // ⚠ Ни наш счёт, ни счёт контрагента в default-строке не появляются.
    expect(def).not.toContain('BY22BBBB00000000000000000002')
    expect(def).not.toContain('BY11AAAA00000000000000000001')
    // Диагностика без ПДн всё равно есть: направление, валюта, исход.
    expect(def).toContain('credit')
    expect(def).toContain('BYN')
    expect(def).toContain('NO OWNER')
    // ⚠ Суммы в логах нет нигде (docs/PRIVACY.md §Логи) — ни в каком режиме.
    expect(def).not.toContain('987654')
    // Под опт-ином оба счёта — то значение, которое ищет `findCompany` в реквизитах портала.
    const dbg = buildOpLogLine(op({ amount: 987654.32 }), stuck, 'M1', 'notable', true)!
    expect(dbg).toContain('BY22BBBB00000000000000000002')
    expect(dbg).toContain('BY11AAAA00000000000000000001|42')
    expect(dbg).not.toContain('987654')
  })

  it('назначение платежа скрыто по умолчанию и раскрывается ТОЛЬКО опт-ином', () => {
    expect(buildOpLogLine(op(), stuck, 'M1', 'notable', false)).not.toContain('СЧ-1')
    expect(buildOpLogLine(op(), stuck, 'M1', 'notable', true)).toContain('СЧ-1')
  })

  it('ОБА флага действуют независимо: `all` возвращает строку, опт-ин наполняет её ПДн', () => {
    // Ровно та комбинация, которую предписывает калибровочная процедура в OPERATIONS.md, и
    // которую до сих пор никто не проверял выполнением — только чтением кода.
    const line = buildOpLogLine(op(), landed, 'M1', 'all', true)
    expect(line).not.toBeNull()
    expect(line).toContain('СЧ-1')
    // ⚠ И обратное: `all` сам по себе назначение/счета НЕ раскрывает.
    expect(buildOpLogLine(op(), landed, 'M1', 'all', false)).not.toContain('СЧ-1')
  })

  it('внешние поля санитизируются — строка лога не склеивается инъекцией', () => {
    // ⚠ Под опт-ином (номера счетов в строке): проверяем, что CR/LF из полей банка не склеивают лог.
    const line = buildOpLogLine(
      op({ account: 'BY11\nПОДДЕЛКА', counterparty: { name: 'X', unp: '', account: 'BY22\rXX' } }),
      stuck, 'M1', 'notable', true)!
    expect(line).not.toContain('\n')
    expect(line).not.toContain('\r')
  })

  it('пустой счёт контрагента назван словами под опт-ином, а в default-строке счёта нет вовсе', () => {
    const dbg = buildOpLogLine(op({ counterparty: { name: 'X', unp: '', account: '' } }), stuck, 'M1', 'notable', true)!
    expect(dbg).toContain('счёт не указан')
    // ⚠ В default-строке нет ни счёта, ни фразы «счёт не указан» — стрелки контрагента там нет.
    const def = buildOpLogLine(op({ counterparty: { name: 'X', unp: '', account: '' } }), stuck, 'M1', 'notable', false)!
    expect(def).not.toContain('счёт не указан')
    expect(def).not.toContain('←')
  })

  it('владелец назван по-разному во всех трёх исходах', () => {
    const one = (owner: 'client' | 'my-company' | 'none') =>
      buildOpLogLine(op(), { owner, recognized: 0, activityId: null }, 'M1', 'all', false)!
    expect(one('client')).toContain('company')
    expect(one('my-company')).toContain('my-company (fallback)')
    expect(one('none')).toContain('NO OWNER')
  })
})
