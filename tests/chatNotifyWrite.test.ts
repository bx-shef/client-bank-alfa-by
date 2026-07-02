import { describe, expect, it } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import {
  CHAT_MESSAGE_METHOD,
  extractMessageId,
  notifyChatViaRest
} from '../server/utils/chatNotifyWrite'

function item(): StatementItem {
  return {
    account: 'BY-OUR', docId: 'doc-7', direction: 'credit', amount: 1840, currency: 'BYN',
    purpose: 'Оплата', counterparty: { name: 'ООО Ромашка', unp: '191', account: 'BY13' },
    acceptDate: '2026-07-01T00:00:00.000Z'
  }
}

describe('extractMessageId', () => {
  it('reads the numeric message id as a string', () => {
    expect(extractMessageId({ result: 34239 })).toBe('34239')
    expect(extractMessageId({ result: '77' })).toBe('77')
  })
  it('returns null for an error / empty / object result', () => {
    expect(extractMessageId({ error: 'MESSAGE_EMPTY' })).toBeNull()
    expect(extractMessageId({ result: '' })).toBeNull()
    expect(extractMessageId({ result: { id: 1 } })).toBeNull() // im.message.add returns a scalar id
    expect(extractMessageId({})).toBeNull()
  })
})

describe('notifyChatViaRest', () => {
  it('posts im.message.add with DIALOG_ID + built message and returns the id', async () => {
    const calls: { method: string, params: Record<string, unknown> }[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return { result: 34239 }
    }
    const id = await notifyChatViaRest(item(), 'chat2941', call)
    expect(id).toBe('34239')
    expect(calls[0]!.method).toBe(CHAT_MESSAGE_METHOD)
    expect(calls[0]!.params.DIALOG_ID).toBe('chat2941')
    expect(String(calls[0]!.params.MESSAGE)).toContain('[b]Приход')
  })

  it('returns null when the API responds without an id', async () => {
    const call = async () => ({ error: 'ACCESS_ERROR' })
    expect(await notifyChatViaRest(item(), 'chat1', call)).toBeNull()
  })

  it('propagates a transport error (job will retry)', async () => {
    const call = async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    }
    await expect(notifyChatViaRest(item(), 'chat1', call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })
})
