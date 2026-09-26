import { describe, expect, it } from 'vitest'
import {
  DISTRIBUTION_SP_CONFIG_KEY,
  DISTRIBUTION_SP_FIELDS,
  DISTRIBUTION_SP_TITLE,
  DISTRIBUTION_SP_USER_FIELDS,
  PAYMENT_SP_CONFIG_KEY,
  PAYMENT_SP_FIELDS,
  PAYMENT_SP_TITLE,
  buildDistributionSpCreateCall,
  buildPaymentSpCreateCall,
  buildSpEntityId,
  buildUfFieldConfigCall,
  buildUfFieldName,
  buildUfFieldNameCamel,
  distributionSpEtid,
  hasSpEtids,
  paymentSpEtid,
  planMissingUserFields,
  withSpProvision,
  withStoredSpIds,
  keepStoredSpIds,
  mergeFormSettings,
  PAYMENT_SP_ID_CONFIG_KEY,
  DISTRIBUTION_SP_ID_CONFIG_KEY,
  PROVISIONED_SP_KEYS
} from '~/config/distributionSp'
import { defaultPortalSettings, parsePortalSettings, serializePortalSettings } from '~/utils/settings'

// Pure SP-structure builders (#109 §9.1). Assert the crm.type.add shape + field codes so the
// provisioning transport (and reviewers) have one source of truth for the SP shape.

describe('buildPaymentSpCreateCall', () => {
  it('creates the payment carrier SP: stages OFF, client + my-company ON, automation ON', () => {
    const { method, params } = buildPaymentSpCreateCall()
    expect(method).toBe('crm.type.add')
    const f = params.fields as Record<string, unknown>
    expect(f.title).toBe(PAYMENT_SP_TITLE)
    expect(f.isStagesEnabled).toBe(false) // §9: no stages, state is the «осталось» field
    expect(f.isCategoriesEnabled).toBe(false)
    expect(f.isClientEnabled).toBe(true)
    expect(f.isMycompanyEnabled).toBe(true)
    expect(f.isAutomationEnabled).toBe(true) // fires the payment trigger (#79)
    expect(f.isBizProcEnabled).toBe(false)
    expect(f.isRecyclebinEnabled).toBe(true)
  })
})

describe('buildDistributionSpCreateCall', () => {
  it('creates the distributions ledger SP: stages OFF, no client/my-company, automation OFF', () => {
    const { method, params } = buildDistributionSpCreateCall()
    expect(method).toBe('crm.type.add')
    const f = params.fields as Record<string, unknown>
    expect(f.title).toBe(DISTRIBUTION_SP_TITLE)
    expect(f.isStagesEnabled).toBe(false)
    expect(f.isCategoriesEnabled).toBe(false)
    expect(f.isClientEnabled).toBe(false)
    expect(f.isMycompanyEnabled).toBe(false)
    expect(f.isAutomationEnabled).toBe(false)
    expect(f.isBizProcEnabled).toBe(false)
    expect(f.isRecyclebinEnabled).toBe(true) // keep a recycle bin so accidental deletes are recoverable
  })
})

describe('buildUfFieldName', () => {
  it('embeds the per-portal TYPE id as userfieldconfig.add requires: UF_CRM_<id>_<postfix>', () => {
    expect(buildUfFieldName(44, 'NEED_DISTR')).toBe('UF_CRM_44_NEED_DISTR')
    expect(buildUfFieldName(46, 'MARKER')).toBe('UF_CRM_46_MARKER')
  })
})

describe('buildUfFieldNameCamel', () => {
  // The camelCase name crm.item.* uses for read/write/FILTER (filtering by the original name returns
  // empty — live-confirmed). Rule: ufCrm<id> + each underscore-segment of the postfix PascalCased.
  it('PascalCases each postfix segment: ufCrm<id><Seg><Seg>', () => {
    expect(buildUfFieldNameCamel(44, 'MARKER')).toBe('ufCrm44Marker')
    expect(buildUfFieldNameCamel(44, 'NEED_DISTR')).toBe('ufCrm44NeedDistr')
    expect(buildUfFieldNameCamel(46, 'TARGET_KIND')).toBe('ufCrm46TargetKind')
    expect(buildUfFieldNameCamel(46, 'PARENT_PAYMENT')).toBe('ufCrm46ParentPayment')
    expect(buildUfFieldNameCamel(46, 'NEEDS_REDISTR')).toBe('ufCrm46NeedsRedistr')
  })
})

