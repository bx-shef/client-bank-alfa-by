// Deal-payment candidates for an incoming bank payment (#109, PROCESSING.md §2).
// Given a KNOWN deal, list its payments (`crm.item.payment.list`) and map the
// allocatable ones to `AllocationCandidate` (kind `deal-payment`). Pure over an
// injected `RestCall` — unit-testable without the network.
//
// Field names confirmed LIVE against a real portal (seeded deal with a real
// crm.item.payment): the response is an array DIRECTLY in `result` (not
// `result.items`), each element `{ id, accountNumber, paid: 'Y'|'N', sum,
// currency, paySystemId, … }`. `id` is the payment RECORD id (→ `payment.pay`),
// `sum`/`currency` are the payment amount, `paid` its settlement status.
//
// SCOPE & IDOR — this resolves a deal-payment WHEN THE DEAL IS ALREADY KNOWN AND
// COMPANY-SCOPED. `crm.item.payment.list` filters ONLY by `entityId` (the deal) —
// it has no `companyId` field, so unlike `invoiceLookup`/`itemByIdLookup` the
// company scope is NOT enforced in the query here. The CALLER MUST pass a `dealId`
// it already validated belongs to the payer's company (a deal resolved via
// `itemByIdLookup.findCandidateById` with `companyId`, or a company-scoped deal
// scan). Passing a payer-controlled `dealId` unchecked would be an IDOR.
//
// A DEAL PROXIES ITS ORDER: `crm.item.payment.list(entityId=deal)` returns the
// order's payments (confirmed live — the same `id` as `sale.payment`, one `orderId`
// behind them). So "order payment" and "deal payment" are the same object; there is
// no separate order lookup. `order-number`/`payment-number` from a purpose (#172)
// resolve the IDOR-safe way via `findCompanyDealPayments` below: scan the payer
// company's OWN deals and match among their payments. A global `sale.payment.list`
// would find a payment by number, but its `sale.order` carries no deal/company
// binding (`companyId` is null for CRM-created orders), so it can't be tied back to
// the payer's company — the company-scoped scan is what keeps it IDOR-safe.
//
// NB: in `identifierDispatch` a `deal-id` routes to the `deal` trigger target, not
// to `deal-payment`. The crm-sync wiring slice branches: a resolved deal WITH a
// matching unpaid payment → `deal-payment` (this module); otherwise a bare `deal`
// trigger. So this module runs AFTER the deal is resolved, never with a raw
// identifier value from the purpose.

import type { AllocationCandidate } from '../../app/utils/allocation'
import type { RestCall } from './companyLookup'

/** CRM entityTypeId of a Deal (сделка) — the owner of its payments. */
export const DEAL_ENTITY_TYPE_ID = 2

export interface DealPaymentOptions {
  /** Include payments already marked paid (`paid: 'Y'`). Default `false` — a
   *  settled payment is not an allocation target (nothing left to `payment.pay`). */
  includePaid?: boolean
}

/** `crm.item.payment.list` params — payments of ONE deal. The method requires
 *  both `entityId` and `entityTypeId`; there is no cross-entity variant in `crm`.
 *  No `select`: the method does not document one — it returns the full short
 *  payment shape (`id`/`accountNumber`/`paid`/`sum`/`currency`/…) unconditionally. */
export function paymentListParams(dealId: number, entityTypeId: number = DEAL_ENTITY_TYPE_ID): Record<string, unknown> {
  return { entityId: dealId, entityTypeId }
}

interface RawPayment {
  id?: unknown
  accountNumber?: unknown
  paid?: unknown
  sum?: unknown
  currency?: unknown
}

/** Pull the payments array out of a `crm.item.payment.list` response. The list
 *  sits DIRECTLY in `result` (an array), unlike `crm.item.list`'s `result.items`. */
export function extractPayments(resp: Record<string, unknown>): RawPayment[] {
  const result = resp?.result
  return Array.isArray(result) ? (result as RawPayment[]) : []
}

