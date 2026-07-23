// Pure carrier selection for a payment operation (#109, PROCESSING.md §2 Этап D / §9). A portal
// whose tariff SUPPORTS smart processes carries each payment as an SP ELEMENT (the partial-
// distribution ledger, §9); one that doesn't carries it as a configurable ACTIVITY (дело).
//
// Tariff up/downgrade affects ONLY new operations — existing carriers are NEVER migrated
// (PROCESSING.md §2: «уже созданные дела остаются; при даунгрейде накопленные элементы СП не
// удаляем»). That invariant needs no state here: the choice is made per NEW operation from the
// CURRENT facts, and existing operations keep whatever carrier they were written with (their B24
// dedup marker already identifies them). No I/O — the crm.type.list probe that produces the facts,
// and the provisioning that follows `shouldProvisionSp`, are transport slices.

/** What a payment operation is written as. */
export type PaymentCarrier = 'smart-process' | 'activity'

/** Facts about the portal, read once per job (crm.type.list probe + our stored SP config). */
export interface CarrierContext {
  /** Does the portal's tariff support smart processes at all? `false` ⇒ activity only. */
  smartProcessSupported: boolean
  /** Is OUR payment-carrier SP provisioned (its entityTypeId is known AND the type exists)? */
  paymentSpPresent: boolean
}

/**
 * Choose the carrier for a NEW operation: an SP element only when smart processes are BOTH
 * supported AND our carrier SP is provisioned; otherwise a configurable activity. On a downgrade
 * (`smartProcessSupported` flips to false) this returns `activity` for new ops while existing SP
 * elements are left untouched; on an upgrade (SP becomes present) new ops get `smart-process`
 * while old дела stay — both handled by deciding per operation, no migration.
 */
export function chooseCarrier(ctx: CarrierContext): PaymentCarrier {
  return ctx.smartProcessSupported && ctx.paymentSpPresent ? 'smart-process' : 'activity'
}

/**
 * Whether SP provisioning should be ATTEMPTED now: the tariff supports smart processes but our
 * carrier SP isn't present yet (fresh install, or a re-upgrade after a downgrade, or §5 structure
 * self-heal). When false, either the tariff can't (nothing to do → activity) or it's already
 * provisioned (nothing to do → use it). The actual `crm.type.add` is the transport slice.
 */
export function shouldProvisionSp(ctx: CarrierContext): boolean {
  return ctx.smartProcessSupported && !ctx.paymentSpPresent
}

/** One smart-process type row as returned by `crm.type.list` (only the fields we read). Both ids are
 *  read: `entityTypeId` (for `crm.item.*`) and `id` (the type id, for `userfieldconfig`/field names). */
export interface SmartProcessTypeRow {
  entityTypeId?: unknown
  id?: unknown
  title?: unknown
}

/** Pull the `types` array out of a `crm.type.list` response (tolerant to shape). */
export function extractSmartProcessTypes(resp: Record<string, unknown>): SmartProcessTypeRow[] {
  const result = resp?.result as Record<string, unknown> | undefined
  const types = result?.types
  return Array.isArray(types) ? (types as SmartProcessTypeRow[]) : []
}

/**
 * Find OUR smart process among a `crm.type.list` result by its exact `title` (a stable marker we
 * set at creation), returning its `entityTypeId` (positive integer) or `null` if not found. Used
 * to recover the entityTypeId when our stored config is missing (e.g. after a portal restore) —
 * the primary source stays the per-portal setting; this is the fallback probe. Title match is
 * exact + trimmed; a renamed type won't be found (then we re-provision, which is idempotent by
 * title). Pure over the response.
 */
export function findSmartProcessByTitle(resp: Record<string, unknown>, title: string): number | null {
  const wanted = title.trim()
  if (!wanted) return null
  for (const row of extractSmartProcessTypes(resp)) {
    if (String(row.title ?? '').trim() !== wanted) continue
    const etid = Number(row.entityTypeId)
    if (Number.isInteger(etid) && etid > 0) return etid
  }
  return null
}

/**
 * Find OUR smart process by title and return its FULL ref (`entityTypeId` + type `id`) or `null`.
 * Provisioning needs BOTH: entityTypeId for `crm.item.*`, id for `userfieldconfig`/UF field names
 * (live-confirmed the field APIs key off the type id, not the entityTypeId). Both must be positive
 * integers or the row is skipped (a type missing either id is unusable). Pure over the response.
 */
export function findSmartProcessRefByTitle(resp: Record<string, unknown>, title: string): { entityTypeId: number, id: number } | null {
  const wanted = title.trim()
  if (!wanted) return null
  for (const row of extractSmartProcessTypes(resp)) {
    if (String(row.title ?? '').trim() !== wanted) continue
    const entityTypeId = Number(row.entityTypeId)
    const id = Number(row.id)
    if (Number.isInteger(entityTypeId) && entityTypeId > 0 && Number.isInteger(id) && id > 0) {
      return { entityTypeId, id }
    }
  }
  return null
}