describe('SP user fields', () => {
  it('every field carries a postfix, a userTypeId and a label', () => {
    for (const field of [...Object.values(PAYMENT_SP_FIELDS), ...Object.values(DISTRIBUTION_SP_FIELDS)]) {
      expect(field.postfix).toMatch(/^[A-Z0-9_]+$/)
      expect(['double', 'boolean', 'string', 'integer', 'date']).toContain(field.userTypeId)
      expect(field.label.length).toBeGreaterThan(0)
    }
  })
  it('payment SP carries need-distribution (money) / requires-redistribution (bool) / marker', () => {
    expect(PAYMENT_SP_FIELDS.needDistributionsSum.userTypeId).toBe('double')
    expect(PAYMENT_SP_FIELDS.requiresRedistribution.userTypeId).toBe('boolean')
    expect(PAYMENT_SP_FIELDS.marker.postfix).toBe('MARKER')
  })
  it('distributions SP carries target/source/status/marker', () => {
    expect(DISTRIBUTION_SP_FIELDS.targetKind.postfix).toBe('TARGET_KIND')
    expect(DISTRIBUTION_SP_FIELDS.targetId.postfix).toBe('TARGET_ID')
    expect(DISTRIBUTION_SP_FIELDS.source.postfix).toBe('SOURCE')
    expect(DISTRIBUTION_SP_FIELDS.status.postfix).toBe('STATUS')
    expect(DISTRIBUTION_SP_FIELDS.marker.postfix).toBe('MARKER')
  })
  it('a MARKER field exists on BOTH SPs by design (per-SP idempotency) — same postfix is fine, the', () => {
    // full name embeds each SP's own entityTypeId, so the codes never actually collide.
    expect(PAYMENT_SP_FIELDS.marker.postfix).toBe(DISTRIBUTION_SP_FIELDS.marker.postfix)
    expect(buildUfFieldName(1044, PAYMENT_SP_FIELDS.marker.postfix))
      .not.toBe(buildUfFieldName(1046, DISTRIBUTION_SP_FIELDS.marker.postfix))
  })
  it('all postfixes are unique within each SP', () => {
    const p = Object.values(PAYMENT_SP_FIELDS).map(f => f.postfix)
    const d = Object.values(DISTRIBUTION_SP_FIELDS).map(f => f.postfix)
    expect(new Set(p).size).toBe(p.length)
    expect(new Set(d).size).toBe(d.length)
  })
  it('DISTRIBUTION_SP_USER_FIELDS lists every field for provisioning', () => {
    expect(DISTRIBUTION_SP_USER_FIELDS.payment).toEqual(Object.values(PAYMENT_SP_FIELDS))
    expect(DISTRIBUTION_SP_USER_FIELDS.distribution).toEqual(Object.values(DISTRIBUTION_SP_FIELDS))
  })
})

describe('buildUfFieldConfigCall', () => {
  it('builds a userfieldconfig.add with entityId CRM_<etid>, the full field name, type and RU label', () => {
    const { method, params } = buildUfFieldConfigCall(1044, PAYMENT_SP_FIELDS.needDistributionsSum)
    expect(method).toBe('userfieldconfig.add')
    expect(params.moduleId).toBe('crm')
    const field = params.field as Record<string, unknown>
    expect(field.entityId).toBe('CRM_1044')
    expect(field.fieldName).toBe('UF_CRM_1044_NEED_DISTR')
    expect(field.userTypeId).toBe('double')
    expect(field.editFormLabel).toEqual({ ru: 'Осталось распределить' })
  })
})

describe('buildSpEntityId', () => {
  it('formats the smart-process entityId as CRM_<etid>', () => {
    expect(buildSpEntityId(1046)).toBe('CRM_1046')
  })
})

