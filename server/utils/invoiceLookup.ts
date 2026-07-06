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
    select: ['id', 'accountNumber', 'companyId', 'mycompanyId', 'stageId', 'opportunity', 'currencyId']
  }
}

interface RawInvoice {
  id?: unknown
  stageId?: unknown
  opportunity?: unknown
  currencyId?: unknown
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
 */
export async function findInvoicesByNumber(
  accountNumber: string,
  opts: InvoiceLookupOptions,
  call: RestCall
): Promise<AllocationCandidate[]> {
  const acc = accountNumber.trim()
  if (!acc) return []
  const resp = await call('crm.item.list', invoiceListParams(acc, opts.companyId))
  const out: AllocationCandidate[] = []
  for (const row of extractInvoiceItems(resp)) {
    const stageId = row.stageId === undefined || row.stageId === null ? '' : String(row.stageId)
    if (opts.isNegativeStage?.(stageId)) continue
    const amount = Number(row.opportunity)
    if (!Number.isFinite(amount)) continue
    const id = row.id === undefined || row.id === null ? '' : String(row.id)
    if (!id) continue
    out.push({ kind: 'invoice', id, amount, currency: String(row.currencyId ?? '') })
  }
  return out
}
