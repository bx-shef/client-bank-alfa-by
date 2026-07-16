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
//
// Two entry points share steps 1–2: `findCompanyByAccount` (the counterparty by
// their account) and `findMyCompanyByAccount` (OUR company by OUR account — Этап C,
// same resolution + an `isMyCompany='Y'` filter). «My company» is a Company with
// `isMyCompany='Y'` (confirmed live), not a separate entity.

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

/** One command in a batch: a method + its params (like a single `RestCall`). */
export interface BatchCommand { method: string, params?: Record<string, unknown> }

/** A batched REST caller bound to one portal: run many independent commands in ONE
 *  round-trip and return their envelopes IN THE SAME ORDER as the input. Same error
 *  CONTRACT as `RestCall` — it MUST throw/reject if the batch fails OR any single command
 *  in it fails (halt-on-error), so a caller that would fail the job on a sequential error
 *  fails identically on a batched one (no silent per-command miss). Used to collapse an
 *  independent-call fan-out (e.g. per-funnel `crm.status.list`) into one request (#191). */
export type RestBatch = (calls: BatchCommand[]) => Promise<Record<string, unknown>[]>

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

/** `crm.item.list` params to keep only the «my company» rows among `companyIds`.
 *  `isMyCompany='Y'` is the flag that marks a Company as one of our own (Этап C). */
export function myCompanyFilter(companyIds: string[]): Record<string, unknown> {
  return { entityTypeId: CRM_ENTITY_TYPE_COMPANY, filter: { id: companyIds, isMyCompany: 'Y' }, select: ['id'] }
}

/** Pull the `id`s out of a `crm.item.list` response (`{result:{items:[{id}]}}`),
 *  tolerating a missing/!array `items`. Distinct from `extractEntityIds`, which
 *  reads the upper-cased `ENTITY_ID` of the requisite/bank-detail list methods. */
export function extractItemIds(resp: Record<string, unknown>): string[] {
  const items = (resp?.result as Record<string, unknown> | undefined)?.items
  if (!Array.isArray(items)) return []
  const ids: string[] = []
  for (const row of items) {
    const id = (row as Record<string, unknown>)?.id
    if (id !== undefined && id !== null && `${id}` !== '') ids.push(`${id}`)
  }
  return ids
}

/**
 * Resolve the CRM company ids that own a settlement account (steps 1–2, shared by
 * both entry points): bank detail (`RQ_ACC_NUM`→`RQ_IIK` fallback) → requisite →
 * company. Returns EVERY matching company id (usually one; `RQ_ACC_NUM` is NOT
 * unique — confirmed live — so several companies on one account is a real case).
 * Empty array = no company. A transport error from `call` propagates.
 *
 * Orphan bank details of a DELETED company still turn up at step 1, but step 2
 * (`crm.requisite.list` filtered by `ENTITY_TYPE_ID=4`) returns nothing for their
 * now-parentless requisite — CONFIRMED LIVE — so a dead company is never resolved
 * (through EITHER entry point); the account simply reads as no-company.
 */
export async function resolveCompanyIdsByAccount(account: string, call: RestCall): Promise<string[]> {
  const acc = normalizeAccount(account)
  if (!acc) return []

  let requisiteIds: string[] = []
  for (const field of ACCOUNT_FIELDS) {
    const resp = await call('crm.requisite.bankdetail.list', bankDetailFilter(acc, field))
    requisiteIds = extractEntityIds(resp)
    if (requisiteIds.length) break
  }
  if (!requisiteIds.length) return []

  const companies = await call('crm.requisite.list', requisiteFilter(requisiteIds))
  return extractEntityIds(companies)
}

/**
 * Find the CRM company id for a counterparty account, or `null` if none matches.
 * Returns the FIRST matching company (`RQ_ACC_NUM` not unique — see
 * `resolveCompanyIdsByAccount`; picking the first is the accepted default,
 * docs/PROCESSING.md §4). A `null` result means no company matched — crm-sync then
 * counts the operation `unmatched` and writes nothing (a todo needs an owner),
 * retrying on a later poll once a company exists. Never throws for "not found"; a
 * transport error from `call` propagates to the caller.
 */
export async function findCompanyByAccount(account: string, call: RestCall): Promise<string | null> {
  const companyIds = await resolveCompanyIdsByAccount(account, call)
  return companyIds[0] ?? null
}

/**
 * Find MY company (`isMyCompany='Y'`) for OUR settlement account — Этап C
 * (docs/PROCESSING.md §2): resolve the companies that own the account, then keep
 * only the one flagged as ours. Returns the first my-company id, or `null` when the
 * account resolves to no company or to only client companies (not ours) — the
 * caller treats a `null` here as «моя компания не найдена» → error chat (§5).
 * Skips the extra REST call when step 1–2 found nothing. Transport errors propagate.
 *
 * NB (open, docs/PROCESSING.md §8): if OUR account somehow resolves to more than one
 * `isMyCompany` company, we currently take the first SILENTLY — the cost of a wrong
 * "my company" (it sets the owner / where the deal is written) is higher than for a
 * counterparty, so the crm-sync wiring should decide whether to escalate that to the
 * error chat. Also, "our account" is near-constant per portal — the wiring should
 * cache this lookup rather than re-run 3 REST calls for every operation in a batch.
 */
export async function findMyCompanyByAccount(account: string, call: RestCall): Promise<string | null> {
  const companyIds = await resolveCompanyIdsByAccount(account, call)
  if (!companyIds.length) return null
  const mine = await call('crm.item.list', myCompanyFilter(companyIds))
  return extractItemIds(mine)[0] ?? null
}