describe('planMissingUserFields', () => {
  const fields = Object.values(PAYMENT_SP_FIELDS)
  it('plans an add call only for fields not already present (idempotent self-heal)', () => {
    const existing = [buildUfFieldName(1044, PAYMENT_SP_FIELDS.needDistributionsSum.postfix)]
    const plan = planMissingUserFields(1044, fields, existing)
    expect(plan).toHaveLength(fields.length - 1)
    const names = plan.map(c => (c.params.field as Record<string, unknown>).fieldName)
    expect(names).not.toContain('UF_CRM_1044_NEED_DISTR')
    expect(names).toContain('UF_CRM_1044_MARKER')
  })
  it('plans nothing when every field already exists', () => {
    const existing = fields.map(f => buildUfFieldName(1044, f.postfix))
    expect(planMissingUserFields(1044, fields, existing)).toEqual([])
  })
  it('plans all fields when none exist', () => {
    expect(planMissingUserFields(1044, fields, [])).toHaveLength(fields.length)
  })

  // ⚠ Регресс #41: `userfieldconfig.list` отдаёт имя НЕ в той форме, какой поле создавали
  // (`UF_CRM_1044_TOTAL`), а в слитной (`UF_CRM1044_TOTAL`) или camel (`ufCrm1044Total`). Прямое
  // сравнение считало существующее поле отсутствующим → план пересоздавал доденьги → на дубликате
  // цикл падал → поля реестра #575 (в списке последние) не создавались никогда. Нормализация имени
  // это снимает. Каждая из трёх форм существующего поля должна распознаваться как «уже есть».
  it('распознаёт существующее поле в ЛЮБОЙ форме имени (слитной/camel/создания) — #41', () => {
    const stored = `UF_CRM1044_${PAYMENT_SP_FIELDS.total.postfix}` // UF_CRM1044_TOTAL
    const camel = 'ufCrm1044Total'
    const creation = buildUfFieldName(1044, PAYMENT_SP_FIELDS.total.postfix) // UF_CRM_1044_TOTAL
    for (const form of [stored, camel, creation]) {
      const plan = planMissingUserFields(1044, fields, [form])
      const names = plan.map(c => (c.params.field as Record<string, unknown>).fieldName)
      expect(names, `форма «${form}» не распознана как существующая`).not.toContain(creation)
      // остальные поля по-прежнему планируются — сверка не «проглатывает» всё
      expect(plan).toHaveLength(fields.length - 1)
    }
  })

  it('вся выписка полей #575 попадает в план на пустом СП (реестр не теряется) — #41', () => {
    const plan = planMissingUserFields(1044, fields, [])
    const names = plan.map(c => (c.params.field as Record<string, unknown>).fieldName)
    for (const key of ['operationDate', 'direction', 'counterparty', 'purpose', 'ownAccount', 'bank'] as const) {
      expect(names).toContain(buildUfFieldName(1044, PAYMENT_SP_FIELDS[key].postfix))
    }
  })

  // ⚠ Гард на КОЛЛИЗИИ нормализации (ревью #41): нормализация «без _ + lower» слабее точного
  // сравнения. Если два постфикса нормализуются одинаково, наличие одного поля замаскировало бы
  // ОТСУТСТВИЕ другого, и оно не создалось бы никогда. Проверяем на ВСЕХ полях обоих СП: наличие
  // ровно одного поля исключает из плана ровно одно (а не два) — то есть нормы попарно различны.
  it('нормализация имён не даёт коллизий: каждое поле маскирует ровно себя — #41', () => {
    for (const sp of [PAYMENT_SP_FIELDS, DISTRIBUTION_SP_FIELDS]) {
      const all = Object.values(sp)
      for (const f of all) {
        const plan = planMissingUserFields(1044, all, [buildUfFieldName(1044, f.postfix)])
        expect(plan, `поле ${f.postfix} маскирует не ровно себя (коллизия нормы?)`).toHaveLength(all.length - 1)
      }
    }
  })
})

