import { describe, expect, it, vi } from 'vitest'
import { documentByNumberParams, extractDocuments, findDocumentEntity } from '../server/utils/documentLookup'

// Document bridge (#109): document-number → the CRM entity ref it was generated for.
// Field names per official docs (result.documents[], number/entityTypeId/entityId);
// the ref is untrusted → the caller re-scopes it by company via itemByIdLookup.

const resp = (documents: unknown[]) => ({ result: { documents } })
const doc = (over: Record<string, unknown> = {}) => ({
  id: 61, number: '2026-002', entityTypeId: 2, entityId: 101, ...over
})

describe('documentByNumberParams', () => {
  it('filters by number and selects the bridge fields', () => {
    expect(documentByNumberParams('2026-002')).toEqual({
      filter: { number: '2026-002' },
      select: ['id', 'number', 'entityTypeId', 'entityId']
    })
  })
})

describe('extractDocuments', () => {
  it('reads result.documents, tolerating bad shapes', () => {
    expect(extractDocuments(resp([doc({ id: 7 })]))[0]!.entityId).toBe(101)
    expect(extractDocuments(resp([]))).toEqual([])
    expect(extractDocuments({})).toEqual([])
    expect(extractDocuments({ result: { documents: 'x' } })).toEqual([])
    expect(extractDocuments({ result: [doc()] })).toEqual([]) // NOT a bare result array
  })
})

describe('findDocumentEntity', () => {
  it('maps a found document to its bound entity ref (as strings)', async () => {
    const call = vi.fn(async () => resp([doc({ entityTypeId: 2, entityId: 101 })]))
    expect(await findDocumentEntity('2026-002', call)).toEqual({ entityTypeId: '2', entityId: '101' })
    expect(call.mock.calls[0]![0]).toBe('crm.documentgenerator.document.list')
    expect(call.mock.calls[0]![1]).toMatchObject({ filter: { number: '2026-002' } })
  })

  it('resolves an invoice-bound document (entityTypeId 31)', async () => {
    const call = vi.fn(async () => resp([doc({ entityTypeId: '31', entityId: '55' })]))
    expect(await findDocumentEntity('СЧ-2026-002', call)).toEqual({ entityTypeId: '31', entityId: '55' })
  })

  it('returns null when no document has that number', async () => {
    const call = vi.fn(async () => resp([]))
    expect(await findDocumentEntity('nope', call)).toBeNull()
  })

  it('returns null when the document lacks the entity binding', async () => {
    const noType = vi.fn(async () => resp([doc({ entityTypeId: undefined })]))
    expect(await findDocumentEntity('2026-002', noType)).toBeNull()
    const noId = vi.fn(async () => resp([doc({ entityId: null })]))
    expect(await findDocumentEntity('2026-002', noId)).toBeNull()
  })

  it('takes the first document (numbers are unique per portal)', async () => {
    const call = vi.fn(async () => resp([doc({ entityId: 101 }), doc({ entityId: 999 })]))
    expect((await findDocumentEntity('2026-002', call))?.entityId).toBe('101')
  })

  it('trims the number and returns null for a blank one without a REST call', async () => {
    const call = vi.fn(async () => resp([doc()]))
    expect(await findDocumentEntity('   ', call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it('propagates a REST error thrown by call', async () => {
    const call = vi.fn(async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    })
    await expect(findDocumentEntity('2026-002', call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})
