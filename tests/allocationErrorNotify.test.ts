import { describe, expect, it } from 'vitest'
import { notifyAllocationErrorViaRest } from '../server/utils/allocationErrorNotify'
import type { AllocationDecision } from '../app/utils/allocation'
import type { StatementItem } from '../app/types/statement'

function item(): StatementItem {
  return {
    account: 'A', docId: 'd1', direction: 'credit', amount: 1840, currency: 'BYN',
    purpose: 'оплата', counterparty: { name: 'ООО Ромашка', unp: '1', account: 'BY1' },
    acceptDate: '2026-07-01T00:00:00.000Z'
  }
}

const manual: AllocationDecision = {
  action: 'manual', reason: 'no-exact-match',
  candidates: [{ kind: 'invoice', id: '7', amount: 100, currency: 'BYN' }]
}
const cleanAllocate: AllocationDecision = {
  action: 'allocate', target: { kind: 'invoice', id: '5', amount: 1840, currency: 'BYN' },
  ambiguous: false, alternatives: []
}

describe('notifyAllocationErrorViaRest', () => {
  it('posts im.message.add with the built message + URL_PREVIEW=N, returns the id', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const call = async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params])
      return { result: 42 }
    }
    const id = await notifyAllocationErrorViaRest(item(), manual, 'chat9', call)
    expect(id).toBe('42')
    expect(calls).toHaveLength(1)
    const [method, params] = calls[0]!
    expect(method).toBe('im.message.add')
    expect(params.DIALOG_ID).toBe('chat9')
    expect(params.URL_PREVIEW).toBe('N')
    expect(String(params.MESSAGE)).toContain('Не удалось разнести автоматически')
  })

  it('sends nothing and returns null when the decision needs no notice (clean allocate)', async () => {
    let called = false
    const call = async () => {
      called = true
      return { result: 1 }
    }
    const id = await notifyAllocationErrorViaRest(item(), cleanAllocate, 'chat9', call)
    expect(id).toBeNull()
    expect(called).toBe(false) // builder returned null → no REST call
  })

  it('returns null when the API returns no message id', async () => {
    const call = async () => ({ result: 0 }) // falsy id
    expect(await notifyAllocationErrorViaRest(item(), manual, 'chat9', call)).toBeNull()
  })
})