describe('SP entityTypeId accessors', () => {
  it('reads each SP id from its own reserved config key (positive integer)', () => {
    const cf = { [PAYMENT_SP_CONFIG_KEY]: '1044', [DISTRIBUTION_SP_CONFIG_KEY]: '1046' }
    expect(paymentSpEtid(cf)).toBe(1044)
    expect(distributionSpEtid(cf)).toBe(1046)
  })
  it('the two SP keys are distinct (no collision with the user smart-entity target)', () => {
    expect(PAYMENT_SP_CONFIG_KEY).not.toBe(DISTRIBUTION_SP_CONFIG_KEY)
    expect(PAYMENT_SP_CONFIG_KEY).not.toBe('smart-entity')
    expect(DISTRIBUTION_SP_CONFIG_KEY).not.toBe('smart-entity')
  })
  it('fail-closed on absent / blank / non-numeric / non-positive (not provisioned)', () => {
    expect(paymentSpEtid(undefined)).toBeNull()
    expect(paymentSpEtid({})).toBeNull()
    expect(paymentSpEtid({ [PAYMENT_SP_CONFIG_KEY]: '' })).toBeNull()
    expect(paymentSpEtid({ [PAYMENT_SP_CONFIG_KEY]: 'abc' })).toBeNull()
    expect(paymentSpEtid({ [PAYMENT_SP_CONFIG_KEY]: '0' })).toBeNull()
    expect(paymentSpEtid({ [PAYMENT_SP_CONFIG_KEY]: '-5' })).toBeNull()
    expect(paymentSpEtid({ [PAYMENT_SP_CONFIG_KEY]: '10.5' })).toBeNull()
  })
})

describe('withSpProvision / hasSpEtids', () => {
  const PSP = { entityTypeId: 1044, id: 44 }
  const DSP = { entityTypeId: 1046, id: 46 }
  it('merges both entityTypeIds AND type ids as strings under the reserved keys, preserving other fields', () => {
    const merged = withSpProvision({ 'smart-entity': '1030' }, PSP, DSP)
    expect(merged['smart-entity']).toBe('1030')
    expect(merged[PAYMENT_SP_CONFIG_KEY]).toBe('1044')
    expect(merged[PAYMENT_SP_ID_CONFIG_KEY]).toBe('44')
    expect(merged[DISTRIBUTION_SP_CONFIG_KEY]).toBe('1046')
    expect(merged[DISTRIBUTION_SP_ID_CONFIG_KEY]).toBe('46')
  })
  it('does not mutate the input map', () => {
    const input = { a: '1' }
    withSpProvision(input, PSP, DSP)
    expect(input).toEqual({ a: '1' })
  })
  it('tolerates an undefined input', () => {
    expect(withSpProvision(undefined, PSP, DSP)).toEqual({
      [PAYMENT_SP_CONFIG_KEY]: '1044', [PAYMENT_SP_ID_CONFIG_KEY]: '44',
      [DISTRIBUTION_SP_CONFIG_KEY]: '1046', [DISTRIBUTION_SP_ID_CONFIG_KEY]: '46'
    })
  })
  it('hasSpEtids is true only when BOTH refs are complete (entityTypeId AND type id)', () => {
    expect(hasSpEtids(withSpProvision({}, PSP, DSP))).toBe(true)
    expect(hasSpEtids({ [PAYMENT_SP_CONFIG_KEY]: '1044' })).toBe(false)
    expect(hasSpEtids({})).toBe(false)
    // entityTypeIds present but type ids missing → incomplete → false
    expect(hasSpEtids({ [PAYMENT_SP_CONFIG_KEY]: '1044', [DISTRIBUTION_SP_CONFIG_KEY]: '1046' })).toBe(false)
  })
})

