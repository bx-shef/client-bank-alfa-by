import { describe, expect, it, vi } from 'vitest'
import { documentByNumberParams, extractDocuments, findDocumentEntities } from '../server/utils/documentLookup'

// Document bridge (#109): document-number → the CRM entity ref(s) it was generated
// for. Field names per official docs (result.documents[], number/entityTypeId/
// entityId); the refs are untrusted → the caller re-scopes each by company via
// itemByIdLookup. Returns a LIST — a document number is not portal-unique.

const resp = (documents: unknown[]) => ({ result: { documents } })
const doc = (over: Record<string, unknown> = {}) => ({
  id: 61, number: '2026-002', entityTypeId: 2, entityId: 101, ...over
})

describe('documentByNumberParams', () => {
  it('filters by number and selects only the identifier fields (no *UrlMachine)', () => {
    expect(documentByNumberParams('2026-002')).toEqual({
      filter: { number: '2026-002' },
      select: ['id', 'number', 'entityTypeId', 'entityId']
    })
  })
})

describe('extractDocuments', () => {
  it('reads result.documents, tolerating bad/foreign shapes', () => {
    expect(extractDocuments(resp([doc({ id: 7 })]))[0]!.entityId).toBe(101)
    expect(extractDocuments(resp([]))).toEqual([])
    expect(extractDocuments({})).toEqual([])
    expect(extractDocuments({ result: { documents: 'x' } })).toEqual([])
    expect(extractDocuments({ result: { items: [doc()] } })).toEqual([]) // NOT result.items (itemByIdLookup's shape)
    expect(extractDocuments({ result: [doc()] })).toEqual([]) // NOT a bare result array (paymentLookup's shape)
  })
})

describe('findDocumentEntities', () => {
  it('maps found documents to their bound entity refs (as strings)', async () => {
    const call = vi.fn(async () => resp([doc({ entityTypeId: 2, entityId: 101 })]))
    expect(await findDocumentEntities('2026-002', call)).toEqual([{ entityTypeId: '2', entityId: '101' }])
    expect(call.mock.calls[0]![0]).toBe('crm.documentgenerator.document.list')
    expect(call.mock.calls[0]![1]).toMatchObject({ filter: { number: '2026-002' } })
  })

  it('resolves an invoice-bound document (entityTypeId 31)', async () => {
    const call = vi.fn(async () => resp([doc({ number: 'СЧ-2026-002', entityTypeId: '31', entityId: '55' })]))
    expect(await findDocumentEntities('СЧ-2026-002', call)).toEqual([{ entityTypeId: '31', entityId: '55' }])
  })

  it('returns EVERY document sharing the number (numbers are not portal-unique)', async () => {
    const call = vi.fn(async () => resp([
      doc({ entityTypeId: 2, entityId: 101 }),
      doc({ entityTypeId: 31, entityId: 55 })
    ]))
    expect(await findDocumentEntities('2026-002', call)).toEqual([
      { entityTypeId: '2', entityId: '101' },
      { entityTypeId: '31', entityId: '55' }
    ])
  })

  it('drops a document whose number does not match (defence against an ignored filter)', async () => {
    const call = vi.fn(async () => resp([
      doc({ number: '2026-999', entityId: 777 }), // portal ignored the filter → wrong doc
      doc({ number: '2026-002', entityId: 101 })
    ]))
    expect(await findDocumentEntities('2026-002', call)).toEqual([{ entityTypeId: '2', entityId: '101' }])
  })

  it('returns [] when no document has that number', async () => {
    const call = vi.fn(async () => resp([]))
    expect(await findDocumentEntities('nope', call)).toEqual([])
  })

  it('drops a document that lacks the entity binding', async () => {
    const noType = vi.fn(async () => resp([doc({ entityTypeId: undefined })]))
    expect(await findDocumentEntities('2026-002', noType)).toEqual([])
    const noId = vi.fn(async () => resp([doc({ entityId: null })]))
    expect(await findDocumentEntities('2026-002', noId)).toEqual([])
  })

  it('trims the number for the guard AND inside the REST filter', async () => {
    const call = vi.fn(async () => resp([doc({ number: '2026-002' })]))
    const out = await findDocumentEntities('  2026-002  ', call)
    expect(out).toEqual([{ entityTypeId: '2', entityId: '101' }])
    expect(call.mock.calls[0]![1]).toMatchObject({ filter: { number: '2026-002' } })
  })

  it('returns [] for a blank number without a REST call', async () => {
    const call = vi.fn(async () => resp([doc()]))
    expect(await findDocumentEntities('   ', call)).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })

  it('propagates a REST error thrown by call', async () => {
    const call = vi.fn(async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    })
    await expect(findDocumentEntities('2026-002', call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})
