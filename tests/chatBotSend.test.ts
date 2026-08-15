import { beforeEach, describe, expect, it } from 'vitest'
import { BOT_MESSAGE_METHOD, resetBotCache, resolveBotId } from '../server/utils/chatBotSend'
import { CHAT_MESSAGE_METHOD, postChatMessage } from '../server/utils/chatNotifyWrite'

// Отправка от имени приложения с ОБЯЗАТЕЛЬНЫМ откатом (#496).
//
// Два документированных отказа решают, заработает ли бот на конкретном портале: `ACCESS_DENIED`
// (REST только на коммерческих тарифах) и `BOT_LIMIT_EXCEEDED`. Оба — свойство портала клиента, а
// не наш сбой. Замолчать в этом случае значило бы разменять косметику (подпись коллеги) на ровно
// ту беду, ради которой всё написано: чат ошибок — единственный канал, доходящий до бухгалтера.

beforeEach(resetBotCache)

/** Фейк REST: считает вызовы по методам и отвечает по сценарию. */
function fake(script: Partial<Record<string, () => unknown>> = {}) {
  const seen: string[] = []
  const call = async (method: string, _params: Record<string, unknown>) => {
    seen.push(method)
    const handler = script[method]
    if (handler) return handler() as Record<string, unknown>
    if (method === 'imbot.v2.Bot.register') return { result: 7 }
    return { result: 100 }
  }
  return { call, seen }
}

describe('postChatMessage — маршрут по умолчанию', () => {
  it('без memberId шлёт по-старому: контракт прежних вызовов не изменился', async () => {
    const { call, seen } = fake()
    expect(await postChatMessage('chat1', 'привет', call)).toBe('100')
    expect(seen).toEqual([CHAT_MESSAGE_METHOD])
  })

  it('с memberId регистрирует бота и шлёт от него', async () => {
    const { call, seen } = fake()
    expect(await postChatMessage('chat1', 'привет', call, 'M1')).toBe('100')
    expect(seen).toEqual(['imbot.v2.Bot.register', BOT_MESSAGE_METHOD])
  })

  it('регистрация — один раз на портал, а не на сообщение', async () => {
    const { call, seen } = fake()
    await postChatMessage('chat1', 'a', call, 'M1')
    await postChatMessage('chat1', 'b', call, 'M1')
    expect(seen.filter(m => m === 'imbot.v2.Bot.register')).toHaveLength(1)
  })

  it('каждый портал регистрируется отдельно', async () => {
    const { call, seen } = fake()
    await postChatMessage('chat1', 'a', call, 'M1')
    await postChatMessage('chat1', 'a', call, 'M2')
    expect(seen.filter(m => m === 'imbot.v2.Bot.register')).toHaveLength(2)
  })
})

describe('postChatMessage — откат обязателен', () => {
  it('ACCESS_DENIED (бесплатный тариф) → сообщение всё равно уходит, старым способом', async () => {
    const { call, seen } = fake({
      'imbot.v2.Bot.register': () => {
        throw new Error('ACCESS_DENIED: REST API is available on commercial plans')
      }
    })
    expect(await postChatMessage('chat1', 'важное', call, 'M1')).toBe('100')
    expect(seen).toContain(CHAT_MESSAGE_METHOD)
  })

  it('BOT_LIMIT_EXCEEDED → то же самое', async () => {
    const { call, seen } = fake({
      'imbot.v2.Bot.register': () => {
        throw new Error('BOT_LIMIT_EXCEEDED')
      }
    })
    expect(await postChatMessage('chat1', 'важное', call, 'M1')).toBe('100')
    expect(seen).toContain(CHAT_MESSAGE_METHOD)
  })

  it('постоянный отказ запоминается — не спрашиваем портал на каждом сообщении', async () => {
    const { call, seen } = fake({
      'imbot.v2.Bot.register': () => {
        throw new Error('ACCESS_DENIED')
      }
    })
    await postChatMessage('chat1', 'a', call, 'M1')
    await postChatMessage('chat1', 'b', call, 'M1')
    expect(seen.filter(m => m === 'imbot.v2.Bot.register')).toHaveLength(1)
  })

  it('СЕТЕВОЙ сбой НЕ запоминается — иначе одна плохая минута портит подпись до перезапуска', async () => {
    let fail = true
    const { call, seen } = fake({
      'imbot.v2.Bot.register': () => {
        if (fail) throw new Error('socket hang up')
        return { result: 7 }
      }
    })
    await postChatMessage('chat1', 'a', call, 'M1')
    fail = false
    await postChatMessage('chat1', 'b', call, 'M1')
    expect(seen.filter(m => m === 'imbot.v2.Bot.register')).toHaveLength(2)
    expect(seen).toContain(BOT_MESSAGE_METHOD)
  })

  it('падение САМОЙ отправки ботом → тоже откат, сообщение доходит', async () => {
    const { call, seen } = fake({
      [BOT_MESSAGE_METHOD]: () => {
        throw new Error('boom')
      }
    })
    expect(await postChatMessage('chat1', 'важное', call, 'M1')).toBe('100')
    expect(seen).toContain(CHAT_MESSAGE_METHOD)
  })

  it('бот ответил без id → откат: «не исключение» ещё не значит «доставлено»', async () => {
    const { call, seen } = fake({ [BOT_MESSAGE_METHOD]: () => ({ result: 0 }) })
    expect(await postChatMessage('chat1', 'важное', call, 'M1')).toBe('100')
    expect(seen).toContain(CHAT_MESSAGE_METHOD)
  })

  it('падение ОТКАТА пробрасывается — это уже настоящая ошибка транспорта', async () => {
    const { call } = fake({
      'imbot.v2.Bot.register': () => {
        throw new Error('ACCESS_DENIED')
      },
      [CHAT_MESSAGE_METHOD]: () => {
        throw new Error('portal down')
      }
    })
    await expect(postChatMessage('chat1', 'важное', call, 'M1')).rejects.toThrow('portal down')
  })
})

describe('resolveBotId', () => {
  it('битый ответ регистрации → null, а не фиктивный id', async () => {
    const { call } = fake({ 'imbot.v2.Bot.register': () => ({ result: 'не число' }) })
    expect(await resolveBotId('M1', call)).toBeNull()
  })
})

describe('внешний текст остаётся обезврежен на обоих маршрутах', () => {
  it('URL_PREVIEW выключен и у бота тоже', async () => {
    // Назначение платежа пишет плательщик; ссылка не должна разворачиваться в карточку.
    const params: Record<string, unknown>[] = []
    const call = async (method: string, p: Record<string, unknown>) => {
      params.push({ method, ...p })
      return method === 'imbot.v2.Bot.register' ? { result: 7 } : { result: 100 }
    }
    await postChatMessage('chat1', 'см. http://evil.test', call, 'M1')
    const sent = params.find(p => p.method === BOT_MESSAGE_METHOD)
    expect(sent?.URL_PREVIEW).toBe('N')
  })
})