// ⚠ Форма настроек держит блок, прочитанный при открытии, и «Сохранить» пишет его целиком (#19).
// Id смарт-процессов пишет провижининг в обход формы, поэтому при записи формы они берутся из
// ХРАНИМОГО блока: иначе смарт-процессы в CRM есть, а приложение их «не видит».
describe('keepStoredSpIds / withStoredSpIds', () => {
  const STORED = withSpProvision({}, { entityTypeId: 1042, id: 16 }, { entityTypeId: 1044, id: 17 })

  it('форма без id (открыта до провижининга) не затирает записанные провижинингом', () => {
    const out = keepStoredSpIds({ 'smart-entity': '1030' }, STORED)
    expect(out['smart-entity']).toBe('1030')
    expect(out[PAYMENT_SP_CONFIG_KEY]).toBe('1042')
    expect(out[PAYMENT_SP_ID_CONFIG_KEY]).toBe('16')
    expect(out[DISTRIBUTION_SP_CONFIG_KEY]).toBe('1044')
    expect(out[DISTRIBUTION_SP_ID_CONFIG_KEY]).toBe('17')
  })

  it('устаревшие id из формы не побеждают хранимые — и не воскрешаются, если хранимых нет', () => {
    const stale = withSpProvision({}, { entityTypeId: 1038, id: 14 }, { entityTypeId: 1040, id: 15 })
    expect(keepStoredSpIds(stale, STORED)[PAYMENT_SP_CONFIG_KEY]).toBe('1042')
    const none = keepStoredSpIds(stale, {})
    for (const k of [PAYMENT_SP_CONFIG_KEY, PAYMENT_SP_ID_CONFIG_KEY, DISTRIBUTION_SP_CONFIG_KEY, DISTRIBUTION_SP_ID_CONFIG_KEY]) {
      expect(none[k], k).toBeUndefined()
    }
  })

  it('прочие поля карты — из формы: их редактирует человек', () => {
    const out = keepStoredSpIds({ 'deal-field': 'UF_NEW' }, { ...STORED, 'deal-field': 'UF_OLD' })
    expect(out['deal-field']).toBe('UF_NEW')
  })

  it('провижининг пишет ТОЛЬКО ключи из списка: новый серверный ключ обязан попасть в список', () => {
    // Иначе форма молча затирала бы его своей старой копией — ровно исходный дефект, с новым ключом.
    const written = Object.keys(withSpProvision({}, { entityTypeId: 1, id: 2 }, { entityTypeId: 3, id: 4 }))
    expect(written.sort()).toEqual([...PROVISIONED_SP_KEYS].sort())
  })

  it('на уровне блока настроек трогает только карту, вход не мутирует', () => {
    const incoming = defaultPortalSettings()
    incoming.autoDistribute = true
    const stored = defaultPortalSettings()
    stored.recognition.configFields = STORED
    const out = withStoredSpIds(incoming, stored)
    expect(out.autoDistribute).toBe(true)
    expect(out.recognition.configFields[PAYMENT_SP_CONFIG_KEY]).toBe('1042')
    expect(incoming.recognition.configFields[PAYMENT_SP_CONFIG_KEY]).toBeUndefined()
  })
})

// Слияние маршрута проверяется ВЫЗОВОМ: регулярка по тексту маршрута пропускала перепутанные
// аргументы, то есть ровно исходный дефект (находка ревью QA).
describe('mergeFormSettings', () => {
  const formWith = (configFields: Record<string, string>) => {
    const s = defaultPortalSettings()
    s.chat.dialogId = 'chat7'
    s.recognition.configFields = configFields
    return s
  }
  const storedWith = (configFields: Record<string, string>): string => {
    const s = defaultPortalSettings()
    s.recognition.configFields = configFields
    return serializePortalSettings(s)
  }
  const STORED_IDS = withSpProvision({}, { entityTypeId: 1042, id: 16 }, { entityTypeId: 1044, id: 17 })

  it('форма без id + хранимые id ⇒ пишутся id из хранимого и остальное из формы', () => {
    const out = parsePortalSettings(mergeFormSettings(formWith({ 'smart-entity': '1030' }))(storedWith(STORED_IDS)))
    expect(out.chat.dialogId).toBe('chat7')
    expect(out.recognition.configFields['smart-entity']).toBe('1030')
    expect(out.recognition.configFields[PAYMENT_SP_CONFIG_KEY]).toBe('1042')
    expect(out.recognition.configFields[DISTRIBUTION_SP_ID_CONFIG_KEY]).toBe('17')
  })

  it('устаревшие id из формы не пишутся, если в хранимом их нет', () => {
    const stale = withSpProvision({}, { entityTypeId: 1038, id: 14 }, { entityTypeId: 1040, id: 15 })
    const out = parsePortalSettings(mergeFormSettings(formWith(stale))(storedWith({})))
    expect(out.recognition.configFields[PAYMENT_SP_CONFIG_KEY]).toBeUndefined()
  })

  it('первое сохранение (хранимого нет) и битое хранимое — форма пишется, id не выдумываются', () => {
    for (const stored of [null, '{не json']) {
      const out = parsePortalSettings(mergeFormSettings(formWith({ 'smart-entity': '1030' }))(stored))
      expect(out.chat.dialogId, String(stored)).toBe('chat7')
      expect(out.recognition.configFields['smart-entity'], String(stored)).toBe('1030')
      expect(out.recognition.configFields[PAYMENT_SP_CONFIG_KEY], String(stored)).toBeUndefined()
    }
  })
})
