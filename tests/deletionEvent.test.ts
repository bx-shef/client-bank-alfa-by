import { describe, expect, it } from 'vitest'
import { B24_DELETION_EVENTS, SMART_INVOICE_ENTITY_TYPE_ID, classifyDeletionKind, isRelevantDeletion, parseDeletionRef } from '~/utils/deletionEvent'

// Pure deletion-event parser/classifier (#109 §9.2). The payload shape mirrors the live B24
// event (data.FIELDS.{ID, ENTITY_TYPE_ID}); authenticity is the upstream application_token gate.

const dynamic = (id: string, entityTypeId: string | number) =>
  ({ event: 'ONCRMDYNAMICITEMDELETE', data: { FIELDS: { ID: id, ENTITY_TYPE_ID: String(entityTypeId) } } })

describe('parseDeletionRef', () => {
  it('ONCRMDEALDELETE → { kind: deal, id }', () => {
    expect(parseDeletionRef({ event: 'ONCRMDEALDELETE', data: { FIELDS: { ID: '15' } } })).toEqual({ kind: 'deal', id: '15' })
  })

  it('ONCRMCOMPANYDELETE → { kind: company, id }', () => {
    expect(parseDeletionRef({ event: 'ONCRMCOMPANYDELETE', data: { FIELDS: { ID: '7' } } })).toEqual({ kind: 'company', id: '7' })
  })

  it('dynamic item with entityTypeId 31 → invoice', () => {
    expect(parseDeletionRef(dynamic('39', SMART_INVOICE_ENTITY_TYPE_ID))).toEqual({ kind: 'invoice', id: '39', entityTypeId: 31 })
  })

  it('dynamic item matching the configured payment-carrier SP → payment-carrier', () => {
    expect(parseDeletionRef(dynamic('100', 1044), { paymentSpEtid: 1044, distributionSpEtid: 1046 }))
      .toEqual({ kind: 'payment-carrier', id: '100', entityTypeId: 1044 })
  })

  it('dynamic item matching the configured distributions SP → distribution', () => {
    expect(parseDeletionRef(dynamic('200', 1046), { paymentSpEtid: 1044, distributionSpEtid: 1046 }))
      .toEqual({ kind: 'distribution', id: '200', entityTypeId: 1046 })
  })

  it('dynamic item of an UNRELATED type → other (ignored)', () => {
    expect(parseDeletionRef(dynamic('5', 1099), { paymentSpEtid: 1044, distributionSpEtid: 1046 }))
      .toEqual({ kind: 'other', id: '5', entityTypeId: 1099 })
  })

  it('case-insensitive event code (OnCrmDealDelete)', () => {
    expect(parseDeletionRef({ event: 'OnCrmDealDelete', data: { FIELDS: { ID: '15' } } })).toEqual({ kind: 'deal', id: '15' })
  })

  it('returns null for a missing/blank id', () => {
    expect(parseDeletionRef({ event: 'ONCRMDEALDELETE', data: { FIELDS: {} } })).toBeNull()
    expect(parseDeletionRef({ event: 'ONCRMDEALDELETE', data: { FIELDS: { ID: '  ' } } })).toBeNull()
  })

  it('returns null for a non-digit / non-scalar id (fail-closed, all event kinds)', () => {
    expect(parseDeletionRef({ event: 'ONCRMDEALDELETE', data: { FIELDS: { ID: 'abc' } } })).toBeNull()
    expect(parseDeletionRef({ event: 'ONCRMCOMPANYDELETE', data: { FIELDS: { ID: '12x' } } })).toBeNull()
    expect(parseDeletionRef({ event: 'ONCRMDEALDELETE', data: { FIELDS: { ID: { nested: '1' } } } })).toBeNull()
    expect(parseDeletionRef(dynamic('[object Object]', 31))).toBeNull()
  })

  it('accepts a numeric ID (B24 may send it as a number)', () => {
    expect(parseDeletionRef({ event: 'ONCRMDEALDELETE', data: { FIELDS: { ID: 15 } } })).toEqual({ kind: 'deal', id: '15' })
  })

  it('returns null for a dynamic item with a non-positive/non-integer/float entityTypeId', () => {
    expect(parseDeletionRef(dynamic('1', 'abc'))).toBeNull()
    expect(parseDeletionRef(dynamic('1', 0))).toBeNull()
    expect(parseDeletionRef(dynamic('1', -5))).toBeNull()
    expect(parseDeletionRef(dynamic('1', '31.5'))).toBeNull() // float → not integer
    expect(parseDeletionRef({ event: 'ONCRMDYNAMICITEMDELETE', data: { FIELDS: { ID: '1' } } })).toBeNull() // missing ENTITY_TYPE_ID
  })

  it('case-insensitive dynamic code (OnCrmDynamicItemDelete) still classifies by entityTypeId', () => {
    expect(parseDeletionRef({ event: 'OnCrmDynamicItemDelete', data: { FIELDS: { ID: '39', ENTITY_TYPE_ID: '31' } } }))
      .toEqual({ kind: 'invoice', id: '39', entityTypeId: 31 })
  })

  it('returns null for an event we do not handle (e.g. a create/update)', () => {
    expect(parseDeletionRef({ event: 'ONCRMDEALUPDATE', data: { FIELDS: { ID: '15' } } })).toBeNull()
    expect(parseDeletionRef({ event: '', data: {} })).toBeNull()
    expect(parseDeletionRef(null)).toBeNull()
  })

  it('unconfigured SP ids → a dynamic non-invoice item is `other` (fail-safe, no accidental match)', () => {
    expect(parseDeletionRef(dynamic('100', 1044)).kind).toBe('other') // no cfg → not our SP
  })
})

