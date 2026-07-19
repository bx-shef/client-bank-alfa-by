// Pure builders + constants for the two distribution smart processes (#109, PROCESSING.md §9.1).
// No I/O — the `crm.type.add` / `userfieldconfig.add` execution + entityTypeId storage are the
// provisioning transport slice; these builders are unit-testable and the single source of the
// SP shape (titles = stable markers, field codes, create-call params).
//
// Two SPs:
//  - PAYMENT carrier: the element that holds an incoming payment. NO stages (§9: state is the
//    read-only «осталось распределить» field, not a stage), client + my-company enabled (§2
//    Этап C links both companies), automation ON (fires the «платёж получен» trigger, #79).
//  - DISTRIBUTIONS ledger: one child element per allocation. NO stages, minimal — it is an
//    accounting row (amount = `opportunity`, links to the payment + target, marker for idempotency).

/** Stable titles — used both as the created SP title AND as the fallback marker to recover the
 *  entityTypeId (`findSmartProcessByTitle`) when the stored per-portal config is missing. */
export const PAYMENT_SP_TITLE = 'Импорт выписки: платежи'
export const DISTRIBUTION_SP_TITLE = 'Импорт выписки: распределения'

/** A user field to create on an SP. B24 requires the field NAME to embed the object's
 *  entityTypeId (`UF_CRM_<entityTypeId>_<postfix>`) — assigned per portal — so we store the
 *  POSTFIX here and build the full name at provisioning time via `buildUfFieldName`. `userTypeId`
 *  is REQUIRED by `userfieldconfig.add` (a field can't be created from a name alone). */
export interface SpUserField {
  /** POSTFIX only; full name = `UF_CRM_<entityTypeId>_<postfix>`. */
  postfix: string
  /** B24 user-field type: `double` (money), `boolean` (Y/N), `string`, `integer`. */
  userTypeId: 'double' | 'boolean' | 'string' | 'integer'
  /** Human label (edit-form). */
  label: string
}

/** User fields on the PAYMENT-carrier SP. `opportunity` (amount) and the client/my-company links
 *  are BUILT-IN smart-process fields (from the `is*Enabled` flags) — not created here. */
export const PAYMENT_SP_FIELDS = {
  /** Read-only «осталось распределить» (money) — amount minus Σ active distributions. */
  needDistributionsSum: { postfix: 'NEED_DISTR', userTypeId: 'double', label: 'Осталось распределить' },
  /** «требует распределения» (Y/N) — set when a manual target changed/was deleted (§3/§9.2). */
  requiresRedistribution: { postfix: 'NEEDS_REDISTR', userTypeId: 'boolean', label: 'Требует распределения' },
  /** Dedup marker = the operation key (idempotent write-once carrier per operation). */
  marker: { postfix: 'MARKER', userTypeId: 'string', label: 'Маркер операции' }
} as const satisfies Record<string, SpUserField>

/** User fields on the DISTRIBUTIONS SP (one child = one allocation). */
export const DISTRIBUTION_SP_FIELDS = {
  /** Allocation target kind (`invoice`/`deal-payment`/…). */
  targetKind: { postfix: 'TARGET_KIND', userTypeId: 'string', label: 'Тип цели' },
  /** Allocation target id. */
  targetId: { postfix: 'TARGET_ID', userTypeId: 'string', label: 'ID цели' },
  /** How it was made: `auto` | `manual` (§3 reconcile distinction). */
  source: { postfix: 'SOURCE', userTypeId: 'string', label: 'Источник' },
  /** `active` | `reverted` (сторно keeps history; not a stage). */
  status: { postfix: 'STATUS', userTypeId: 'string', label: 'Статус' },
  /** Idempotency marker = allocation fact key (payment key + target kind + id). */
  marker: { postfix: 'MARKER', userTypeId: 'string', label: 'Маркер факта' }
} as const satisfies Record<string, SpUserField>

/** Build the full B24 user-field name for a smart-process field: `UF_CRM_<entityTypeId>_<postfix>`
 *  (the format `userfieldconfig.add` requires — the object's entityTypeId is embedded). */
export function buildUfFieldName(entityTypeId: number, postfix: string): string {
  return `UF_CRM_${entityTypeId}_${postfix}`
}

/** `crm.type.add` params for the PAYMENT-carrier SP. Stages OFF (§9), client + my-company ON,
 *  automation ON (trigger). entityTypeId is assigned by B24 (read back from the response). */
export function buildPaymentSpCreateCall(): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.type.add',
    params: {
      fields: {
        title: PAYMENT_SP_TITLE,
        isStagesEnabled: false,
        isCategoriesEnabled: false,
        isClientEnabled: true,
        isMycompanyEnabled: true,
        isAutomationEnabled: true,
        isBizProcEnabled: false,
        isRecyclebinEnabled: true
      }
    }
  }
}

/** `crm.type.add` params for the DISTRIBUTIONS ledger SP. Stages OFF, no client/my-company (it is
 *  a child accounting row linked to the payment element), automation OFF. */
export function buildDistributionSpCreateCall(): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.type.add',
    params: {
      fields: {
        title: DISTRIBUTION_SP_TITLE,
        isStagesEnabled: false,
        isCategoriesEnabled: false,
        isClientEnabled: false,
        isMycompanyEnabled: false,
        isAutomationEnabled: false,
        isBizProcEnabled: false,
        isRecyclebinEnabled: true
      }
    }
  }
}

/** All user-field codes we create, per SP — the provisioning transport iterates these to
 *  `userfieldconfig.add` each missing one (idempotent by field name). */
export const DISTRIBUTION_SP_USER_FIELDS = {
  payment: Object.values(PAYMENT_SP_FIELDS),
  distribution: Object.values(DISTRIBUTION_SP_FIELDS)
} as const

// ─── Per-portal entityTypeId storage (single source of truth) ───────────────────────────────────
// BOTH SPs are OUR OWN provisioned types (the ledger, §9) — distinct from the user's `smart-entity`
// recognition target (`SMART_ENTITY_CONFIG_KEY`, the smart process a payment may be ALLOCATED to).
// The provisioning transport (slice 3) reads back each `entityTypeId` from `crm.type.add` and stores
// it in `recognition.configFields` under these reserved keys; every consumer (carrier choice,
// deletion classify, ledger write) resolves the id THROUGH the accessors below so there is one
// source and no divergence.

/** Config key holding our PAYMENT-carrier SP's entityTypeId (in `recognition.configFields`). */
export const PAYMENT_SP_CONFIG_KEY = 'payment-sp'
/** Config key holding our DISTRIBUTIONS SP's entityTypeId (in `recognition.configFields`). */
export const DISTRIBUTION_SP_CONFIG_KEY = 'distribution-sp'

/** Coerce a stored config value to a positive-integer entityTypeId, or `null` when
 *  absent/blank/non-numeric (fail-closed — a misconfigured value never matches a real type). */
function coerceEntityTypeId(raw: string | undefined): number | null {
  if (!raw) return null
  const n = Number(String(raw).trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Our payment-carrier SP entityTypeId from portal config (`null` when not provisioned). */
export function paymentSpEtid(configFields: Record<string, string> | undefined): number | null {
  return coerceEntityTypeId(configFields?.[PAYMENT_SP_CONFIG_KEY])
}

/** Our distributions SP entityTypeId from portal config (`null` when not provisioned). */
export function distributionSpEtid(configFields: Record<string, string> | undefined): number | null {
  return coerceEntityTypeId(configFields?.[DISTRIBUTION_SP_CONFIG_KEY])
}
