// Pure core for the public landing DEMO (issue: landing demo file upload). It powers
// three demo sources that all end at the SAME extraction screen:
//   1. a user-uploaded statement file (parsed in the browser — importUpload.ts),
//   2. an Alfa-Bank "sandbox" sample run through the REAL normalizeAlfa,
//   3. a Priorbank "sandbox" sample run through the REAL normalizePrior.
// The landing demo runs client-side and holds no bank credentials, so the "sandbox"
// demos exercise the real normalizers on representative responses instead of a
// live fetch — proving the "bank response → normalized operations" path. The live
// OAuth fetch is designed to run in the backend (per-portal token), not on the
// landing — that transport is a roadmap item (stage 5), not yet built.
//
// `summarizeExtraction` turns a StatementItem[] into the human "what we found"
// summary shown on the landing (counts, totals per currency, unique counterparties,
// and recognized identifiers). Recognition reuses the real recognizeByMatrices with
// a small DEMO matrix set — on a real portal the matrices come from settings.
//
// No DOM, no I/O — unit-tested in tests/demoExtract.test.ts.

import { round2 } from '~/utils/money'
import { normalizeAlfa, type AlfaStatementResponse } from '~/utils/alfaStatement'
import { normalizePrior, type PriorTransactionListResponse } from '~/utils/priorStatement'
import { splitByDirection } from '~/utils/statement'
import { recognizeByMatrices, type MatchMatrix, type RecognizedId } from '~/utils/purposeMatch'
import type { StatementItem } from '~/types/statement'

/** Demo recognition matrices (§4). On a real portal these come from per-portal
 *  settings; here they demonstrate the mechanism on the sample data. `d` = digit,
 *  every other char is a literal (homoglyph-folded before matching). */
export const DEMO_MATRICES: readonly MatchMatrix[] = [
  { mask: 'СЧ-dddd', kind: 'invoice-number', note: 'Смарт-счёт вида СЧ-1042' },
  { mask: 'ЗК-dddd', kind: 'order-number', note: 'Заказ вида ЗК-2050' },
  { mask: 'BOPC-ddd/dd', kind: 'document-number', note: 'Документ генерации' }
]

/** One line of the "what we extracted" per-operation recognition list. */
export interface DemoRecognizedRow {
  /** Idempotency doc id of the operation (account|docId key source). */
  docId: string
  /** Counterparty display name (or account fallback). */
  counterparty: string
  /** Payment purpose the identifier was recognized in. */
  purpose: string
  /** Identifiers recognized in the purpose (non-empty — rows with none are dropped). */
  ids: RecognizedId[]
}

/** Per-currency money total. `credit`/`debit` are rounded to 2 decimal places in
 *  this pure layer so IEEE-754 accumulation error (e.g. 0.1 + 0.2) never surfaces
 *  in the UI; the component only formats. */
export interface DemoCurrencyTotal {
  currency: string
  credit: number
  debit: number
}

/** The full "what we found in this statement" summary shown on the landing. */
export interface DemoExtraction {
  items: StatementItem[]
  operationCount: number
  creditCount: number
  debitCount: number
  /** Totals split by currency (a statement may mix BYN + foreign currency rows). */
  totals: DemoCurrencyTotal[]
  /** Number of distinct counterparties (by УНП, else account, else name). */
  counterpartyCount: number
  /** Operations whose purpose yielded at least one recognized identifier. */
  recognized: DemoRecognizedRow[]
}

/** Stable key identifying a distinct counterparty (УНП preferred, then account, then name). */
function counterpartyKey(item: StatementItem): string {
  const cp = item.counterparty
  return (cp.unp || cp.account || cp.name || '').trim().toLowerCase()
}

/**
 * Summarize a normalized statement into the landing demo view model. Pure — the
 * same function serves the file-upload path and both bank sandbox samples, so the
 * "what we extract" screen is identical regardless of source.
 */
export function summarizeExtraction(items: StatementItem[]): DemoExtraction {
  const { credits, debits } = splitByDirection(items)

  const byCurrency = new Map<string, DemoCurrencyTotal>()
  for (const it of items) {
    const cur = it.currency || '—'
    const row = byCurrency.get(cur) ?? { currency: cur, credit: 0, debit: 0 }
    if (it.direction === 'credit') row.credit += it.amount
    else row.debit += it.amount
    byCurrency.set(cur, row)
  }
  // Round each total once, after accumulation, so summing many decimal rows can't
  // leak float artifacts into the demo view.
  for (const row of byCurrency.values()) {
    row.credit = round2(row.credit)
    row.debit = round2(row.debit)
  }

  const counterparties = new Set<string>()
  for (const it of items) {
    const key = counterpartyKey(it)
    if (key) counterparties.add(key)
  }

  const recognized: DemoRecognizedRow[] = []
  for (const it of items) {
    const ids = recognizeByMatrices(it.purpose, DEMO_MATRICES)
    if (ids.length) {
      recognized.push({
        docId: it.docId,
        counterparty: it.counterparty.name || it.counterparty.account || '—',
        purpose: it.purpose,
        ids
      })
    }
  }

  return {
    items,
    operationCount: items.length,
    creditCount: credits.length,
    debitCount: debits.length,
    totals: [...byCurrency.values()],
    counterpartyCount: counterparties.size,
    recognized
  }
}