describe('isRelevantDeletion', () => {
  it('everything except `other` is relevant to the ledger', () => {
    for (const kind of ['deal', 'company', 'invoice', 'payment-carrier', 'distribution'] as const) {
      expect(isRelevantDeletion({ kind, id: '1' })).toBe(true)
    }
    expect(isRelevantDeletion({ kind: 'other', id: '1', entityTypeId: 1099 })).toBe(false)
  })
})

describe('classifyDeletionKind (raw fields, shared by consumer)', () => {
  const cfg = { paymentSpEtid: 1044, distributionSpEtid: 1046 }
  it('classifies deal/company/invoice by code + etid', () => {
    expect(classifyDeletionKind('ONCRMDEALDELETE', undefined, cfg)).toBe('deal')
    expect(classifyDeletionKind('ONCRMCOMPANYDELETE', undefined, cfg)).toBe('company')
    expect(classifyDeletionKind('ONCRMDYNAMICITEMDELETE', 31, cfg)).toBe('invoice')
    expect(classifyDeletionKind('ONCRMDYNAMICITEMDELETE', 1044, cfg)).toBe('payment-carrier')
    expect(classifyDeletionKind('ONCRMDYNAMICITEMDELETE', 1046, cfg)).toBe('distribution')
    expect(classifyDeletionKind('ONCRMDYNAMICITEMDELETE', 1099, cfg)).toBe('other')
  })
  it('is case-insensitive on the code', () => {
    expect(classifyDeletionKind('OnCrmDealDelete', undefined, cfg)).toBe('deal')
  })
  it('null for an unhandled code or an invalid dynamic etid', () => {
    expect(classifyDeletionKind('ONCRMDEALUPDATE', undefined, cfg)).toBeNull()
    expect(classifyDeletionKind('ONCRMDYNAMICITEMDELETE', 0, cfg)).toBeNull()
    expect(classifyDeletionKind('ONCRMDYNAMICITEMDELETE', undefined, cfg)).toBeNull()
  })
  it('without cfg, a dynamic non-invoice item is other (fail-safe)', () => {
    expect(classifyDeletionKind('ONCRMDYNAMICITEMDELETE', 1044, {})).toBe('other')
  })
})

describe('B24_DELETION_EVENTS', () => {
  it('binds exactly the three deletion codes (§9.2)', () => {
    expect([...B24_DELETION_EVENTS]).toEqual(['ONCRMDEALDELETE', 'ONCRMCOMPANYDELETE', 'ONCRMDYNAMICITEMDELETE'])
  })
})
