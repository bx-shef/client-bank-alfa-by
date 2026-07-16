import { describe, expect, it } from 'vitest'
import { ACTIVITY_LIST_METHOD, findActivityByMarker } from '../server/utils/activityMarkerLookup'

describe('findActivityByMarker', () => {
  it('filters crm.activity.list by the ORIGINATOR_ID + ORIGIN_ID pair and returns the first id', async () => {
    const calls: { method: string, params: Record<string, unknown> }[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return { result: [{ ID: '20' }, { ID: '25' }] }
    }
    const id = await findActivityByMarker('ShefClientBankAlfaBy', 'BY-OUR|doc-7', call)
    expect(id).toBe('20')
    expect(calls[0]!.method).toBe(ACTIVITY_LIST_METHOD)
    // the PAIR is mandatory (ORIGIN_ID alone could match a foreign activity)
    expect(calls[0]!.params.filter).toEqual({ ORIGINATOR_ID: 'ShefClientBankAlfaBy', ORIGIN_ID: 'BY-OUR|doc-7' })
    expect(calls[0]!.params.select).toEqual(['ID'])
  })

  it('returns null when no activity carries the marker', async () => {
    const call = async () => ({ result: [] })
    expect(await findActivityByMarker('ShefClientBankAlfaBy', 'BY-OUR|doc-7', call)).toBeNull()
  })

  it('tolerates a lowercase id key and a missing result', async () => {
    expect(await findActivityByMarker('orig', 'oid', async () => ({ result: [{ id: 7 }] }))).toBe('7')
    expect(await findActivityByMarker('orig', 'oid', async () => ({}))).toBeNull()
  })

  it('does NOT call REST with an empty marker (an empty filter lists everything)', async () => {
    let called = false
    const call = async () => {
      called = true
      return { result: [{ ID: '1' }] }
    }
    expect(await findActivityByMarker('', 'oid', call)).toBeNull()
    expect(await findActivityByMarker('orig', '', call)).toBeNull()
    expect(called).toBe(false)
  })

  it('propagates a transport error (job will retry)', async () => {
    const call = async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    }
    await expect(findActivityByMarker('orig', 'oid', call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})
