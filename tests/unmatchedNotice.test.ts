import { describe, expect, it } from 'vitest'
import type { StatementItem } from '~/types/statement'
import { buildUnmatchedMessage, buildUnmatchedSummaryMessage, MAX_SUMMARY_ACCOUNTS, unmatchedClientNote, type UnmatchedSummary } from '~/utils/unmatchedNotice'

function makeItem(over: Partial<StatementItem> = {}): StatementItem {
  return {
    account: 'BY80ALFA0000',
    docId: '1',
    direction: 'credit',
    amount: 1500,
    currency: 'BYN',
    purpose: 'Оплата',
    counterparty: { name: 'ООО Тест', unp: '190000000', account: 'BY24CLIENT0001' },
    acceptDate: '2026-07-18T00:00:00.000Z',
    ...over
  }
}

describe('unmatchedClientNote', () => {
  it('names the counterparty account and explains the fallback', () => {
    const note = unmatchedClientNote(makeItem())
    expect(note).toContain('Клиент не определён')
    expect(note).toContain('BY24CLIENT0001')
    expect(note).toContain('записана в вашу компанию')
  })

  // ⚠ #43: совет «привяжите вручную» был НЕВЫПОЛНИМ — Bitrix24 не даёт сменить владельца у
  // созданного дела (`crm.activity.update` с OWNER_TYPE_ID → «Fields is not specified», #579).
  // Инструкция обязана называть РАБОЧИЙ путь: завести контрагента → удалить дело И элемент СП →
  // импорт запишет заново. Без удаления дела операция не вернётся: дедуп отсеет её по маркеру.
  it('НЕ советует невыполнимую ручную привязку, а называет рабочий путь — #43', () => {
    const note = unmatchedClientNote(makeItem())
    expect(note).not.toMatch(/привяжите (её )?вручную/i)
    expect(note).toMatch(/удалит[ьеи] это дело/i)
    expect(note).toContain('смарт-процесса')
    expect(note).toContain('нельзя')
  })

  it('тип карточки контрагента следует направлению: приход — Клиент, расход — Поставщик — #43', () => {
    expect(unmatchedClientNote(makeItem({ direction: 'credit' }))).toContain('«Клиент»')
    expect(unmatchedClientNote(makeItem({ direction: 'debit' }))).toContain('«Поставщик»')
  })

  // ⚠ Оговорка обязана быть в ТЕКСТЕ, а не только в JSDoc (находка ревью #43): админ, заведший
  // контрагента как «Партнёр», иначе решит, что импорт не сработал из-за типа, и пойдёт чинить
  // не то. Приложение ищет компанию ТОЛЬКО по счёту в реквизитах.
  it('текст оговаривает, что тип компании на поиск не влияет — #43', () => {
    expect(unmatchedClientNote(makeItem())).toMatch(/на поиск он не влияет|ищет по счёту/i)
  })

  it('BB-neutralizes a payer-controlled account (no live BB markup leaks into the card)', () => {
    const note = unmatchedClientNote(makeItem({ counterparty: { name: 'x', unp: '1', account: '[b]evil[/b]' } }))
    expect(note).not.toContain('[b]')
  })

  it('falls back to «—» when the account is empty', () => {
    expect(unmatchedClientNote(makeItem({ counterparty: { name: 'x', unp: '1', account: '' } }))).toContain('—')
  })
})

describe('buildUnmatchedMessage', () => {
  it('recorded-to-my-company variant: app prefix, direction, money, account, manual-link tail', () => {
    const msg = buildUnmatchedMessage(makeItem(), true)
    expect(msg).toContain('[Импорт выписки из клиент-банка]')
    expect(msg).toContain('приход')
    expect(msg.replace(/\s/g, ' ')).toContain('1 500,00 BYN') // formatMoney for 1500 BYN
    expect(msg).toContain('BY24CLIENT0001')
    // ⚠ #43: вместо невыполнимого «требует ручной привязки» — рабочий порядок действий.
    expect(msg).not.toMatch(/ручной привязки/i)
    expect(msg).toMatch(/завед[ие]те/i)
    expect(msg).toMatch(/удалит[ьеи] это дело/i)
    // ⚠ Хвост в ЧАТ намеренно короткий (повторяется на каждую операцию) — полная процедура в
    // справке. Гард на регресс «расписали инструкцию заново»: длина хвоста ограничена.
    expect(msg).toMatch(/справк/i)
  })

  it('not-recorded variant: says nothing was written and to add requisites', () => {
    const msg = buildUnmatchedMessage(makeItem({ direction: 'debit' }), false)
    expect(msg).toContain('расход')
    expect(msg).toContain('не записано')
    expect(msg).toContain('заведите реквизит')
  })

  it('BB-neutralizes the account in the chat notice', () => {
    const msg = buildUnmatchedMessage(makeItem({ counterparty: { name: 'x', unp: '1', account: '[url=x]y[/url]' } }), true)
    expect(msg).not.toContain('[url=')
  })

  it('falls back to «—» when the counterparty account is empty', () => {
    expect(buildUnmatchedMessage(makeItem({ counterparty: { name: 'x', unp: '1', account: '' } }), true)).toContain('счёт контрагента —')
  })
})

