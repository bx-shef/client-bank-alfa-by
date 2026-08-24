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

/** A smart process reference. B24 gives an SP TWO ids: `entityTypeId` (large, used for `crm.item.*`
 *  and the `parentId<entityTypeId>` link) and `id` (the small ordinal from `crm.type.list`). USER
 *  FIELDS on an SP are keyed by the `id`, NOT the entityTypeId: `userfieldconfig` `entityId` is
 *  `CRM_<id>` and the field name is `UF_CRM_<id>_<postfix>` (live-confirmed on the test portal:
 *  `CRM_<entityTypeId>` → "not allowed", `CRM_<id>` → works, and the id-named field round-trips
 *  through `crm.item.*` addressed by `entityTypeId`). So every field-name/entityId builder takes the
 *  `id`, while item calls take the `entityTypeId`. */
export interface SpRef {
  /** entityTypeId — for `crm.item.*` `entityTypeId` and `parentId<entityTypeId>`. */
  entityTypeId: number
  /** type id (crm.type.list ordinal) — for `userfieldconfig` `entityId`/field names (`CRM_<id>`). */
  id: number
}

/** A user field to create on an SP. B24 requires the field NAME to embed the SP's type `id`
 *  (`UF_CRM_<id>_<postfix>`) — assigned per portal — so we store the POSTFIX here and build the full
 *  name at provisioning time via `buildUfFieldName`. `userTypeId` is REQUIRED by `userfieldconfig.add`
 *  (a field can't be created from a name alone). */
export interface SpUserField {
  /** POSTFIX only; full name = `UF_CRM_<id>_<postfix>`. */
  postfix: string
  /** B24 user-field type: `double` (number), `boolean` (Y/N), `string`, `integer`, `date`. */
  userTypeId: 'double' | 'boolean' | 'string' | 'integer' | 'date'
  /** Human label (edit-form). */
  label: string
  /** Optional `userfieldconfig.add` `settings`. For `double` MONEY fields we set `{ PRECISION: 2 }`:
   *  a plain double ROUNDS to integer (600.5→601 — live-confirmed), which would corrupt kopecks; with
   *  PRECISION:2 it stores 600.55 correctly. */
  settings?: Record<string, unknown>
}

/** User fields on the PAYMENT-carrier SP. The built-in `opportunity`/`currencyId` are NOT writable on a
 *  smart-process item (live-confirmed — they stay 0/portal-default), so we keep the payment TOTAL +
 *  currency in our OWN fields; the client/my-company links ARE built-in (from the `is*Enabled` flags). */