/**
 * Find deal-payment allocation candidates for `dealId`, dropping payments that
 * are already settled (`paid: 'Y'`) unless `opts.includePaid`. Returns
 * `AllocationCandidate[]` (kind `deal-payment`, `amount` = `sum`, `currency`,
 * `id` = payment record id, `dealId` = the parent deal). Rows with a non-finite
 * `sum` are skipped (can't be matched by amount). A transport error from `call`
 * propagates; "no payments" is an empty array, never a throw.
 *
 * PRECONDITION: `dealId` MUST already be scoped to the payer's company (see the
 * file header — no company filter is possible in `crm.item.payment.list`).
 *
 * A blank / non-numeric / non-positive `dealId` yields `[]` without a REST call.
 * No pagination (`start`): a single deal's payments are expected to be a handful
 * of rows; if that ever grows past one page, page here before wiring into crm-sync.
 */
export async function findDealPayments(
  dealId: string,
  opts: DealPaymentOptions,
  call: RestCall
): Promise<AllocationCandidate[]> {
  const id = String(dealId).trim()
  const numericId = Number(id)
  if (!id || !Number.isInteger(numericId) || numericId <= 0) return []

  const resp = await call('crm.item.payment.list', paymentListParams(numericId))
  const out: AllocationCandidate[] = []
  for (const p of extractPayments(resp)) {
    const paid = String(p.paid ?? '').trim().toUpperCase() === 'Y'
    if (paid && !opts.includePaid) continue
    const amount = Number(p.sum)
    if (!Number.isFinite(amount)) continue
    const paymentId = p.id === undefined || p.id === null ? '' : String(p.id)
    if (!paymentId) continue
    // The payment's own `accountNumber` («<order>/<seq>», e.g. «1/2») — carried so a
    // recognized `payment-number` can be matched against a company-gathered pool
    // (`filterByAccountNumber`); omitted when absent to keep the field optional.
    const accountNumber = String(p.accountNumber ?? '').trim()
    out.push({
      kind: 'deal-payment',
      id: paymentId,
      amount,
      currency: String(p.currency ?? ''),
      dealId: id,
      ...(accountNumber ? { accountNumber } : {})
    })
  }
  return out
}

export interface CompanyDealPaymentOptions {
  /** Passed through to `findDealPayments` — include settled payments. */
  includePaid?: boolean
  /** Drop deals in a negative/lost stage before listing their payments (built by
   *  `stageLoader`). Omitted → every deal of the company is scanned. */
  isNegativeStage?: (stageId: string) => boolean
}

/** `crm.item.list` params — a company's OWN deals (the IDOR scope). Filtering by
 *  `companyId` in the query is what keeps another company's deals/payments out.
 *  `start` is the pagination offset (`crm.item.list` returns 50 rows per page and a
 *  top-level `total`; see `findCompanyDealPayments`). */
export function companyDealsParams(companyId: string, start: number = 0): Record<string, unknown> {
  return {
    entityTypeId: DEAL_ENTITY_TYPE_ID,
    filter: { companyId },
    select: ['id', 'stageId'],
    start
  }
}

/** Read the top-level `total` from a `crm.item.list` response (siblings of `result`,
 *  not inside it). Non-numeric / absent → `NaN`, which stops pagination after the
 *  current page (single-page fallback — the pre-pagination behaviour). */
export function dealListTotal(resp: Record<string, unknown>): number {
  return Number(resp?.total)
}

/** Hard cap on company-deal pages (50 rows each) — a runaway/DoS backstop far above
 *  any real company's deal count (60×50 = 3000 deals). Exported so the test can pin
 *  the bound without hard-coding the number. */
export const MAX_DEAL_PAGES = 60

interface RawDeal {
  id?: unknown
  stageId?: unknown
}

