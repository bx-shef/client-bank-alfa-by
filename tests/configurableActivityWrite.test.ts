import { describe, expect, it } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import {
  CONFIGURABLE_ACTIVITY_ADD_METHOD,
  extractConfigurableActivityId,
  writeConfigurableActivityViaRest
} from '../server/utils/configurableActivityWrite'
import { CRM_OWNER_TYPE_COMPANY } from '../app/utils/activity'

function item(): StatementItem {
  return {
    account: 'BY-OUR', docId: 'doc-7', direction: 'credit', amount: 1840, currency: 'BYN',
    purpose: 'Оплата', counterparty: { name: 'ООО Ромашка', unp: '191', account: 'BY13' },
    acceptDate: '2026-07-01T00:00:00.000Z'
  }
}

describe('extractConfigurableActivityId', () => {
  it('reads the id from the nested {result:{activity:{id}}} envelope', () => {
    expect(extractConfigurableActivityId({ result: { activity: { id: 999 } } })).toBe('999')
    expect(extractConfigurableActivityId({ result: { activity: { id: '1001' } } })).toBe('1001')
  })
  it('returns null for error / empty / malformed / todo-shaped body', () => {
    expect(extractConfigurableActivityId({ error: 'NOT_FOUND' })).toBeNull()
    expect(extractConfigurableActivityId({ result: null } as unknown as Record<string, unknown>)).toBeNull()
    expect(extractConfigurableActivityId({ result: {} })).toBeNull()
    expect(extractConfigurableActivityId({ result: { activity: {} } })).toBeNull()
    expect(extractConfigurableActivityId({ result: { activity: { id: '' } } })).toBeNull()
    // todo.add's flat {result:{id}} must NOT be mistaken for a configurable id
    expect(extractConfigurableActivityId({ result: { id: 5 } })).toBeNull()
    expect(extractConfigurableActivityId({})).toBeNull()
  })
})

describe('writeConfigurableActivityViaRest', () => {
  it('posts crm.activity.configurable.add with the builder params and returns the new id', async () => {
    const calls: { method: string, params: Record<string, unknown> }[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return { result: { activity: { id: 4021 } } }
    }
    const id = await writeConfigurableActivityViaRest(item(), '42', call)
    expect(id).toBe('4021')
    expect(calls[0]!.method).toBe(CONFIGURABLE_ACTIVITY_ADD_METHOD)
    expect(calls[0]!.params).toMatchObject({ ownerTypeId: CRM_OWNER_TYPE_COMPANY, ownerId: 42 })
    const fields = calls[0]!.params.fields as Record<string, unknown>
    expect(fields.typeId).toBe('CONFIGURABLE')
    expect(fields.originId).toBe('BY-OUR|doc-7')
    expect(fields.originatorId).toBe('ShefClientBankAlfaBy')
    expect(calls[0]!.params.layout).toBeDefined()
  })

  it('returns null when the API responds without an id', async () => {
    const call = async () => ({ result: { activity: {} } })
    expect(await writeConfigurableActivityViaRest(item(), '42', call)).toBeNull()
  })

  it('propagates a transport error (job will retry)', async () => {
    const call = async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    }
    await expect(writeConfigurableActivityViaRest(item(), '42', call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})
