// Normalize a parsed `1CClientBankExchange` file into our provider-agnostic
// StatementItem[]. Pure — no I/O. Another `manual`-upload format alongside the
// `***** ^Type=` client-bank text (issue #21). Reuses the generic date/account
// helpers from clientBankStatement.ts (Nuxt auto-imports app/utils/** as one
// namespace; kept explicit here for the unit tests).
//
// Key differences from the `***** ^Type=` format (see docs/PRIOR_API.md):
//  - direction is NOT a Db/Credit field — it is inferred from whether OUR account
//    is the payer (`ПлательщикСчет` → расход) or the payee (`ПолучательСчет` → приход),
//    falling back to the presence of `ДатаСписано` / `ДатаПоступило`;
//  - the counterparty is the OTHER side (payee on our debit, payer on our credit);
//  - the format carries no currency — inferred from the account (RU 20-digit code
//    or a Belarusian account → BYN), else `ctx.currency`;
//  - no unique document id — 1C identifies a document by "account + type + date +
//    number", so the dedup id is `Номер|Дата`.

import type { OneCExchange, OneCRecord } from '~/types/oneCExchange'
import type { NormalizeContext, OperationDirection, StatementItem, StatementNormalizer, StatementParty } from '~/types/statement'
import { clientBankDateToIso, isBelarusianAccount } from '~/utils/clientBankStatement'

/** Positive, finite amount from a `1234.56` string; `0` on garbage (no NaN). */
function money(value: string | undefined): number {
  const n = Number.parseFloat((value ?? '').replace(/\s/g, ''))
  return Number.isFinite(n) ? Math.abs(n) : 0
}

const digitsOnly = (s: string | undefined): string => (s ?? '').replace(/\D/g, '')

/** Currency inferred from an account number: the 3-digit code embedded in a
 * Russian 20-digit account (positions 6–8), else a Belarusian account → `BYN`,
 * else `undefined`. Old RU currency codes: 810/643 RUB, 840 USD, 978 EUR. */
export function currencyFromAccount(account: string): string | undefined {
  const acc = account.trim()
  if (/^\d{20}$/.test(acc)) {
    const code = acc.slice(5, 8)
    // Numeric keys (lint `quote-props: as-needed`); the string `code` lookup coerces fine.
    const map: Record<string, string> = { 810: 'RUB', 643: 'RUB', 840: 'USD', 978: 'EUR', 156: 'CNY', 933: 'BYN' }
    if (map[code]) return map[code]
  }
  if (isBelarusianAccount(acc)) return 'BYN'
  return undefined
}

/** First non-empty of the given keys on a record, trimmed. */
function pick(rec: OneCRecord, ...keys: string[]): string {
  for (const k of keys) {
    const v = (rec[k] ?? '').trim()
    if (v) return v
  }
  return ''
}

/**
 * Map one `СекцияДокумент` to a StatementItem, given OUR account and the
 * statement currency. Direction: our account as payer → расход, as payee → приход;
 * else `ДатаСписано` → расход / `ДатаПоступило` → приход; else default расход.
 */
export function normalizeOneCDocument(doc: OneCRecord, account: string, currency: string): StatementItem {
  const payerAcc = pick(doc, 'ПлательщикСчет', 'ПлательщикРасчСчет')
  const payeeAcc = pick(doc, 'ПолучательСчет', 'ПолучательРасчСчет')
  const acc = account.trim()

  // Direction priority: our account as payer/payee is the strongest signal; then
  // the presence of ДатаСписано (posted-out → расход) over ДатаПоступило
  // (posted-in → приход) — a document carrying BOTH prefers списание; and when no
  // signal at all is present the direction defaults to `debit` (расход), matching
  // the client-bank-text default. NOTE (#21): a marker-less document is a best-effort
  // guess — recheck against real multi-account 1C exports before wiring the UI.
  let direction: OperationDirection
  if (acc && payerAcc === acc) direction = 'debit'
  else if (acc && payeeAcc === acc) direction = 'credit'
  else if (pick(doc, 'ДатаСписано')) direction = 'debit'
  else if (pick(doc, 'ДатаПоступило')) direction = 'credit'
  else direction = 'debit'

  // Counterparty = the other side of the payment.
  const cp = direction === 'debit' ? 'Получатель' : 'Плательщик'
  const counterparty: StatementParty = {
    name: pick(doc, `${cp}1`, cp),
    unp: digitsOnly(pick(doc, `${cp}ИНН`)),
    account: pick(doc, `${cp}Счет`, `${cp}РасчСчет`),
    ...(pick(doc, `${cp}Банк1`, `${cp}Банк`) ? { bank: pick(doc, `${cp}Банк1`, `${cp}Банк`) } : {}),
    ...(pick(doc, `${cp}БИК`) ? { bic: pick(doc, `${cp}БИК`) } : {})
  }

  const num = pick(doc, 'Номер')
  const docDate = pick(doc, 'Дата')
  const acceptDate = clientBankDateToIso(pick(doc, 'Дата'))
  const operDate = clientBankDateToIso(pick(doc, direction === 'debit' ? 'ДатаСписано' : 'ДатаПоступило'))

  return {
    account,
    // No unique id in the format — "account + type + date + number" identity.
    // Empty when both Номер and Дата are missing (avoids a bogus "|" that would
    // collide across id-less documents), mirroring rowDocId in clientBankStatement.
    docId: num || docDate ? `${num}|${docDate}` : '',
    ...(num ? { docNum: num } : {}),
    direction,
    amount: money(pick(doc, 'Сумма')),
    currency,
    purpose: pick(doc, 'НазначениеПлатежа'),
    counterparty,
    acceptDate,
    ...(operDate && operDate !== acceptDate.slice(0, 10) ? { operDate } : {}),
    ...(pick(doc, 'ВидОплаты') ? { operCodeName: pick(doc, 'ВидОплаты') } : {})
  }
}

/**
 * Normalize a whole `1CClientBankExchange` file. `ctx.account` overrides our own
 * account (else the header/section `РасчСчет`); `ctx.currency` overrides the
 * account-inferred currency. All documents are operations.
 */
export function normalizeOneCExchange(parsed: OneCExchange, ctx: NormalizeContext): StatementItem[] {
  const account = ctx.account
    || pick(parsed.header, 'РасчСчет')
    || (parsed.accounts[0] ? pick(parsed.accounts[0], 'РасчСчет') : '')
  const currency = ctx.currency || currencyFromAccount(account) || ''
  return parsed.documents.map(doc => normalizeOneCDocument(doc, account, currency))
}

/** The 1C-exchange implementation of the unified `StatementNormalizer` contract
 * (`raw, ctx → StatementItem[]`), where `raw` is the `parseOneCExchange` output. */
export const normalizeOneC: StatementNormalizer<OneCExchange> = normalizeOneCExchange
