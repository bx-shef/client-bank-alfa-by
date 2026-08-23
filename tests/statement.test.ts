import { describe, expect, it } from 'vitest'
import type { StatementItem } from '~/types/statement'
import { dedupKey, directionFromOperType, isExcludedOperation, parseRuleLines, shouldNotifyChat, splitByDirection } from '~/utils/statement'

function makeItem(over: Partial<StatementItem> = {}): StatementItem {
  return {
    account: 'BY80ALFA30121122220090270000',
    docId: '1',
    direction: 'credit',
    amount: 100,
    currency: 'BYN',
    purpose: 'Оплата по счёту',
    counterparty: { name: 'ООО Тест', unp: '190000000', account: 'BY24X' },
    acceptDate: '2026-06-26T00:00:00.000Z',
    ...over
  }
}

describe('directionFromOperType', () => {
  it('maps C (any case, padded) to credit and everything else to debit', () => {
    expect(directionFromOperType('C')).toBe('credit')
    expect(directionFromOperType(' c ')).toBe('credit')
    expect(directionFromOperType('D')).toBe('debit')
    expect(directionFromOperType('')).toBe('debit')
    expect(directionFromOperType(undefined)).toBe('debit')
  })
})

describe('dedupKey', () => {
  it('combines account and docId', () => {
    expect(dedupKey({ account: 'BY80', docId: '42' })).toBe('BY80|42')
  })

  it('falls back to a content signature when docId is blank (no account-wide collapse)', () => {
    // Two DIFFERENT payments on the same account with no doc id must not share a key.
    const a = makeItem({ docId: '', amount: 100, purpose: 'аренда' })
    const b = makeItem({ docId: '', amount: 250, purpose: 'услуги' })
    expect(dedupKey(a)).not.toBe(dedupKey(b))
    expect(dedupKey(a)).not.toBe('BY80ALFA30121122220090270000|') // not the collapsing key
  })

  it('is idempotent for a re-run of the same blank-docId payment', () => {
    const item = makeItem({ docId: '', amount: 100 })
    expect(dedupKey(item)).toBe(dedupKey(makeItem({ docId: '   ', amount: 100 })))
  })

  it('blank-docId key is BOUNDED (hashed) — a huge payer-controlled purpose cannot overflow ORIGIN_ID', () => {
    // The key lands in B24 ORIGIN_ID (varchar 255); raw concatenation would truncate there and the
    // exact-match marker lookup would never find it again → duplicate activities on redelivery.
    const long = makeItem({ docId: '', purpose: 'х'.repeat(10_000) })
    expect(dedupKey(long).length).toBeLessThan(80)
    expect(dedupKey(long)).toBe(dedupKey({ ...long })) // still deterministic
  })

  it('length-prefixing prevents field-splicing via payer-controlled separators', () => {
    // Adjacent fields (purpose, counterparty.account) shifted across the boundary: a naive
    // `join('¦')` yields the SAME string for both (purpose is payer-controlled) → same key →
    // one of two different operations silently dropped. Length-prefixing keeps them distinct.
    const a = makeItem({ docId: '', purpose: 'X¦Y', counterparty: { name: 'N', unp: 'U', account: 'Z' } })
    const b = makeItem({ docId: '', purpose: 'X', counterparty: { name: 'N', unp: 'U', account: 'Y¦Z' } })
    expect(dedupKey(a)).not.toBe(dedupKey(b))
  })
})

describe('splitByDirection', () => {
  it('separates credits from debits preserving order', () => {
    const items = [
      makeItem({ docId: 'a', direction: 'credit' }),
      makeItem({ docId: 'b', direction: 'debit' }),
      makeItem({ docId: 'c', direction: 'credit' })
    ]
    const { credits, debits } = splitByDirection(items)
    expect(credits.map(i => i.docId)).toEqual(['a', 'c'])
    expect(debits.map(i => i.docId)).toEqual(['b'])
  })

  it('returns empty buckets for an empty array', () => {
    expect(splitByDirection([])).toEqual({ credits: [], debits: [] })
  })
})

