// Resolve a CRM company from a statement counterparty's settlement account.
//
// Bitrix24 stores a company's bank accounts on its REQUISITE's BANK DETAILS:
//   company ──(requisite)──> crm.requisite ──(bank detail)──> crm.requisite.bankdetail
// A bank detail's ENTITY_ID points at the requisite it belongs to; a requisite's
// ENTITY_TYPE_ID/ENTITY_ID point at the CRM object (company = 4). So the lookup is:
//   1. crm.requisite.bankdetail.list  filter {RQ_ACC_NUM: acc}  → requisite ids (ENTITY_ID)
//   2. crm.requisite.list  filter {ID: [ids], ENTITY_TYPE_ID: 4}  → company id (ENTITY_ID)
//
// Belarusian portals often keep the account in RQ_IIK (ИИК) rather than RQ_ACC_NUM,
// so step 1 falls back to RQ_IIK when RQ_ACC_NUM yields nothing. Everything here is
// pure over an injected `call(method, params)` so it unit-tests without the network.

/** CRM entity type id for a Company (Lead=1, Deal=2, Contact=3, Company=4). */
export const CRM_ENTITY_TYPE_COMPANY = 4

/** Bank-detail fields that may hold the account number, tried in order. */
export const ACCOUNT_FIELDS = ['RQ_ACC_NUM', 'RQ_IIK'] as const

/** A REST caller bound to one portal (host + fresh access token already applied).
 *  CONTRACT: it MUST throw/reject on a transport or REST error. A resolved value
 *  is treated as a success body — if a wrapper instead resolves with B24's error
 *  shape (`{error, error_description}`, no `result`), this lookup reads it as
 *  "nothing found" and returns null, indistinguishable from a real miss. The
 *  intended binding (`callRest` over `$fetch`) throws on HTTP 4xx, satisfying this. */
export type RestCall = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>

/** Normalize an account for matching: trim and drop internal whitespace. B24
 *  stores accounts without spaces; statements sometimes group digits. */
export function normalizeAccount(account: string): string {
  return account.replace(/\s+/g, '').trim()
}

/** Pull the `ENTITY_ID` list out of a `*.list` REST response (as strings).
 *  Tolerates a missing/!array `result` and rows without the field. */
export function extractEntityIds(resp: Record<string, unknown>): string[] {
  const rows = resp?.result
  if (!Array.isArray(rows)) return []
  const ids: string[] = []
  for (const row of rows) {
    const id = (row as Record<string, unknown>)?.ENTITY_ID
    if (id !== undefined && id !== null && `${id}` !== '') ids.push(`${id}`)
  }
  return ids
}

/** Bank-detail filter for one account field (e.g. `{ RQ_ACC_NUM: '...' }`). */
export function bankDetailFilter(account: string, field: string): Record<string, unknown> {
  return { filter: { [field]: account }, select: ['ENTITY_ID'] }
}

/** Requisite filter restricting to COMPANY requisites with the given ids.
 *  An array value on `ID` is a standard IN-filter for CRM list methods. */
export function requisiteFilter(requisiteIds: string[]): Record<string, unknown> {
  return { filter: { ID: requisiteIds, ENTITY_TYPE_ID: CRM_ENTITY_TYPE_COMPANY }, select: ['ENTITY_ID'] }
}

/**
 * Find the CRM company id for a counterparty account, or `null` if none matches.
 * Returns the FIRST matching company. NB (confirmed live): `RQ_ACC_NUM` is NOT
 * unique — the same settlement account can sit on several companies' bank details,
 * so multiple matches are a real (if uncommon) case; picking the first is the
 * accepted default (see docs/PROCESSING.md §4). Orphan bank details of a DELETED
 * company still turn up at step 1, but step 2 (`crm.requisite.list` filtered by
 * `ENTITY_TYPE_ID=4`) returns nothing for their now-parentless requisite — CONFIRMED
 * LIVE — so a dead company can't be resolved (the account just reads as unmatched).
 * A `null` result means no company matched — crm-sync then counts
 * the operation `unmatched` and writes nothing (a todo needs an owner), retrying on
 * a later poll once a company exists. Never throws for "not found"; a transport
 * error from `call` propagates to the caller.
 */
export async function findCompanyByAccount(account: string, call: RestCall): Promise<string | null> {
  const acc = normalizeAccount(account)
  if (!acc) return null

  let requisiteIds: string[] = []
  for (const field of ACCOUNT_FIELDS) {
    const resp = await call('crm.requisite.bankdetail.list', bankDetailFilter(acc, field))
    requisiteIds = extractEntityIds(resp)
    if (requisiteIds.length) break
  }
  if (!requisiteIds.length) return null

  const companies = await call('crm.requisite.list', requisiteFilter(requisiteIds))
  const companyIds = extractEntityIds(companies)
  return companyIds[0] ?? null
}
