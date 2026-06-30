import type { StatementItem } from '~/types/statement'
import { directionFromOperType } from '~/utils/statement'

// Maps Alfa-Bank's `/accounts/statement` response (partner.accounts 1.2.0) onto
// our normalized StatementItem. Pure; unit-tested against the swagger shape.

/** `transactions` query values for `/accounts/statement` (request config). */
export const ALFA_TRANSACTIONS = { all: 0, credit: 1, debit: 2 } as const

/** Subset of Alfa's `Statement` swagger model we consume. */
export interface AlfaStatementRow {
  number: string
  /** `C` (credit / приход) or `D` (debit / расход). */
  operType?: string
  operCodeName?: string
  /** Document execution date, `DD.MM.YYYY`. */
  operDate?: string
  /** Operation timestamp, `2023-01-13T14:00:00.000` — Alfa local time WITHOUT a
   * timezone offset. `new Date()` would parse it as local; the engine must apply
   * the portal TZ (UTC+3) before using it as a CRM deadline (see issue). */
  acceptDate?: string
  docId?: string
  docNum?: string
  amount?: number
  /** Symbolic currency code, e.g. `BYN`. */
  currIso?: string
  purpose?: string
  corrName?: string
  corrUnp?: string
  corrNumber?: string
  corrBic?: string
  corrBank?: string
}

/** Per-account error in a statement response. */
export interface AlfaStatementError {
  number?: string
  message?: string
}

/** Alfa `/accounts/statement` response (the fields we read). */
export interface AlfaStatementResponse {
  page?: AlfaStatementRow[]
  /** Per-account errors — a non-empty `errors` with an empty `page` means the
   * request partly/fully failed (e.g. expired token). The transport MUST check
   * this (see alfaStatementErrors); normalizeAlfaStatement ignores it. */
  errors?: AlfaStatementError[]
  /** Per-account balances/turnovers — not modeled yet (surface when needed). */
  statistics?: unknown[]
}

/**
 * Convert Alfa's `DD.MM.YYYY` date to ISO `YYYY-MM-DD`. ISO-looking input (the
 * `acceptDate` timestamp) is passed through trimmed; an unrecognized format is
 * returned as-is (not validated); empty input yields `''`.
 */
export function alfaDateToIso(value: string | undefined): string {
  if (!value) return ''
  const dmy = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim())
  return dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : value.trim()
}

/** Map one Alfa statement row to our normalized StatementItem. A non-numeric or
 * NaN `amount` is coerced to 0 (never propagate NaN into arithmetic). */
export function normalizeAlfaRow(row: AlfaStatementRow): StatementItem {
  const rawAmount = typeof row.amount === 'number' ? row.amount : Number(row.amount ?? 0)
  return {
    account: (row.number ?? '').trim(),
    docId: (row.docId ?? '').trim(),
    docNum: row.docNum?.trim() || undefined,
    direction: directionFromOperType(row.operType),
    amount: Number.isFinite(rawAmount) ? rawAmount : 0,
    currency: (row.currIso ?? '').trim(),
    purpose: (row.purpose ?? '').trim(),
    counterparty: {
      name: (row.corrName ?? '').trim(),
      unp: (row.corrUnp ?? '').trim(),
      account: (row.corrNumber ?? '').trim(),
      bank: row.corrBank?.trim() || undefined,
      bic: row.corrBic?.trim() || undefined
    },
    acceptDate: (row.acceptDate ?? '').trim(),
    operDate: row.operDate ? alfaDateToIso(row.operDate) : undefined,
    operCodeName: row.operCodeName?.trim() || undefined
  }
}

/** Normalize a full Alfa statement response into our StatementItem list. Ignores
 * `errors[]` by design — call alfaStatementErrors() to surface them. */
export function normalizeAlfaStatement(raw: AlfaStatementResponse): StatementItem[] {
  return (raw.page ?? []).map(normalizeAlfaRow)
}

/** Per-account errors from a statement response (empty when none). The transport
 * should check this and not treat an errored empty page as "no operations". */
export function alfaStatementErrors(raw: AlfaStatementResponse): AlfaStatementError[] {
  return raw.errors ?? []
}
