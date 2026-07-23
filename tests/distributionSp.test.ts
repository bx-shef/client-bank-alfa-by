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
  PAYMENT_SP_ID_CONFIG_KEY,
  DISTRIBUTION_SP_ID_CONFIG_KEY
} from '~/config/distributionSp'

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
      expect(['double', 'boolean', 'string', 'integer']).toContain(field.userTypeId)
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