describe('parseRuleLines', () => {
  it('splits lines, trims, drops blanks and duplicates', () => {
    expect(parseRuleLines(' BY1 \n\nBY2\nBY1\n   \n')).toEqual(['BY1', 'BY2'])
  })
  it('handles Windows CRLF line endings', () => {
    expect(parseRuleLines('BY1\r\nBY2\r\n')).toEqual(['BY1', 'BY2'])
  })
  it('returns an empty array for empty/whitespace input', () => {
    expect(parseRuleLines('   \n  ')).toEqual([])
  })
})

describe('shouldNotifyChat', () => {
  it('announces credits by default and silences debits', () => {
    expect(shouldNotifyChat(makeItem({ direction: 'credit' }))).toBe(true)
    expect(shouldNotifyChat(makeItem({ direction: 'debit' }))).toBe(false)
  })

  it('can opt debits in via directions rule', () => {
    expect(shouldNotifyChat(makeItem({ direction: 'debit' }), { directions: ['credit', 'debit'] })).toBe(true)
  })

  it('respects a debit-only directions rule', () => {
    expect(shouldNotifyChat(makeItem({ direction: 'debit' }), { directions: ['debit'] })).toBe(true)
    expect(shouldNotifyChat(makeItem({ direction: 'credit' }), { directions: ['debit'] })).toBe(false)
  })

  it('applies counterparty and purpose exclusions independently in one ruleset', () => {
    const rules = { excludeCounterpartyAccounts: ['BY-TAX'], excludePurposePatterns: ['между своими'] }
    const fromTax = makeItem({ counterparty: { name: 'ИМНС', unp: '100000000', account: 'BY-TAX' } })
    expect(shouldNotifyChat(fromTax, rules)).toBe(false)
    expect(shouldNotifyChat(makeItem({ purpose: 'Перевод между своими счетами' }), rules)).toBe(false)
    expect(shouldNotifyChat(makeItem(), rules)).toBe(true)
  })

  it('silences purposes matching an exclude pattern (case-insensitive)', () => {
    const item = makeItem({ purpose: 'Перевод между своими счетами' })
    expect(shouldNotifyChat(item, { excludePurposePatterns: ['между своими'] })).toBe(false)
  })

  it('ignores empty exclude patterns', () => {
    expect(shouldNotifyChat(makeItem(), { excludePurposePatterns: ['', '   '] })).toBe(true)
  })
})

