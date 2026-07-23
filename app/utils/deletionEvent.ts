// Pure parser + classifier for Bitrix24 CRM deletion events (#109, PROCESSING.md §9.2).
// Turns a verified deletion webhook payload into a typed `DeletionRef` the consumer reconciles
// the SP-ledger against (recompute «осталось распределить», mark «требует распределения»).
//
// Events we bind (§9.2): `ONCRMDEALDELETE` (deal), `ONCRMCOMPANYDELETE` (company), and
// `ONCRMDYNAMICITEMDELETE` (any smart-process element — our payment-carrier SP, our distributions
// SP, AND smart-invoices, distinguished by `ENTITY_TYPE_ID`). Deals/companies do NOT fire the
// dynamic event (they have their own), so all three codes are needed.
//
// The payload carries only `{ID[, ENTITY_TYPE_ID]}` (the entity is already deleted — no field
// values) + `auth` + `ts`; authenticity is the SAME `application_token` gate as install/uninstall
// (verified upstream, `b24Events.ts`). No I/O here — the REST reconciliation is the consumer slice.

import { eventCode } from './b24Events'
import { B24_DELETION_EVENTS, SMART_INVOICE_ENTITY_TYPE_ID } from '~/config/b24'

export { B24_DELETION_EVENTS, SMART_INVOICE_ENTITY_TYPE_ID }
export type B24DeletionEvent = typeof B24_DELETION_EVENTS[number]

/** Semantic kind of a deleted entity, deciding how the consumer reconciles (§9.2):
 *  - `deal`/`invoice` — an allocation AMOUNT-target: find distributions on it, free them;
 *  - `company` — the payment-carrier's my-company/client: responsible/scope lost → error chat;
 *  - `payment-carrier` — our payment-СП element (the carrier): §5 structure damage → error chat;
 *  - `distribution` — our dist-СП child (a ledger row deleted by an admin): recompute the parent;
 *  - `other` — an unrelated dynamic type → ignored (not our ledger). */
export type DeletionEntityKind = 'deal' | 'company' | 'invoice' | 'payment-carrier' | 'distribution' | 'other'

/** A parsed deletion — the entity's semantic kind + its id (+ the raw entityTypeId for dynamic
 *  items, so the consumer can query the right smart-process). */
export interface DeletionRef {
  kind: DeletionEntityKind
  id: string
  /** Present only for a dynamic-item (`ONCRMDYNAMICITEMDELETE`) deletion. */
  entityTypeId?: number
}

/** The portal's configured SP entityTypeIds — needed to tell OUR smart processes apart from any
 *  other dynamic type when classifying an `ONCRMDYNAMICITEMDELETE`. From portal settings. */
export interface DeletionSpConfig {
  /** entityTypeId of OUR payment-carrier smart process (the element that holds the payment). This
   *  is a type WE provision (§9), distinct from the user's `smart-entity` allocation target — the
   *  consumer MUST resolve it through `paymentSpEtid(configFields)` (`PAYMENT_SP_CONFIG_KEY`,
   *  `app/config/distributionSp.ts`), the single source, so carrier choice / deletion-classify /
   *  ledger write never disagree on which SP is the carrier. */
  paymentSpEtid?: number
  /** entityTypeId of OUR distributions smart process (the child ledger items) — likewise resolved
   *  through `distributionSpEtid(configFields)` (`DISTRIBUTION_SP_CONFIG_KEY`). */
  distributionSpEtid?: number
  /** TYPE id of OUR payment-carrier SP — needed (with the entityTypeId) to build the full `SpRef` the
   *  ledger reconcile requires (field names key off the type id, §9.1). Classification uses the
   *  entityTypeIds above; the reconcile transport needs the refs. */
  paymentSpId?: number
  /** TYPE id of OUR distributions SP (see `paymentSpId`). */
  distributionSpId?: number
}

