// Provisioning transport for the two distribution smart processes (#109, PROCESSING.md §9.1,
// slice 3). Idempotent: probes `crm.type.list`, creates each SP only when absent (recovering a
// known/renamed one by stored config or stable title), then adds only the MISSING user fields
// (`userfieldconfig.list` → `planMissingUserFields`). Returns both entityTypeIds so the caller
// stores them in `recognition.configFields` (PAYMENT_SP_CONFIG_KEY / DISTRIBUTION_SP_CONFIG_KEY).
//
// DI over the injected `call` (a portal-bound RestCall) — unit-testable with a fake. Telemetry:
// each B24 call already flows through the SDK transport's `withDependencySpan` (b24Sdk.ts), so the
// individual `crm.type.*` / `userfieldconfig.*` calls are timed as dependency spans without any
// extra wrapping here; the compound provisioning is wrapped in a job/cron span by its caller.

import {
  DISTRIBUTION_SP_FIELDS,
  DISTRIBUTION_SP_TITLE,
  PAYMENT_SP_FIELDS,
  PAYMENT_SP_TITLE,
  buildDistributionSpCreateCall,
  buildPaymentSpCreateCall,
  buildSpEntityId,
  planMissingUserFields,
  type SpUserField
} from '../../app/config/distributionSp'
import { extractSmartProcessTypes, findSmartProcessByTitle } from '../../app/utils/distributionCarrier'
import type { RestCall } from './companyLookup'

/** Known (stored) entityTypeIds, so a re-run skips the probe/create when already provisioned. */
export interface KnownSpIds {
  paymentSpEtid?: number | null
  distributionSpEtid?: number | null
}

/** Outcome of a provisioning run — the resolved ids + what changed (for logging / storage).
 *  ⚠ The caller must ALWAYS persist `paymentSpEtid`/`distributionSpEtid` to `configFields`
 *  (an idempotent `app.option` write): `created*:false` covers BOTH "id was already known
 *  (passed in `known`)" AND "id was recovered by title (not yet stored)", so the flags cannot
 *  drive the persist decision — they are for logging only. */
export interface ProvisionResult {
  paymentSpEtid: number
  distributionSpEtid: number
  /** True only when this run created the payment SP (vs known/recovered) — logging signal. */
  createdPaymentSp: boolean
  /** True only when this run created the distributions SP — logging signal. */
  createdDistributionSp: boolean
  /** How many user fields this run added across both SPs (0 ⇒ fully provisioned already). */
  addedFields: number
}

/** Method that lists the portal's smart-process types (probe for existing SP by title). */
export const CRM_TYPE_LIST_METHOD = 'crm.type.list'
/** Method that lists user-field configs (probe for existing fields on an SP). */
export const USERFIELDCONFIG_LIST_METHOD = 'userfieldconfig.list'
/** Page-loop backstop: a portal with more pages than this of either list is pathological; the
 *  cap only bounds a runaway loop (a mis-behaving `next`), it is not an expected limit. */
export const MAX_LIST_PAGES = 100

/** Read the `next` page offset from a B24 list response (present only when total > page size);
 *  a non-integer/absent value ends pagination. */