export const PAYMENT_SP_FIELDS = {
  /** The payment's full amount — our own money field (opportunity isn't writable on an SP). */
  total: { postfix: 'TOTAL', userTypeId: 'double', label: 'Сумма платежа', settings: { PRECISION: 2 } },
  /** ISO currency of the payment (our own field; currencyId isn't writable on an SP). */
  currency: { postfix: 'CURRENCY', userTypeId: 'string', label: 'Валюта' },
  /** Read-only «осталось распределить» (money) — amount minus Σ active distributions. */
  needDistributionsSum: { postfix: 'NEED_DISTR', userTypeId: 'double', label: 'Осталось распределить', settings: { PRECISION: 2 } },
  /** «требует распределения» (Y/N) — set when a manual target changed/was deleted (§3/§9.2). */
  requiresRedistribution: { postfix: 'NEEDS_REDISTR', userTypeId: 'boolean', label: 'Требует распределения' },
  /** Dedup marker = the operation key (idempotent write-once carrier per operation). */
  marker: { postfix: 'MARKER', userTypeId: 'string', label: 'Маркер операции' },

  // ─── Registry fields (#575) ───────────────────────────────────────────────────────────────────
  // ⚠ The SP is named «Импорт выписки: платежи» and the owner expects a REGISTRY of payments —
  // every operation searchable and filterable in CRM. Until #575 it held only the money fields,
  // because an element was written ONLY when an allocation succeeded; the rest of the statement
  // (who paid, when, what for) lived solely in the activity's prose. These carry it as DATA.
  /** Operation date — the axis the registry is sorted and filtered by, so it is a real `date`, not
   *  text: only a typed field gives the CRM list a calendar range picker, and finding «платежи с 1
   *  по 15 августа» is the whole point of a registry.
   *  ⚠ It is fed the DATE COMPONENT ONLY (`acceptDate.slice(0,10)`), never the raw instant. Measured
   *  on a live portal 2026-08-22: B24 converts a timestamp into the PORTAL's timezone before taking
   *  the date, so `2026-08-21T23:30:00Z` lands on 22 August — an off-by-one on a booking date, which
   *  for an accountant is a wrong day, not a rounding detail. A bare `YYYY-MM-DD` round-trips
   *  literally, whatever the portal's zone. The bank states a calendar date; reinterpreting it
   *  through zones is wrong in principle, not merely risky. */
  operationDate: { postfix: 'OP_DATE', userTypeId: 'date', label: 'Дата операции' },
  /** Direction — приход/расход as TEXT.
   *  ⚠ `boolean` was rejected because an SP boolean reads as «да/нет» in the list, and `enumeration`
   *  because it does not work here: measured 2026-08-22 — `userfieldconfig.add` accepted the field
   *  but registered no inline `list` items, and `crm.item.add` given the text «Приход» stored `0`.
   *  A silently-wrong stored value is worse than a plain string, and doing it properly would mean
   *  resolving per-portal enum item ids on every write. Two values do not earn that. */
  direction: { postfix: 'DIRECTION', userTypeId: 'string', label: 'Направление' },
  /** Counterparty name as the bank spelled it (NOT the CRM company — that is the `companyId` link). */
  counterparty: { postfix: 'COUNTERPARTY', userTypeId: 'string', label: 'Контрагент' },
  /** Counterparty settlement account — what `findCompanyByAccount` searches by; the one fact that
   *  turns «клиент не определён» into a fixable task (paste it into the company's requisite). */
  counterpartyAccount: { postfix: 'CP_ACCOUNT', userTypeId: 'string', label: 'Счёт контрагента' },
  /** Counterparty УНП, when the bank supplied it. */
  counterpartyUnp: { postfix: 'CP_UNP', userTypeId: 'string', label: 'УНП контрагента' },
  /** Payment purpose — the text the recognition matrices read (§4). */
  purpose: { postfix: 'PURPOSE', userTypeId: 'string', label: 'Назначение платежа' },
  /** OUR account the operation belongs to — the registry is filtered by it. */
  ownAccount: { postfix: 'OWN_ACCOUNT', userTypeId: 'string', label: 'Наш счёт' },
  /** The bank the operation came from. ⚠ Data, NOT part of the dedup key: the key is written into
   *  every activity marker already created, and widening it would unstick them all and re-create
   *  the whole history as duplicates. The account number already encodes the bank; the field exists
   *  so the registry, the erase action and the poll pause can filter by it (agreed 2026-08-22). */
  bank: { postfix: 'BANK', userTypeId: 'string', label: 'Банк' }
} as const satisfies Record<string, SpUserField>

