// Normalize a parsed Belarusian client-bank text export (`***** ^Type=`) into our
// provider-agnostic StatementItem[]. Pure — no I/O — so it is shared by the
// frontend and the future backend, and unit-tested against the anonymized
// fixtures (tests/clientBankStatement.test.ts). This is the `manual` (hand-
// uploaded file) provider, and the file-based path for `prior-by` — the SAME
// text format backs both (see app/config/banks.ts and issue #19).
//
// Pipeline: decode CP1251 → `parseClientBankText` (format parser) → `normalizeClientBank`
// (this file). The parse+decode step is the "fetch" for a manual upload; this
// normalizer is the provider's `StatementNormalizer` (raw = the parsed struct).

import type { ClientBankParsed, ClientBankRow } from '~/types/clientBankText'
import type { NormalizeContext, OperationDirection, StatementItem, StatementNormalizer, StatementParty } from '~/types/statement'

/** A `dd.mm.yyyy` or `dd.mm.yyyy hh:mm:ss` client-bank date → ISO 8601, or `''`
 * when unparseable. Time (if present) is kept as a local wall-clock ISO string
 * (`2023-09-28T10:19:04`) — the statement carries no timezone; the backend
 * stamps the portal TZ when it writes the CRM activity (see issue #10). */
export function clientBankDateToIso(value: string | undefined): string {
  const raw = (value ?? '').trim()
  if (!raw) return ''
  const m = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?$/)
  if (!m) return ''
  const [, dd, mm, yyyy, time] = m
  return `${yyyy}-${mm}-${dd}${time ? `T${time}` : ''}`
}

/** First non-empty value among the given keys, trimmed. */
function firstOf(row: ClientBankRow, keys: readonly string[]): string {
  for (const k of keys) {
    const v = (row[k] ?? '').trim()
    if (v) return v
  }
  return ''
}

/** Parse a client-bank money string (`"50.00"`) to a finite, non-negative
 * number; `0` on empty/garbage (never lets NaN leak downstream). */
function money(value: string): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? Math.abs(n) : 0
}

const ALPHA3 = /^[A-Z]{3}$/
const digitsOnly = (s: string): string => s.replace(/\D/g, '')

/**
 * Whether a Belarusian own-account (so its statement defaults to `BYN` when no
 * currency marker is present). Covers BOTH the IBAN form (`BY…`) and the legacy
 * 13-digit numeric form (e.g. `3013212016013`) that real Альфа/Приор `Type=4`
 * exports still use — the IBAN-only check missed those, leaving every operation
 * without a currency (issue #19). A Russian 20-digit account (`40702810…`) does
 * not match, so the 1C-exchange path is unaffected.
 */
export function isBelarusianAccount(account: string): boolean {
  const acc = account.trim()
  return acc.toUpperCase().startsWith('BY') || /^\d{13}$/.test(acc)
}

/**
 * Currency of the whole statement (national vs foreign): explicit alpha-3 markers
 * win (`I3` file-level, then header `I1`), then the caller-supplied `ctx.currency`,
 * then a Belarusian own-account defaults to `BYN`. `''` if undetermined — the caller
 * (UI) must block the import then, per issue #19. A per-row `I2` marker can still
 * override this for a single row (see normalizeClientBankRow).
 */
export function detectStatementCurrency(parsed: ClientBankParsed, ctxCurrency?: string): string {
  const out = parsed.OUT_PARAM
  const marker = (v: string | undefined): string | undefined => (v && ALPHA3.test(v) ? v : undefined)
  return marker(out.unrouted.I3)
    ?? marker(out.header.I1)
    ?? marker(ctxCurrency)
    ?? (isBelarusianAccount(parsed.GENERAL.ACC) ? 'BYN' : '')
}

/**
 * Stable per-operation id for the dedup key `account|docId`. Prefers the explicit
 * `DocID`; when the export omits it (real `Type=4` files do — every row would
 * otherwise collapse to `account|`, breaking dedup, issue #19) falls back to the
 * document-number + date identity (`Num|DocDate`), mirroring how the 1C exchange
 * format itself identifies a document ("account + type + date + number").
 */
export function rowDocId(row: ClientBankRow): string {
  const explicit = (row.DocID ?? '').trim()
  if (explicit) return explicit
  const num = (row.Num ?? '').trim()
  const date = (row.DocDate ?? '').trim()
  return num || date ? `${num}|${date}` : ''
}