/** Pull the deal rows out of a `crm.item.list` response (`result.items`). */
export function extractDealRows(resp: Record<string, unknown>): RawDeal[] {
  const items = (resp?.result as Record<string, unknown> | undefined)?.items
  return Array.isArray(items) ? (items as RawDeal[]) : []
}

/**
 * Company-scoped deal-payment candidate pool (#109, PROCESSING.md §2). Lists the
 * payer company's OWN deals (`crm.item.list` filtered by `companyId` — the IDOR
 * scope), drops negative-stage deals, and aggregates each deal's payments via
 * `findDealPayments`. This is the IDOR-safe SCOPE for resolving `order-number`/
 * `payment-number` and the amount-matching source of §2 (match by amount+currency).
 * See the file header on why a global `sale.*` lookup can't be company-verified.
 *
 * `companyId` is the resolved client company (from the account). A blank one yields
 * `[]` without any REST call. A transport error propagates.
 *
 * CALLER NOTES (tie these up when wiring into crm-sync):
 * - `isNegativeStage` must recognise EVERY funnel: this lists deals across ALL
 *   categories, but a `stageLoader` predicate is built per-category (`DEAL_STAGE_<cat>`,
 *   stage ids carry a `C<cat>:` prefix). Pass a UNION of the negative stages of the
 *   company's deal categories, else a lost deal in another funnel slips into the pool.
 * - `payment-number` matching: each candidate carries its payment `accountNumber`
 *   («<order>/<seq>»), so a recognized `payment-number` matches via
 *   `filterByAccountNumber` (allocation.ts). `order-number` still needs the
 *   order↔payment relationship confirmed live before matching by prefix (#172).
 * - COST is N+1 (one `crm.item.list` PER PAGE + one `crm.item.payment.list` per deal),
 *   and `crm.item.payment.list` CANNOT be batched (`ERROR_BATCH_METHOD_NOT_ALLOWED`).
 *   The per-deal payment calls are run SEQUENTIALLY (concurrency 1) — rate-safe by
 *   construction; adding bounded concurrency (≈2 rps classic REST, §8) is deferred to
 *   the worker rate-limiter slice (#191, docs/QUEUES.md «REST-бюджет проводки»).
 *
 * PAGINATION: `crm.item.list` returns 50 rows per page and a top-level `total`. A
 * company with many historical deals exceeds one page, so this pages by `start` until
 * `total` is collected (or `MAX_DEAL_PAGES` — a runaway backstop). Without paging, the
 * overflow deals' payments would be silently dropped and an amount that lives there
 * would wrongly fall through to `manual`/`none`. When a response carries no numeric
 * `total` (e.g. a stub), paging stops after the first page (single-page fallback).
 */
export async function findCompanyDealPayments(
  companyId: string,
  opts: CompanyDealPaymentOptions,
  call: RestCall
): Promise<AllocationCandidate[]> {
  const cid = String(companyId).trim()
  if (!cid) return []

  const out: AllocationCandidate[] = []
  let start = 0
  let seen = 0
  for (let page = 0; page < MAX_DEAL_PAGES; page++) {
    const resp = await call('crm.item.list', companyDealsParams(cid, start))
    const rows = extractDealRows(resp)
    for (const deal of rows) {
      const stageId = deal.stageId === undefined || deal.stageId === null ? '' : String(deal.stageId)
      if (opts.isNegativeStage?.(stageId)) continue
      const dealId = deal.id === undefined || deal.id === null ? '' : String(deal.id)
      if (!dealId) continue
      out.push(...await findDealPayments(dealId, { includePaid: opts.includePaid }, call))
    }
    // Advance by rows returned (a full page = 50) and stop once `total` is collected.
    // An empty page or a non-numeric `total` ends the loop (single-page fallback).
    seen += rows.length
    const total = dealListTotal(resp)
    if (rows.length === 0 || !Number.isFinite(total) || seen >= total) break
    start += rows.length
  }
  return out
}