function nextOffset(resp: Record<string, unknown>): number | null {
  const n = Number((resp as { next?: unknown })?.next)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Extract the `entityTypeId` of a newly created SP from a `crm.type.add` response
 *  (`{result:{type:{entityTypeId}}}`); `null` on a malformed/empty body. */
export function extractCreatedEntityTypeId(resp: Record<string, unknown>): number | null {
  const result = resp?.result
  const type = (result as { type?: unknown } | undefined)?.type
  const raw = (type as { entityTypeId?: unknown } | undefined)?.entityTypeId
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Pull the `fieldName`s already present on an SP from a `userfieldconfig.list` response
 *  (`{result:{fields:[{fieldName}]}}`), tolerant of shape. */
export function extractExistingFieldNames(resp: Record<string, unknown>): string[] {
  const result = resp?.result as { fields?: unknown } | undefined
  const fields = result?.fields
  if (!Array.isArray(fields)) return []
  const names: string[] = []
  for (const f of fields) {
    const name = (f as { fieldName?: unknown })?.fieldName
    if (typeof name === 'string' && name) names.push(name)
  }
  return names
}

/** List ALL smart-process types across pages (`crm.type.list` is paginated: >50 types → `next`
 *  offset). Merges every page into one `{result:{types:[…]}}` shape so `findSmartProcessByTitle`
 *  scans the whole portal — else our SP on page 2 is missed and a DUPLICATE is created. */
async function listAllSmartProcessTypes(call: RestCall): Promise<Record<string, unknown>> {
  const all: unknown[] = []
  let start: number | null = 0
  for (let page = 0; page < MAX_LIST_PAGES && start !== null; page++) {
    const params: Record<string, unknown> = start ? { start } : {}
    const resp = await call(CRM_TYPE_LIST_METHOD, params)
    for (const t of extractSmartProcessTypes(resp)) all.push(t)
    start = nextOffset(resp)
  }
  return { result: { types: all } }
}

/** List ALL existing field names on an SP across pages (`userfieldconfig.list` is paginated). A
 *  present field on page 2 would otherwise be re-planned and rejected as a duplicate. */
async function listAllFieldNames(call: RestCall, etid: number): Promise<string[]> {
  const names: string[] = []
  let start: number | null = 0
  for (let page = 0; page < MAX_LIST_PAGES && start !== null; page++) {
    const params: Record<string, unknown> = { moduleId: 'crm', filter: { entityId: buildSpEntityId(etid) } }
    if (start) params.start = start
    const resp = await call(USERFIELDCONFIG_LIST_METHOD, params)
    for (const n of extractExistingFieldNames(resp)) names.push(n)
    start = nextOffset(resp)
  }
  return names
}

/** Resolve an SP's entityTypeId: use the stored id if given, else find it by stable title among
 *  the (already fully paginated) types, else create it. Returns the id + whether we created it. */
async function ensureSp(
  call: RestCall,
  known: number | null | undefined,
  allTypes: Record<string, unknown>,
  title: string,
  createCall: { method: string, params: Record<string, unknown> }
): Promise<{ etid: number, created: boolean }> {
  if (known && Number.isInteger(known) && known > 0) return { etid: known, created: false }
  const found = findSmartProcessByTitle(allTypes, title)
  if (found) return { etid: found, created: false }
  const createdResp = await call(createCall.method, createCall.params)
  const etid = extractCreatedEntityTypeId(createdResp)
  if (!etid) throw new Error(`crm.type.add returned no entityTypeId for "${title}"`)
  return { etid, created: true }
}

/** Ensure every field in `fields` exists on the SP `etid`, creating only the missing ones. Returns
 *  the number of fields added. */
async function ensureFields(call: RestCall, etid: number, fields: readonly SpUserField[]): Promise<number> {
  const existing = await listAllFieldNames(call, etid)
  const toAdd = planMissingUserFields(etid, fields, existing)
  for (const addCall of toAdd) await call(addCall.method, addCall.params) // sequential — rate-safe, no batch
  return toAdd.length
}

/**
 * Provision (or self-heal) both distribution smart processes idempotently and return their
 * entityTypeIds. `known` lets a re-run skip the probe/create for an SP whose id is already stored.
 * A transport error propagates (the caller — install/cron — decides retry). Order: payment SP
 * first, then distributions SP (the child ledger references the payment carrier at write time).
 *
 * ⚠ Caller obligations: (1) run SINGLE-FLIGHT per portal — there is no advisory lock here, so two
 * concurrent runs that both miss the title probe would create DUPLICATE SPs (install is single-shot;
 * a scaled-cron path must serialize, e.g. the pg advisory lock used by `ensureAccessToken`);
 * (2) inject the SDK-backed `RestCall` so each call is `withDependencySpan`-timed, and wrap the whole
 * op in the caller's job/cron span (`withSpan('cron.provision-sp', …)`) for a root; (3) always
 * persist the returned etids (see `ProvisionResult`).
 */
export async function provisionDistributionSp(call: RestCall, known: KnownSpIds = {}): Promise<ProvisionResult> {
  const knownPayment = known.paymentSpEtid && known.paymentSpEtid > 0
  const knownDistribution = known.distributionSpEtid && known.distributionSpEtid > 0
  // Probe the type list ONCE (paginated) only when at least one id is unknown — reused for both.
  const allTypes = knownPayment && knownDistribution ? { result: { types: [] } } : await listAllSmartProcessTypes(call)

  const payment = await ensureSp(call, known.paymentSpEtid, allTypes, PAYMENT_SP_TITLE, buildPaymentSpCreateCall())
  const distribution = await ensureSp(call, known.distributionSpEtid, allTypes, DISTRIBUTION_SP_TITLE, buildDistributionSpCreateCall())

  const addedPayment = await ensureFields(call, payment.etid, Object.values(PAYMENT_SP_FIELDS))
  const addedDistribution = await ensureFields(call, distribution.etid, Object.values(DISTRIBUTION_SP_FIELDS))

  return {
    paymentSpEtid: payment.etid,
    distributionSpEtid: distribution.etid,
    createdPaymentSp: payment.created,
    createdDistributionSp: distribution.created,
    addedFields: addedPayment + addedDistribution
  }
}
