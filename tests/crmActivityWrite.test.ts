import { describe, expect, it } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import {
  ACTIVITY_ADD_METHOD,
  extractActivityId,
  writeActivityViaRest
} from '../server/utils/crmActivityWrite'
import { CRM_OWNER_TYPE_COMPANY } from '../app/utils/activity'

function item(): StatementItem {
  return {
    account: 'BY-OUR', docId: 'doc-7', direction: 'credit', amount: 1840, currency: 'BYN',
    purpose: 'Оплата', counterparty: { name: 'ООО Ромашка', unp: '191', account: 'BY13' },
    acceptDate: '2026-07-01T00:00:00.000Z'
  }
}

describe('extractActivityId', () => {
  it('reads the created id from {result:{id}} as a string', () => {
    expect(extractActivityId({ result: { id: 999 } })).toBe('999')
    expect(extractActivityId({ result: { id: '1001' } })).toBe('1001')
  })
  it('returns null for an error / empty / malformed body', () => {
    expect(extractActivityId({ error: 'NOT_FOUND' })).toBeNull()
    expect(extractActivityId({ result: null } as unknown as Record<string, unknown>)).toBeNull()
    expect(extractActivityId({ result: {} })).toBeNull()
    expect(extractActivityId({ result: { id: '' } })).toBeNull()
    expect(extractActivityId({})).toBeNull()
  })
})

describe('writeActivityViaRest', () => {
  it('posts crm.activity.todo.add with builder params and returns the new id', async () => {
    const calls: { method: string, params: Record<string, unknown> }[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return { result: { id: 4021 } }
    }
    const id = await writeActivityViaRest(item(), '42', call)
    expect(id).toBe('4021')
    expect(calls[0]!.method).toBe(ACTIVITY_ADD_METHOD)
    // Owner is the matched company; deadline/title/description come from the builder.
    expect(calls[0]!.params).toMatchObject({
      ownerTypeId: CRM_OWNER_TYPE_COMPANY,
      ownerId: 42,
      deadline: '2026-07-01T00:00:00+03:00' // re-stamped into portal TZ (#10)
    })
    expect(calls[0]!.params.title).toContain('Приход')
  })

  it('returns null when the API responds without an id', async () => {
    const call = async () => ({ result: {} })
    expect(await writeActivityViaRest(item(), '42', call)).toBeNull()
  })

  it('propagates a transport error (job will retry)', async () => {
    const call = async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    }
    await expect(writeActivityViaRest(item(), '42', call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})
