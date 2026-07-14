// Find Smart Invoice candidates for an incoming payment by its recognized number
// (#109, PROCESSING.md §2/§4). Pure over an injected `RestCall` — unit-testable
// without the network. Field names confirmed LIVE against a real portal
// (crm.item.fields entityTypeId=31): `accountNumber` (номер счёта), `companyId`
// (client company), `mycompanyId` (our company), `stageId`, `opportunity` (amount),
// `currencyId`. Negative-stage invoices (crm.status SEMANTICS='F', e.g. «Не
// оплачен» `DT31_11:D`) are excluded via the injected `isNegativeStage` predicate.

import type { AllocationCandidate } from '../../app/utils/allocation'
import type { RestCall } from './companyLookup'

/** CRM entityTypeId of a Smart Invoice (счёт). */
export const SMART_INVOICE_ENTITY_TYPE_ID = 31

export interface InvoiceLookupOptions {
  /** Restrict the search to this client company's invoices — IDOR scope: the
   *  payment's counterparty company, resolved earlier from its account. */
  companyId: string
  /** True for a stage we must NOT allocate to (crm.status SEMANTICS='F'). Built by
   *  the caller from crm.status.list. Omitted → keep every stage. */
  isNegativeStage?: (stageId: string) => boolean
}

/** `crm.item.list` params to find invoices by number within one company. Filtering
 *  by `companyId` in the query (not post-hoc) keeps other companies' invoices out. */
export function invoiceListParams(accountNumber: string, companyId: string): Record<string, unknown> {
  return {
    entityTypeId: SMART_INVOICE_ENTITY_TYPE_ID,
    filter: { accountNumber, companyId },
    // `parentId2` = the linked DEAL id (B24 `parentId<entityTypeId>` convention, 2 = deal;
    // live-confirmed: only the deal-linked invoice carries it, standalone invoices → null).
    // Lets `collapseSameTarget` merge an invoice with the same deal's payment (§2, #229).
    select: ['id', 'accountNumber', 'companyId', 'mycompanyId', 'stageId', 'opportunity', 'currencyId', 'parentId2']
  }
}

/** Normalize a raw `parentId<n>` link value to a positive-integer id string, or
 *  `undefined` when absent/null/0/non-numeric (no linked entity). */
export function parentDealId(raw: unknown): string | undefined {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? String(n) : undefined
}

// Only the fields this slice reads are typed. `accountNumber`/`companyId`/
// `mycompanyId` are requested in `select` as an intentional forward задел (the
// next slice matches «my company» by `mycompanyId`) — not read yet on purpose.
interface RawInvoice {
  id?: unknown
  stageId?: unknown
  opportunity?: unknown
  currencyId?: unknown
  /** Linked deal id (`parentId2`) — the smart-invoice→deal relationship. */
  parentId2?: unknown
}

/** Pull the `result.items` array out of a `crm.item.list` response (tolerant). */
export function extractInvoiceItems(resp: Record<string, unknown>): RawInvoice[] {
  const result = resp?.result as Record<string, unknown> | undefined
  const items = result?.items
  return Array.isArray(items) ? (items as RawInvoice[]) : []
}

/**
 * Find invoice allocation candidates for `accountNumber` in the given company,
 * dropping negative-stage invoices. Returns `AllocationCandidate[]` ready for
 * `resolveAllocation` (amount = `opportunity`, currency = `currencyId`). Rows with
 * a non-finite amount are skipped (can't be matched by amount). A transport error
 * from `call` propagates; "not found" is an empty array, never a throw.
 *
 * A blank `companyId` yields `[]` without a REST call — the IDOR scope must be a
 * real company (a blank filter could otherwise widen the match). Note: no
 * pagination (`start`) — one number within one company is expected to be a
 * handful of rows; if that ever grows, page here before wiring into crm-sync.
 */
export async function findInvoicesByNumber(
  accountNumber: string,
  opts: InvoiceLookupOptions,
  call: RestCall
): Promise<AllocationCandidate[]> {
  const acc = accountNumber.trim()
  if (!acc) return []
  if (!opts.companyId.trim()) return []
  const resp = await call('crm.item.list', invoiceListParams(acc, opts.companyId))
  const out: AllocationCandidate[] = []
  for (const row of extractInvoiceItems(resp)) {
    const stageId = row.stageId === undefined || row.stageId === null ? '' : String(row.stageId)
    if (opts.isNegativeStage?.(stageId)) continue
    const amount = Number(row.opportunity)
    if (!Number.isFinite(amount)) continue
    const id = row.id === undefined || row.id === null ? '' : String(row.id)
    if (!id) continue
    // Deal link (`parentId2`, live-confirmed, #229): lets `collapseSameTarget` merge this
    // invoice with the SAME deal's payment (one target, invoice preferred per §2) instead of
    // reading them as two → spurious `ambiguous`. Absent for a standalone invoice (→ undefined).
    // NB: the PAID-invoice re-match precondition is separately CLOSED — `buildPortalNegativeStagePredicate`
    //   loads invoices with `includeSettled:true`, so a settled `:P` (SEMANTICS='S') stage is in the
    //   exclusion set passed as `isNegativeStage` (drop at line 75). Mirrors paymentLookup's `paid:'Y'`.
    const dealId = parentDealId(row.parentId2)
    out.push({ kind: 'invoice', id, amount, currency: String(row.currencyId ?? ''), ...(dealId ? { dealId } : {}) })
  }
  return out
}