/** Read `data.FIELDS` from a (bracket-parsed) deletion payload. */
function fieldsOf(payload: unknown): Record<string, unknown> {
  const data = (payload as { data?: unknown } | null)?.data
  const fields = (data as { FIELDS?: unknown } | null)?.FIELDS
  return fields && typeof fields === 'object' ? fields as Record<string, unknown> : {}
}

/** Classify a dynamic-item deletion by its entityTypeId against the fixed invoice type and the
 *  portal's configured SP ids. An unconfigured/unknown type is `other` (ignored — fail-safe). */
function classifyDynamic(entityTypeId: number, cfg: DeletionSpConfig): DeletionEntityKind {
  if (entityTypeId === SMART_INVOICE_ENTITY_TYPE_ID) return 'invoice'
  if (cfg.paymentSpEtid && entityTypeId === cfg.paymentSpEtid) return 'payment-carrier'
  if (cfg.distributionSpEtid && entityTypeId === cfg.distributionSpEtid) return 'distribution'
  return 'other'
}

/**
 * Classify a deletion from ALREADY-EXTRACTED raw fields (event code + optional dynamic
 * entityTypeId) against the portal's SP config, or `null` when it's not a deletion we handle / a
 * dynamic item with an invalid entityTypeId. Shared by `parseDeletionRef` (webhook ingestion) and
 * the queue consumer (which classifies from the enqueued `DeletionJob` once it has the SP config).
 */
export function classifyDeletionKind(
  rawEventCode: string,
  entityTypeId: number | undefined,
  cfg: DeletionSpConfig
): DeletionEntityKind | null {
  const code = (rawEventCode || '').toUpperCase()
  if (code === 'ONCRMDEALDELETE') return 'deal'
  if (code === 'ONCRMCOMPANYDELETE') return 'company'
  if (code === 'ONCRMDYNAMICITEMDELETE') {
    if (!Number.isInteger(entityTypeId) || (entityTypeId as number) <= 0) return null
    return classifyDynamic(entityTypeId as number, cfg)
  }
  return null // not a deletion event we bound
}

/**
 * Parse a verified deletion webhook payload into a `DeletionRef`, or `null` when it is not a
 * deletion event we handle / has no usable id. `cfg` supplies the portal's SP entityTypeIds so a
 * dynamic-item deletion is classified (invoice / our carrier / our distribution / other). Pure —
 * the payload is already `parseBracketForm`-decoded and `application_token`-verified upstream.
 */
export function parseDeletionRef(payload: unknown, cfg: DeletionSpConfig = {}): DeletionRef | null {
  const code = eventCode(payload)
  const fields = fieldsOf(payload)
  // `ID` must be a scalar digit string — a bracket-parsed body could nest an object/array on the
  // field (`String({})` = "[object Object]"), and B24 ids are always positive integers. Reject
  // non-scalar / non-digit fail-closed (same discipline as `auth` fields and `ENTITY_TYPE_ID`),
  // so a malformed/hostile payload is dropped instead of enqueuing a pointless reconcile job.
  const rawId = fields.ID
  if (typeof rawId !== 'string' && typeof rawId !== 'number') return null
  const id = String(rawId).trim()
  if (!/^\d+$/.test(id)) return null

  const isDynamic = (code || '').toUpperCase() === 'ONCRMDYNAMICITEMDELETE'
  const entityTypeId = isDynamic ? Number(fields.ENTITY_TYPE_ID) : undefined
  const kind = classifyDeletionKind(code, entityTypeId, cfg)
  if (!kind) return null
  return isDynamic ? { kind, id, entityTypeId } : { kind, id }
}

/**
 * Whether a parsed deletion is relevant to the ledger — i.e. worth enqueuing a reconcile job. An
 * `other` dynamic type (some unrelated smart process) is dropped so we don't scan the ledger for
 * a deletion that can't touch it. `deal`/`invoice`/`company`/`payment-carrier`/`distribution` are
 * all relevant (each triggers a distinct §9.2 reaction).
 */
export function isRelevantDeletion(ref: DeletionRef): boolean {
  return ref.kind !== 'other'
}