// --- Bank "sandbox" samples ------------------------------------------------
// Representative responses in the exact wire shape each bank returns, so the demo
// runs the REAL normalizer (not a hand-built StatementItem[]). Purposes carry
// identifiers the DEMO_MATRICES recognize, to showcase §4 recognition end-to-end.

/** Alfa `/accounts/statement` sample (partner.accounts 1.2.0 wire shape). */
export function demoAlfaResponse(): AlfaStatementResponse {
  return {
    page: [
      {
        number: 'BY80ALFA30121122220090270000',
        operType: 'C',
        operCodeName: 'Зачисление',
        operDate: '26.06.2026',
        acceptDate: '2026-06-26T10:15:00.000',
        docId: '100231',
        docNum: '541',
        amount: 1840.0,
        currIso: 'BYN',
        purpose: 'Оплата по счёту СЧ-1042 за консультационные услуги, без НДС',
        corrName: 'ООО «Ромашка»',
        corrUnp: '191234567',
        corrNumber: 'BY24ALFA30120000000000000001',
        corrBic: 'ALFABY2X',
        corrBank: 'ОАО «Альфа-Банк»'
      },
      {
        number: 'BY80ALFA30121122220090270000',
        operType: 'C',
        operCodeName: 'Зачисление',
        operDate: '27.06.2026',
        acceptDate: '2026-06-27T09:02:00.000',
        docId: '100232',
        docNum: '542',
        amount: 4200.0,
        currIso: 'BYN',
        purpose: 'Предоплата по заказу ЗК-2050 за оборудование',
        corrName: 'ИП Петров П. П.',
        corrUnp: '291112223',
        corrNumber: 'BY24PJCB30120000000000000002',
        corrBic: 'PJCBBY2X',
        corrBank: 'ОАО «Приорбанк»'
      },
      {
        number: 'BY80ALFA30121122220090270000',
        operType: 'D',
        operCodeName: 'Списание',
        operDate: '27.06.2026',
        acceptDate: '2026-06-27T16:40:00.000',
        docId: '100233',
        docNum: '88',
        amount: 540.0,
        currIso: 'BYN',
        purpose: 'Оплата аренды офиса за июнь 2026',
        corrName: 'ООО «Бизнес-Центр»',
        corrUnp: '190009988',
        corrNumber: 'BY24ALFA30120000000000000003',
        corrBic: 'ALFABY2X',
        corrBank: 'ОАО «Альфа-Банк»'
      }
    ]
  }
}

/** Priorbank Open Banking (СПР) transaction-list sample. */
export function demoPriorResponse(): PriorTransactionListResponse {
  return {
    data: {
      accountId: 'BY13PJCB30120000000000000000',
      transaction: [
        {
          transactionId: 'PR-778001',
          number: '778001',
          creditDebitIndicator: 'Credit',
          status: 'Booked',
          bookingDateTime: '2026-06-25T11:00:00.000+03:00',
          valueDate: '2026-06-25',
          transactionDetails: 'Оплата по счёту СЧ-2077 по договору поставки',
          amount: 3150.75,
          currency: 'BYN',
          debtor: {
            name: 'ЗАО «Вектор»',
            organisationIdentification: [{ code: 'INN', identification: 'INN192887711' }]
          },
          debtorAccount: { schemeName: 'BY.NBRB.IBAN', identification: 'BY24MMBN30120000000000000009' },
          debtorAgent: { identification: 'MMBNBY22', name: 'ОАО «Банк Дабрабыт»' }
        },
        {
          transactionId: 'PR-778002',
          number: '778002',
          creditDebitIndicator: 'Debit',
          status: 'Booked',
          bookingDateTime: '2026-06-26T14:30:00.000+03:00',
          valueDate: '2026-06-26',
          transactionDetails: 'Оплата услуг связи за июнь по документу BOPC-114/26',
          amount: 96.4,
          currency: 'BYN',
          creditor: {
            name: 'СООО «Компания Связи»',
            organisationIdentification: [{ code: 'INN', identification: 'INN100777001' }]
          },
          creditorAccount: { schemeName: 'BY.NBRB.IBAN', identification: 'BY24PJCB30120000000000000010' },
          creditorAgent: { identification: 'PJCBBY2X', name: 'ОАО «Приорбанк»' }
        }
      ]
    }
  }
}

/** Run the real Alfa normalizer on the sandbox sample → extraction summary. */
export function demoAlfaExtraction(): DemoExtraction {
  const account = 'BY80ALFA30121122220090270000'
  return summarizeExtraction(normalizeAlfa(demoAlfaResponse(), { account }))
}

/** Run the real Prior normalizer on the sandbox sample → extraction summary. */
export function demoPriorExtraction(): DemoExtraction {
  const account = 'BY13PJCB30120000000000000000'
  return summarizeExtraction(normalizePrior(demoPriorResponse(), { account, currency: 'BYN' }))
}