/** User fields on the DISTRIBUTIONS SP (one child = one allocation). */
export const DISTRIBUTION_SP_FIELDS = {
  /** The parent PAYMENT carrier element id. Our OWN filterable field — NOT the native `parentId<etid>`
   *  link: our two SPs have no configured parent-child relationship, so the native link doesn't exist
   *  and is rejected in filters (live-confirmed). An integer field we write + filter/select by. */
  parentPayment: { postfix: 'PARENT_PAYMENT', userTypeId: 'integer', label: 'Платёж (родитель)' },
  /** The allocated amount — our own money field (opportunity isn't writable on an SP; §9 recompute
   *  sums THIS, not the built-in opportunity which stays 0). */
  amount: { postfix: 'AMOUNT', userTypeId: 'double', label: 'Сумма', settings: { PRECISION: 2 } },
  /** ISO currency of the allocation (our own field). */
  currency: { postfix: 'CURRENCY', userTypeId: 'string', label: 'Валюта' },
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

/** Build the full B24 user-field name for a smart-process field: `UF_CRM_<id>_<postfix>` where `id`
 *  is the SP's TYPE id (crm.type.list ordinal), NOT the entityTypeId — the format `userfieldconfig.add`
 *  requires and that `crm.item.*` (addressed by entityTypeId) then reads/writes (live-confirmed). */
export function buildUfFieldName(spTypeId: number, postfix: string): string {
  return `UF_CRM_${spTypeId}_${postfix}`
}

/**
 * Имя поля так, как его ХРАНИТ портал: `UF_CRM<id>_<POSTFIX>` — БЕЗ подчёркивания после `CRM`.
 *
 * ⚠ Это не то же самое, что `buildUfFieldName` (`UF_CRM_<id>_<POSTFIX>`), которым поле СОЗДАЁТСЯ:
 * портал нормализует имя при создании, и обратно читается уже слитная форма. Замерено на живом
 * портале 2026-08-23: `crm.item.fields` отдаёт `ufCrm7OpDate`, а настройка карточки принимает и
 * возвращает `UF_CRM7_OP_DATE`. Настройке карточки нужна именно эта форма — с формой создания она
 * поля просто не найдёт и молча покажет пустой раздел.
 */
export function buildUfStoredFieldName(spTypeId: number, postfix: string): string {
  return `UF_CRM${spTypeId}_${postfix}`
}

/**
 * Раскладка карточки элемента реестра платежей (#27).
 *
 * ⚠ Зачем вообще: поля на элементе БЫЛИ и были подписаны по-русски, но карточка их не показывала —
 * портал рисует раскладку по умолчанию, и клиент, моя компания, сумма, дата и назначение в неё не
 * попадали. То есть реестр держал данные, которые человек не видел.
 *
 * ⚠ `scope: 'C'` — общая настройка на всех пользователей портала, а не личная настройка того, кто
 * нажал кнопку: иначе бухгалтер увидел бы прежнюю пустую карточку.
 *
 * Порядок разделов — порядок вопросов к платежу: что это → между кем → откуда → что осталось.
 */
export function buildPaymentCardConfigCall(paymentSp: SpRef): { method: string, params: Record<string, unknown> } {
  const f = (postfix: string) => buildUfStoredFieldName(paymentSp.id, postfix)
  const F = PAYMENT_SP_FIELDS
  return {
    method: 'crm.item.details.configuration.set',
    params: {
      entityTypeId: paymentSp.entityTypeId,
      scope: 'C',
      data: [
        {
          name: 'payment',
          title: 'Платёж',
          type: 'section',
          elements: [
            { name: f(F.operationDate.postfix), optionFlags: 1 },
            { name: f(F.direction.postfix), optionFlags: 1 },
            { name: f(F.total.postfix), optionFlags: 1 },
            { name: f(F.currency.postfix), optionFlags: 1 },
            { name: f(F.purpose.postfix), optionFlags: 1 }
          ]
        },
        {
          name: 'parties',
          title: 'Стороны',
          type: 'section',
          elements: [
            // ⚠ Стандартные поля связи — они уже включены флагами типа (`isClientEnabled`,
            // `isMycompanyEnabled`), но в раскладку по умолчанию не попадали.
            { name: 'COMPANY_ID', optionFlags: 1 },
            { name: 'MYCOMPANY_ID', optionFlags: 1 },
            { name: f(F.counterparty.postfix), optionFlags: 1 },
            { name: f(F.counterpartyAccount.postfix), optionFlags: 1 },
            { name: f(F.counterpartyUnp.postfix) }
          ]
        },
        {
          name: 'source',
          title: 'Источник',
          type: 'section',
          elements: [
            { name: f(F.ownAccount.postfix), optionFlags: 1 },
            { name: f(F.bank.postfix), optionFlags: 1 },
            { name: f(F.marker.postfix) },
            { name: 'CREATED_TIME' }
          ]
        },
        {
          name: 'distribution',
          title: 'Распределение',
          type: 'section',
          elements: [
            { name: f(F.needDistributionsSum.postfix), optionFlags: 1 },
            { name: f(F.requiresRedistribution.postfix) }
          ]
        }
      ]
    }
  }
}

/** The CAMELCASE B24 user-field name `crm.item.*` uses for read/write/FILTER (its default when
 *  `useOriginalUfNames` is not 'Y'). Live-confirmed: filtering by the ORIGINAL `UF_CRM_<id>_<postfix>`
 *  name returns EMPTY even with `useOriginalUfNames:'Y'`, but the camelCase name matches — so the ledger
 *  addresses fields by THIS name. Rule (probed): `UF_CRM_<id>_<A_B>` → `ufCrm<id><Pascal(A)><Pascal(B)>`
 *  (each underscore-segment of the postfix PascalCased): `MARKER`→`Marker`, `NEED_DISTR`→`NeedDistr`. */
export function buildUfFieldNameCamel(spTypeId: number, postfix: string): string {
  const pascal = postfix
    .split('_')
    .map(seg => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
    .join('')
  return `ufCrm${spTypeId}${pascal}`
}

/** Build the smart-process `entityId` a UF is created against: `CRM_<id>` (the SP's TYPE id) — the
 *  `userfieldconfig.add` `field.entityId` format for smart processes. NOT `CRM_<entityTypeId>`
 *  (live-confirmed: the entityTypeId form is rejected with "not allowed to view custom field settings"). */
export function buildSpEntityId(spTypeId: number): string {
  return `CRM_${spTypeId}`
}

/** Build a `userfieldconfig.add` call that creates one user field on a smart process. The field
 *  name + entityId embed the SP's TYPE id (`CRM_<id>` / `UF_CRM_<id>_<postfix>`) and the type is
 *  required; the RU label is set as `editFormLabel`. Idempotency is the caller's
 *  (`planMissingUserFields` skips fields that already exist — B24 rejects a duplicate fieldName). */
export function buildUfFieldConfigCall(spTypeId: number, field: SpUserField): { method: string, params: Record<string, unknown> } {
  return {
    method: 'userfieldconfig.add',
    params: {
      moduleId: 'crm',
      field: {
        entityId: buildSpEntityId(spTypeId),
        fieldName: buildUfFieldName(spTypeId, field.postfix),
        userTypeId: field.userTypeId,
        editFormLabel: { ru: field.label },
        // Money fields (double) carry `{ PRECISION: 2 }` — a plain double rounds to integer (live-confirmed).
        ...(field.settings ? { settings: field.settings } : {})
      }
    }
  }
}

/** Plan the `userfieldconfig.add` calls needed to bring a smart process's fields up to date:
 *  one call per field whose full name is NOT already present (`existingFieldNames`, from
 *  `userfieldconfig.list`). `spTypeId` is the SP's TYPE id (field names are keyed by it). Idempotent —
 *  a re-run after all fields exist plans nothing, so provisioning self-heals a partially-created SP. */
export function planMissingUserFields(
  spTypeId: number,
  fields: readonly SpUserField[],
  existingFieldNames: readonly string[]
): { method: string, params: Record<string, unknown> }[] {
  const present = new Set(existingFieldNames)
  return fields
    .filter(f => !present.has(buildUfFieldName(spTypeId, f.postfix)))
    .map(f => buildUfFieldConfigCall(spTypeId, f))
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
/** Config key holding our PAYMENT-carrier SP's TYPE id (needed for `userfieldconfig`/field names). */
export const PAYMENT_SP_ID_CONFIG_KEY = 'payment-sp-id'
/** Config key holding our DISTRIBUTIONS SP's TYPE id (needed for `userfieldconfig`/field names). */
export const DISTRIBUTION_SP_ID_CONFIG_KEY = 'distribution-sp-id'

/** Coerce a stored config value to a positive integer, or `null` when
 *  absent/blank/non-numeric (fail-closed — a misconfigured value never matches a real type). */
function coercePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null
  const n = Number(String(raw).trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Our payment-carrier SP entityTypeId from portal config (`null` when not provisioned). */
export function paymentSpEtid(configFields: Record<string, string> | undefined): number | null {
  return coercePositiveInt(configFields?.[PAYMENT_SP_CONFIG_KEY])
}

/** Our distributions SP entityTypeId from portal config (`null` when not provisioned). */
export function distributionSpEtid(configFields: Record<string, string> | undefined): number | null {
  return coercePositiveInt(configFields?.[DISTRIBUTION_SP_CONFIG_KEY])
}

/** Our payment-carrier SP TYPE id from portal config (`null` when not provisioned). */
export function paymentSpTypeId(configFields: Record<string, string> | undefined): number | null {
  return coercePositiveInt(configFields?.[PAYMENT_SP_ID_CONFIG_KEY])
}

/** Our distributions SP TYPE id from portal config (`null` when not provisioned). */
export function distributionSpTypeId(configFields: Record<string, string> | undefined): number | null {
  return coercePositiveInt(configFields?.[DISTRIBUTION_SP_ID_CONFIG_KEY])
}

/** Resolve a full {@link SpRef} (entityTypeId + type id) for the PAYMENT SP, or `null` when either
 *  part is missing (fail-closed — the ledger needs BOTH: entityTypeId for items, id for field names). */
export function paymentSpRef(configFields: Record<string, string> | undefined): SpRef | null {
  const entityTypeId = paymentSpEtid(configFields)
  const id = paymentSpTypeId(configFields)
  return entityTypeId !== null && id !== null ? { entityTypeId, id } : null
}

/** Resolve a full {@link SpRef} for the DISTRIBUTIONS SP, or `null` when either part is missing. */
export function distributionSpRef(configFields: Record<string, string> | undefined): SpRef | null {
  const entityTypeId = distributionSpEtid(configFields)
  const id = distributionSpTypeId(configFields)
  return entityTypeId !== null && id !== null ? { entityTypeId, id } : null
}

/** Merge the two provisioned SP refs (entityTypeId + type id each) INTO a `configFields` map (returns
 *  a NEW object — never mutates the input), stored as strings under the reserved keys. Provisioning
 *  calls this after `provisionDistributionSp` to persist the ids; idempotent (same ids ⇒ same map). */
export function withSpProvision(
  configFields: Record<string, string> | undefined,
  payment: SpRef,
  distribution: SpRef
): Record<string, string> {
  return {
    ...(configFields ?? {}),
    [PAYMENT_SP_CONFIG_KEY]: String(payment.entityTypeId),
    [PAYMENT_SP_ID_CONFIG_KEY]: String(payment.id),
    [DISTRIBUTION_SP_CONFIG_KEY]: String(distribution.entityTypeId),
    [DISTRIBUTION_SP_ID_CONFIG_KEY]: String(distribution.id)
  }
}

/** Whether `configFields` already stores BOTH provisioned SP refs COMPLETELY (entityTypeId AND type
 *  id for each) — the caller can skip a re-provision / settings write when true. */
export function hasSpEtids(configFields: Record<string, string> | undefined): boolean {
  return paymentSpRef(configFields) !== null && distributionSpRef(configFields) !== null
}

/** Портальный путь к списку элементов смарт-процесса (#109 §9.1 UI). Категория 0 — дефолтная
 *  воронка; у наших служебных СП направлений нет, поэтому она всегда одна. Чистая функция: сам
 *  переход делает вызывающий через `slider.openPath` (внутри портала) или обычной ссылкой. */
export function smartProcessListPath(entityTypeId: number): string {
  return `/crm/type/${entityTypeId}/list/category/0/`
}