// ─── Итог по свёрнутым операциям (#696) ─────────────────────────────────────────────────────────

describe('buildUnmatchedSummaryMessage', () => {
  const S = (p: Partial<UnmatchedSummary> = {}): UnmatchedSummary =>
    ({ hidden: 0, hiddenUnrecorded: 0, accounts: [], ...p })

  it('прятать нечего → null (пустой итог читался бы как «было что-то ещё»)', () => {
    expect(buildUnmatchedSummaryMessage(S())).toBeNull()
    expect(buildUnmatchedSummaryMessage(S({ hidden: -1 }))).toBeNull()
  })

  it('все скрытые записаны в мою компанию → так и сказано', () => {
    const t = buildUnmatchedSummaryMessage(S({ hidden: 3, accounts: ['BY1'] }))!
    expect(t).toContain('Все записаны в вашу компанию.')
    expect(t).not.toContain('не записана')
  })

  it('не записана ни одна → отдельная формулировка, а не число', () => {
    const t = buildUnmatchedSummaryMessage(S({ hidden: 3, hiddenUnrecorded: 3 }))!
    expect(t).toContain('Ни одна из них не записана в CRM.')
  })

  it('записана часть → называется именно число', () => {
    const t = buildUnmatchedSummaryMessage(S({ hidden: 5, hiddenUnrecorded: 2 }))!
    expect(t).toContain('Из них 2 не записаны в CRM.')
  })

  it('счетов меньше капа → перечислены все, без «остальные»', () => {
    const t = buildUnmatchedSummaryMessage(S({ hidden: 2, accounts: ['BY1', 'BY2'] }))!
    expect(t).toContain('Уникальных счетов контрагентов — 2: BY1, BY2.')
    expect(t).not.toContain('не показаны')
  })

  it('счетов больше капа → показаны первые, а НЕПОКАЗАННЫЕ названы числом', () => {
    const accounts = Array.from({ length: MAX_SUMMARY_ACCOUNTS + 7 }, (_, i) => `BY${i + 1}`)
    const t = buildUnmatchedSummaryMessage(S({ hidden: 99, accounts }))!
    // ⚠ Общее число — ПОЛНОЕ, а не длина показанного куска: иначе обрезанный список читается как
    // полный, и человек решит, что завёл всех.
    expect(t).toContain(`Уникальных счетов контрагентов — ${accounts.length}`)
    expect(t).toContain(`первые ${MAX_SUMMARY_ACCOUNTS}`)
    expect(t).toContain('(остальные 7 не показаны)')
    expect(t).not.toContain(`BY${MAX_SUMMARY_ACCOUNTS + 1},`)
  })

  it('счетов нет вовсе → ни перечисления, ни совета «заведите их»', () => {
    const t = buildUnmatchedSummaryMessage(S({ hidden: 4, hiddenUnrecorded: 4 }))!
    expect(t).not.toContain('Уникальных счетов')
    expect(t).not.toContain('Заведите')
  })

  it('счёт контрагента пишет ПЛАТЕЛЬЩИК → BB-скобки нейтрализуются', () => {
    const t = buildUnmatchedSummaryMessage(S({ hidden: 1, accounts: ['[URL=http://evil]BY1[/URL]'] }))!
    expect(t).not.toContain('[URL=')
    expect(t).not.toContain('[/URL]')
    expect(t).toContain('BY1')
  })

  it('число операций склоняется', () => {
    expect(buildUnmatchedSummaryMessage(S({ hidden: 1 }))!).toContain('1 операция')
    expect(buildUnmatchedSummaryMessage(S({ hidden: 3 }))!).toContain('3 операции')
    expect(buildUnmatchedSummaryMessage(S({ hidden: 11 }))!).toContain('11 операций')
  })
})
