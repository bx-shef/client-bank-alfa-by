import { describe, expect, it } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import {
  CHAT_MESSAGE_METHOD,
  extractMessageId,
  notifyChatViaRest,
  postChatMessage
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
  it('returns null for an error / empty / object / falsy-scalar result', () => {
    expect(extractMessageId({ error: 'MESSAGE_EMPTY' })).toBeNull()
    expect(extractMessageId({ result: '' })).toBeNull()
    expect(extractMessageId({ result: { id: 1 } })).toBeNull() // im.message.add returns a scalar id
    expect(extractMessageId({})).toBeNull()
    // Only a positive integer is a real message id — falsy scalars are not "success".
    expect(extractMessageId({ result: 0 })).toBeNull()
    expect(extractMessageId({ result: false })).toBeNull()
    expect(extractMessageId({ result: -3 })).toBeNull()
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
    expect(calls[0]!.params.URL_PREVIEW).toBe('N') // don't expand payer-controlled URLs
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

describe('вложение с картинками (#19)', () => {
  const ATTACH = { IMAGE: [{ NAME: 'Шаг 1', LINK: 'https://x/1.png', PREVIEW: 'https://x/1.png', WIDTH: 960, HEIGHT: 460 }] }

  it('без вложения параметр ATTACH не отправляется вовсе', async () => {
    // ⚠ Не «пустой ATTACH», а ОТСУТСТВУЮЩИЙ: портал валидирует коллекцию блоков и на форму,
    // которая ему не нравится, отвечает `ATTACH_ERROR` — то есть выдуманное вложение заворачивало
    // бы все пять прежних видов сообщений, у которых картинок нет и не будет.
    const calls: Record<string, unknown>[] = []
    const call = async (_m: string, params: Record<string, unknown>) => {
      calls.push(params)
      return { result: 1 }
    }
    await postChatMessage('7', 'текст', call)
    expect('ATTACH' in calls[0]!).toBe(false)
  })

  it('вложение доезжает до портала', async () => {
    const calls: Record<string, unknown>[] = []
    const call = async (_m: string, params: Record<string, unknown>) => {
      calls.push(params)
      return { result: 1 }
    }
    await postChatMessage('7', 'текст', call, undefined, ATTACH)
    expect(calls[0]!.ATTACH).toBe(ATTACH)
  })

  it('ПОРТАЛ ОТВЕРГ ВЛОЖЕНИЕ ⇒ текст уходит повторно БЕЗ него', async () => {
    // ⚠ Несущий инвариант: картинки — бонус, текст — обязанность. Инструкция по выпуску ключа
    // самодостаточна словами, а вот её неотправка означает, что владелец счёта не узнал вообще
    // ничего. Мутация «убрать повтор» роняет именно этот тест.
    const calls: Record<string, unknown>[] = []
    const call = async (_m: string, params: Record<string, unknown>) => {
      calls.push(params)
      if (params.ATTACH) throw new Error('ATTACH_ERROR')
      return { result: 42 }
    }
    const id = await postChatMessage('7', 'текст', call, undefined, ATTACH)
    expect(id).toBe('42')
    expect(calls).toHaveLength(2)
    expect('ATTACH' in calls[1]!).toBe(false)
  })

  it('удачная отправка с картинками НЕ повторяется — дубля у получателя нет', async () => {
    let n = 0
    const call = async () => {
      n++
      return { result: 5 }
    }
    await postChatMessage('7', 'текст', call, undefined, ATTACH)
    expect(n).toBe(1)
  })

  it('отказ БЕЗ вложения по-прежнему пробрасывается вызывающему', async () => {
    // Настоящая поломка транспорта не должна прятаться за «повторим без картинок»: у неё другой
    // адресат — джоба, которую перезапустит очередь.
    const call = async () => {
      throw new Error('portal down')
    }
    await expect(postChatMessage('7', 'текст', call)).rejects.toThrow('portal down')
  })
})
