import { beforeEach, describe, expect, it } from 'vitest'
import { BOT_MESSAGE_METHOD, forgetBot, resetBotCache, resolveBotId } from '../server/utils/chatBotSend'
import { CHAT_MESSAGE_METHOD, notifyChatViaRest, postChatMessage } from '../server/utils/chatNotifyWrite'
import { notifyUnmatchedViaRest } from '../server/utils/unmatchedNotify'
import { notifyAllocationErrorViaRest, notifyUnresolvedViaRest } from '../server/utils/allocationErrorNotify'
import { notifyDeletionErrorViaRest } from '../server/utils/deletionErrorNotify'
import type { StatementItem } from '../app/types/statement'

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

  it('бот ответил, а id мы не разобрали → НЕ откатываемся: ответ и есть доставка', async () => {
    // ⚠ Здесь стоял ОБРАТНЫЙ тест — «нет id ⇒ откат». Он закреплял бомбу: имена полей конверта
    // `imbot.v2.*` мы УГАДЫВАЕМ, живьём не подтверждали, и не угадай мы — каждое сообщение уходило
    // бы ДВАЖДЫ (ботом и «на всякий случай»), детерминированно, во все чаты. Дублировать сообщения
    // бухгалтеру хуже, чем не знать их id.
    //
    // Транспорт проекта бросает на `!isSuccess`, поэтому вернувшийся ответ уже означает «портал
    // принял». Состояния «отправили, но не уверены» не существует; сам id информационный —
    // все вызывающие его игнорируют.
    const { call, seen } = fake({ [BOT_MESSAGE_METHOD]: () => ({ result: 0 }) })
    expect(await postChatMessage('chat1', 'важное', call, 'M1')).toBeNull()
    expect(seen).not.toContain(CHAT_MESSAGE_METHOD)
  })

  it('совсем непонятный конверт бота — тоже не дубль', async () => {
    const { call, seen } = fake({ [BOT_MESSAGE_METHOD]: () => ({ result: { неведомоеПоле: 5 } }) })
    await postChatMessage('chat1', 'важное', call, 'M1')
    expect(seen).not.toContain(CHAT_MESSAGE_METHOD)
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

describe('разбор ответа бота — своя форма, а не общая', () => {
  // ⚠ Этот блок появился после того, как проверяющий доказал мутацией: подменяешь
  // `extractBotMessageId` на `extractMessageId` — и ВСЕ тесты остаются зелёными. Фейк по умолчанию
  // отвечал голым скаляром, то есть та самая причина, ради которой заведён отдельный разборщик
  // (v2 заворачивает payload в объект), не проверялась ни одним тестом.
  it('объектный конверт `{result:{id}}` читается', async () => {
    const { call } = fake({ [BOT_MESSAGE_METHOD]: () => ({ result: { id: 555 } }) })
    expect(await postChatMessage('chat1', 'a', call, 'M1')).toBe('555')
  })

  it('и `{result:{ID}}`, и `{result:{messageId}}` — портал пишет их по-разному', async () => {
    const byId = fake({ [BOT_MESSAGE_METHOD]: () => ({ result: { ID: 556 } }) })
    expect(await postChatMessage('chat1', 'a', byId.call, 'M1')).toBe('556')
    resetBotCache()
    const byMessageId = fake({ [BOT_MESSAGE_METHOD]: () => ({ result: { messageId: 557 } }) })
    expect(await postChatMessage('chat1', 'a', byMessageId.call, 'M2')).toBe('557')
  })

  it('объектный конверт НЕ откатывается на старый путь — иначе бот работал бы вхолостую', async () => {
    // Именно это и ломала мутация: строгий разборщик вернул бы null, мы сочли бы, что бот не
    // доставил, и продублировали сообщение обычным способом.
    const { call, seen } = fake({ [BOT_MESSAGE_METHOD]: () => ({ result: { id: 555 } }) })
    await postChatMessage('chat1', 'a', call, 'M1')
    expect(seen).not.toContain(CHAT_MESSAGE_METHOD)
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

describe('forgetBot — уборка на удалении приложения', () => {
  it('после удаления портала следующий запрос регистрирует бота заново', async () => {
    const { call, seen } = fake()
    await postChatMessage('chat1', 'a', call, 'M1')
    forgetBot('M1')
    await postChatMessage('chat1', 'b', call, 'M1')
    expect(seen.filter(m => m === 'imbot.v2.Bot.register')).toHaveLength(2)
  })

  it('чужой портал уборка не трогает', async () => {
    const { call, seen } = fake()
    await postChatMessage('chat1', 'a', call, 'M1')
    await postChatMessage('chat1', 'a', call, 'M2')
    forgetBot('M1')
    await postChatMessage('chat1', 'b', call, 'M2')
    expect(seen.filter(m => m === 'imbot.v2.Bot.register')).toHaveLength(2)
  })
})

describe('старая установка без скоупа imbot — самый частый случай', () => {
  it('«higher privileges» считается постоянным: не перерегистрируем на каждом сообщении', async () => {
    // Без этого вся существующая база установок жгла бы по два REST-вызова на каждое сообщение
    // в чат — вечно, до переустановки приложения на каждом портале.
    const { call, seen } = fake({
      'imbot.v2.Bot.register': () => {
        throw new Error('The request requires HIGHER PRIVILEGES than provided by the access token')
      }
    })
    await postChatMessage('chat1', 'a', call, 'M1')
    await postChatMessage('chat1', 'b', call, 'M1')
    expect(seen.filter(m => m === 'imbot.v2.Bot.register')).toHaveLength(1)
    // И сообщения при этом доходят — обоих.
    expect(seen.filter(m => m === CHAT_MESSAGE_METHOD)).toHaveLength(2)
  })
})

describe('регистрация: кэшируем только положительный ответ', () => {
  it('непонятный, но не бросивший ответ НЕ хоронит бота навсегда', async () => {
    // Иначе один нетипичный ответ (те же угаданные имена полей) молча и до самого рестарта
    // отключал бы бота на портале, не оставив ни единого симптома, — и это противоречило бы
    // собственному инварианту модуля «транзиентное не кэшируем».
    let weird = true
    const { call, seen } = fake({
      'imbot.v2.Bot.register': () => (weird ? { result: { неведомоеПоле: 42 } } : { result: 7 })
    })
    await postChatMessage('chat1', 'a', call, 'M1')
    weird = false
    await postChatMessage('chat1', 'b', call, 'M1')
    expect(seen.filter(m => m === 'imbot.v2.Bot.register')).toHaveLength(2)
    expect(seen).toContain(BOT_MESSAGE_METHOD)
  })
})

describe('memberId доезжает до маршрутизатора из ВСЕХ пяти отправителей', () => {
  // Параметр опциональный, поэтому «забыли передать» компилируется и проходит все прежние тесты —
  // и молча отключает бота ровно для одного вида сообщений. Портал тогда показывает часть сообщений
  // от приложения, часть от коллеги, что путает сильнее исходной проблемы.
  const item: StatementItem = {
    account: 'BY00OUR0001', docId: 'd1', docNum: '1',
    acceptDate: '2026-08-15T00:00:00.000Z',
    direction: 'credit', amount: 10, currency: 'BYN',
    purpose: 'Оплата по счёту СЧ-1', operCodeName: '',
    counterparty: { name: 'ООО Ромашка', account: 'BY00THEM0001', unp: '191234567', bank: 'Банк' }
  }

  const senders: Array<[string, (call: Parameters<typeof postChatMessage>[2]) => Promise<unknown>]> = [
    ['импорт', call => notifyChatViaRest(item, 'chat1', call, 'M1')],
    ['клиент не определён', call => notifyUnmatchedViaRest(item, 'chat1', true, call, 'M1')],
    ['ошибка разнесения', call => notifyAllocationErrorViaRest(
      item,
      // Именно `ambiguous`: на чистом `allocate` билдер возвращает null и слать нечего — тест тогда
      // был бы зелёным, ничего не проверив.
      {
        action: 'allocate',
        ambiguous: true,
        target: { kind: 'invoice', id: '1' },
        alternatives: [{ kind: 'invoice', id: '2' }]
      } as never,
      'chat1', call, 'M1'
    )],
    ['цель не найдена', call => notifyUnresolvedViaRest(item, ['СЧ-1'], 'chat1', call, false, 'M1')],
    ['удаление сущности', call => notifyDeletionErrorViaRest('company', '7', 'chat1', call, {}, 'M1')]
  ]

  for (const [label, send] of senders) {
    it(`«${label}» идёт через бота`, async () => {
      resetBotCache()
      const { call, seen } = fake()
      await send(call)
      expect(seen, `${label}: memberId не доехал — сообщение ушло от имени сотрудника`)
        .toContain(BOT_MESSAGE_METHOD)
    })
  }
})