describe('isExcludedOperation (processing exclusion, PROCESSING §2 A2)', () => {
  it('НАШ счёт исключением не выключается — такого списка нет вовсе', () => {
    // ⚠ Список наших счетов снят по решению владельца (2026-08-23): он дублировал «Паузу»
    // подключения, причём хуже неё — этот гейт стоит уже ПОСЛЕ похода в банк, а пауза
    // останавливает опрос до него и не тратит лимит запросов. Единственным оправданием оставалась
    // файловая загрузка, но файл выписки выгружается ПО ОДНОМУ счёту (проверено по фикстурам —
    // шапка несёт один `^Acc=…^`), и грузящий сам выбирает, по какому. Тест держит отсутствие:
    // вернуть поле «для симметрии с контрагентами» — первое, что придёт в голову следующему.
    const item = makeItem({ account: 'BY80ACC' })
    expect(isExcludedOperation(item, { excludeCounterpartyAccounts: ['BY80ACC'] })).toBe(false)
  })

  it('excludes a purpose matching a pattern (case-insensitive)', () => {
    expect(isExcludedOperation(makeItem({ purpose: 'Перевод МЕЖДУ своими счетами' }), { excludePurposePatterns: ['между своими'] })).toBe(true)
  })

  it('is NOT triggered by direction — exclusion is account/purpose only, not приход/расход', () => {
    // A debit is not "excluded"; it's only a chat-direction matter. Excluded = skip whole op.
    expect(isExcludedOperation(makeItem({ direction: 'debit' }), { directions: ['credit'] })).toBe(false)
  })

  it('returns false with no rules / empty patterns', () => {
    expect(isExcludedOperation(makeItem())).toBe(false)
    expect(isExcludedOperation(makeItem(), { excludePurposePatterns: ['', '  '] })).toBe(false)
  })

  it('исключает по счёту КОНТРАГЕНТА — и не путает его с нашим (#562)', () => {
    // ⚠ Выключается ПЛАТЕЛЬЩИК: налоговая, банк, эквайринг — за шесть суток они дали 500 дел
    // в «моей компании». Номер в правиле контрагентов НЕ должен срабатывать как наш счёт.
    const item = makeItem({ account: 'BY-OURS', counterparty: { name: 'ИМНС', unp: '100000000', account: 'BY-TAX' } })
    expect(isExcludedOperation(item, { excludeCounterpartyAccounts: ['BY-TAX'] })).toBe(true)
    expect(isExcludedOperation(item, { excludeCounterpartyAccounts: [' BY-TAX '] })).toBe(true)
    // НАШ счёт в этом же списке платёж не исключает — сравнивается только сторона контрагента.
    expect(isExcludedOperation(item, { excludeCounterpartyAccounts: ['BY-OURS'] })).toBe(false)
  })

  it('ГАРД ИНВАРИАНТА: без настроек не исключается НИКТО — даже «очевидные» неклиенты (#562)', () => {
    // ⚠ Решение владельца (2026-08-23): программно на гейте A2 не исключается ничего — ни по имени
    // плательщика, ни по виду платежа. Записано в PROCESSING §2 A2, продублировано админу в справке
    // и на экране «Исключений».
    //
    // ⚠ Прозой такой инвариант не держится. Зашитый перечень («ИМНС», «эквайринг»), эвристика по
    // имени или «умное умолчание» прошли бы весь набор зелёными: остальные тесты подают правила
    // явно и потому проверяют лишь то, что заданное правило срабатывает, а не то, что НЕЗАДАННОЕ
    // не срабатывает. Здесь правил нет вовсе — сработать может только самодеятельность.
    const obvious = [
      { name: 'ИМНС по г. Минску', unp: '100000000', account: 'BY-TAX' },
      { name: 'ОАО «Банк» комиссия за РКО', unp: '100000001', account: 'BY-BANK' },
      { name: 'Эквайринг торговый', unp: '100000002', account: 'BY-ACQ' },
      { name: 'Республиканский бюджет', unp: '100000003', account: 'BY-BUDGET' }
    ]
    for (const counterparty of obvious) {
      const item = makeItem({ counterparty, purpose: `оплата ${counterparty.name} за услуги` })
      expect(isExcludedOperation(item, {}), counterparty.name).toBe(false)
      expect(isExcludedOperation(item), `${counterparty.name} без правил вовсе`).toBe(false)
      // Заполненные, но НЕ совпадающие списки — тоже не повод исключить.
      expect(
        isExcludedOperation(item, { excludeCounterpartyAccounts: ['BY-OTHER'], excludePurposePatterns: ['ничего похожего'] }),
        `${counterparty.name} с чужими правилами`
      ).toBe(false)
    }
  })

  it('пустой счёт контрагента не матчится никогда — пустая строка в правиле не выключает всё (#562)', () => {
    // ⚠ Банк не всегда сообщает счёт плательщика. Пустое правило, совпавшее с пустым счётом,
    // молча выключило бы ВСЕ такие операции.
    const noCp = makeItem({ counterparty: { name: 'Без счёта', unp: '', account: '' } })
    expect(isExcludedOperation(noCp, { excludeCounterpartyAccounts: [''] })).toBe(false)
    expect(isExcludedOperation(noCp, { excludeCounterpartyAccounts: ['  '] })).toBe(false)
  })

  it('shouldNotifyChat still silences an excluded op (reuses isExcludedOperation)', () => {
    const rules = { excludeCounterpartyAccounts: ['BY-TAX'] }
    const fromTax = makeItem({ counterparty: { name: 'ИМНС', unp: '100000000', account: 'BY-TAX' } })
    expect(shouldNotifyChat(fromTax, rules)).toBe(false)
  })
})