// Debit/credit field chains. A FOREIGN-currency statement carries BOTH the
// account-currency (foreign) amount in the `…Q` field AND the BYN equivalent in
// the plain field — so the foreign amount is taken STRICTLY from `…Q` (never a
// fallback to the plain field, which would mislabel a BYN value with the foreign
// currency). A national (BYN) statement has the amount in the plain field, with
// `…Q` a rare fallback. Direction is always read from the plain fields (the `…Q`
// side can be 0 on a revaluation row).
// NOTE (#19): this foreign-vs-national split is confirmed only against the
// synthetic CNY fixture — recheck on real foreign statements. If a foreign row
// ever ships without a `…Q` field the amount is 0 here (under-reported, but the
// currency stays truthful) rather than a mislabeled BYN equivalent.
const DEBIT_PLAIN = ['Db', 'Deb', 'DebQ'] as const
const CREDIT_PLAIN = ['Cre', 'Credit', 'CreQ'] as const
const DEBIT_FOREIGN = ['DebQ'] as const
const CREDIT_FOREIGN = ['CreQ'] as const

/**
 * Map one parsed operation row to a StatementItem. `account` is our own account
 * (the file's `GENERAL.ACC` or a caller override); `statementCurrency` is the
 * detected file currency. Income/expense: a positive debit → расход (`debit`),
 * otherwise приход (`credit`) — the reference importer's rule.
 */
export function normalizeClientBankRow(row: ClientBankRow, account: string, statementCurrency: string): StatementItem {
  const rowCurrency = ALPHA3.test((row.I2 ?? '').trim()) ? row.I2!.trim() : statementCurrency
  const isForeign = rowCurrency !== '' && rowCurrency !== 'BYN'

  const debitPlain = money(firstOf(row, DEBIT_PLAIN))
  const direction: OperationDirection = debitPlain > 0 ? 'debit' : 'credit'
  const amount = direction === 'debit'
    ? money(firstOf(row, isForeign ? DEBIT_FOREIGN : DEBIT_PLAIN))
    : money(firstOf(row, isForeign ? CREDIT_FOREIGN : CREDIT_PLAIN))

  // Payment purpose is split across Nazn/Nazn2 (a long value continues into the
  // second field mid-word) — concatenate verbatim, no separator, matching the
  // source importer.
  const purpose = `${row.Nazn ?? ''}${row.Nazn2 ?? ''}`.trim()

  // `bank` (counterparty bank NAME) is intentionally unset: the client-bank text
  // format carries only the counterparty bank BIC (`Cod`), not its name — unlike
  // Alfa/Prior, whose APIs return the name.
  const counterparty: StatementParty = {
    name: (row.KorName ?? '').trim(),
    unp: digitsOnly(row.KorUNP ?? row.UNNRec ?? ''),
    account: (row.Acc ?? '').trim(),
    ...(row.Cod ? { bic: row.Cod.trim() } : {})
  }

  const acceptDate = clientBankDateToIso(row.OpDate)
  const operDate = clientBankDateToIso(row.DocDate)

  return {
    account,
    docId: rowDocId(row),
    ...(row.Num ? { docNum: row.Num.trim() } : {}),
    direction,
    amount,
    currency: rowCurrency,
    purpose,
    counterparty,
    acceptDate,
    // Only when the operation date differs from the acceptance date.
    ...(operDate && operDate !== acceptDate.slice(0, 10) ? { operDate } : {}),
    ...(row.Opr ? { operCodeName: row.Opr.trim() } : {})
  }
}

/**
 * Normalize a whole parsed statement into StatementItem[]. `ctx.account`
 * overrides the file's own account (`GENERAL.ACC`); `ctx.currency` seeds the
 * currency detection when the file carries no marker. Only `OUT_PARAM` rows are
 * operations (`IN_PARAM` is the request echo).
 */
export function normalizeClientBankStatement(parsed: ClientBankParsed, ctx: NormalizeContext): StatementItem[] {
  const account = ctx.account || parsed.GENERAL.ACC || ''
  const currency = detectStatementCurrency(parsed, ctx.currency)
  return parsed.OUT_PARAM.items.map(row => normalizeClientBankRow(row, account, currency))
}

/** The `manual` / client-bank-text implementation of the unified
 * `StatementNormalizer` contract (`raw, ctx → StatementItem[]`), where `raw` is
 * the `parseClientBankText` output. See app/types/statement.ts. */
export const normalizeClientBank: StatementNormalizer<ClientBankParsed> = normalizeClientBankStatement
