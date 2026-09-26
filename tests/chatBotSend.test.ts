import { beforeEach, describe, expect, it } from 'vitest'
import { BOT_MESSAGE_METHOD, forgetBot, resetBotCache, resolveBotId } from '../server/utils/chatBotSend'
import { CHAT_MESSAGE_METHOD, notifyChatViaRest, postChatMessage } from '../server/utils/chatNotifyWrite'
import { notifyUnmatchedViaRest } from '../server/utils/unmatchedNotify'
import { notifyAllocationErrorViaRest, notifyUnresolvedViaRest } from '../server/utils/allocationErrorNotify'
import { notifyDeletionErrorViaRest } from '../server/utils/deletionErrorNotify'
import type { StatementItem } from '../app/types/statement'

/** Профиль бота (имя + аватар) — отдельный вызов после регистрации, см. `pushBotProfile`. */
const BOT_PROFILE_METHOD = 'imbot.v2.Bot.update'

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
    expect(seen).toEqual(['imbot.v2.Bot.register', BOT_PROFILE_METHOD, BOT_MESSAGE_METHOD])
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
  it('превью ссылок выключено и у бота тоже — В ЕГО СОБСТВЕННОЙ форме', async () => {
    // Назначение платежа пишет плательщик; ссылка не должна разворачиваться в карточку.
    //
    // ⚠ Прежняя редакция этого теста требовала `URL_PREVIEW: 'N'` верхним уровнем — и была
    // ЗЕЛЁНОЙ на сломанном коде: у метода второго поколения такого параметра нет вовсе, портал
    // его игнорировал, и превью на самом деле оставалось включённым. Тест закреплял форму
    // соседнего метода, а не поведение портала. Проверяем то, что метод действительно читает.
    const params: Record<string, unknown>[] = []
    const call = async (method: string, p: Record<string, unknown>) => {
      params.push({ method, ...p })
      return method === 'imbot.v2.Bot.register' ? { result: 7 } : { result: 100 }
    }
    await postChatMessage('chat1', 'см. http://evil.test', call, 'M1')
    const sent = params.find(p => p.method === BOT_MESSAGE_METHOD)!
    expect((sent.fields as { urlPreview?: unknown }).urlPreview).toBe(false)
    expect(sent.URL_PREVIEW).toBeUndefined()
  })

  it('бот получает СВОЮ форму вызова: botId/dialogId и содержимое во вложенном fields', async () => {
    // ⚠ Регрессия, из-за которой картинки не доходили: сюда слали форму `im.message.add`
    // (`BOT_ID`/`DIALOG_ID`/`MESSAGE`/`ATTACH` верхним уровнем). Отказ был худшего вида — текст
    // портал разбирал по совместимости и доставлял, а вложение и запрет превью терял МОЛЧА.
    const params: Record<string, unknown>[] = []
    const call = async (method: string, p: Record<string, unknown>) => {
      params.push({ method, ...p })
      return method === 'imbot.v2.Bot.register' ? { result: 7 } : { result: 100 }
    }
    const attach = [{ IMAGE: [{ NAME: 'Шаг 1', LINK: 'https://x/1.png', PREVIEW: 'https://x/1.png', WIDTH: 960, HEIGHT: 460 }] }]
    await postChatMessage('7', 'текст', call, 'M1', { attach, fallbackText: 'полный текст' })
    const sent = params.find(p => p.method === BOT_MESSAGE_METHOD)!
    expect(sent.botId).toBe(7)
    expect(sent.dialogId).toBe('7')
    expect(sent.fields).toEqual({ message: 'текст', urlPreview: false, attach })
    // Отрицание: ни одного поля старой формы — иначе «поправили, добавив рядом» прошло бы зелёным.
    for (const legacy of ['BOT_ID', 'DIALOG_ID', 'MESSAGE', 'ATTACH', 'URL_PREVIEW']) {
      expect(sent[legacy], legacy).toBeUndefined()
    }
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

describe('вложение с картинками и маршрут бота (#19)', () => {
  const ATTACH = [{ IMAGE: [{ NAME: 'Шаг 1', LINK: 'https://x/1.png', PREVIEW: 'https://x/1.png', WIDTH: 960, HEIGHT: 460 }] }]
  const ATTACHMENT = { attach: ATTACH, fallbackText: 'полный текст' }

  /** Где лежит вложение, зависит от МЕТОДА: у `im.message.*` — верхним уровнем и заглавными, у
   *  чат-бота — внутри `fields`. Проверки обязаны смотреть в оба места, иначе они зеленеют на той
   *  самой ошибке, из-за которой картинки не доходили. */
  const attachOf = (p: Record<string, unknown>) =>
    p.ATTACH ?? (p.fields as { attach?: unknown } | undefined)?.attach

  /** Фейк, который ПОМНИТ параметры: весь смысл этих проверок в том, что именно ушло в портал. */
  function spy(reject: (method: string, params: Record<string, unknown>) => boolean = () => false) {
    const calls: { method: string, params: Record<string, unknown> }[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'imbot.v2.Bot.register') return { result: 7 }
      if (reject(method, params)) throw new Error('ATTACH_ERROR')
      return { result: 100 }
    }
    return { call, calls }
  }

  it('бот несёт картинки — иначе их не увидел бы никто на исправном портале', async () => {
    // ⚠ Бот — ОСНОВНОЙ маршрут (#496), а не запасной: потеряв вложение здесь, мы потеряли бы его
    // у всех порталов, где всё работает, и заметили бы только у тех, где бот недоступен.
    const { call, calls } = spy()
    await postChatMessage('chat1', 'привет', call, 'M1', ATTACHMENT)
    expect(calls.map(c => c.method)).toEqual(['imbot.v2.Bot.register', BOT_PROFILE_METHOD, BOT_MESSAGE_METHOD])
    expect((calls[2]!.params.fields as Record<string, unknown>).attach).toBe(ATTACH)
  })

  it('оба маршрута отвергли вложение ⇒ ровно ОДНО сообщение, без картинок и с ПОЛНЫМ текстом', async () => {
    // Лестница повторяется целиком, поэтому текст снова уходит ботом — доставка одна, дубля нет.
    const { call, calls } = spy((_m, p) => Boolean(attachOf(p)))
    const id = await postChatMessage('chat1', 'привет', call, 'M1', ATTACHMENT)
    expect(id).toBe('100')
    expect(calls.map(c => c.method)).toEqual([
      'imbot.v2.Bot.register', BOT_PROFILE_METHOD, BOT_MESSAGE_METHOD, CHAT_MESSAGE_METHOD, BOT_MESSAGE_METHOD
    ])
    const delivered = calls.filter(c => c.method === BOT_MESSAGE_METHOD || c.method === CHAT_MESSAGE_METHOD)
    const plain = delivered.filter(c => !attachOf(c.params))
    expect(plain).toHaveLength(1)
    // Повтор идёт ботом, а у бота текст лежит во вложенном `fields.message`.
    expect((plain[0]!.params.fields as { message?: unknown }).message).toBe('полный текст')
  })
})

describe('бот пишет только в тот чат, где состоит (#496, замерено 2026-09-17)', () => {
  /** Портал, который отвергает отправку в группу, пока бот не вступил. */
  function portal() {
    const seen: string[] = []
    let joined = false
    const call = async (method: string) => {
      seen.push(method)
      if (method === 'imbot.v2.Bot.register') return { result: { users: [{ id: 7 }] } }
      if (method === 'im.chat.user.add') {
        joined = true
        return { result: true }
      }
      if (method === BOT_MESSAGE_METHOD && !joined) {
        throw Object.assign(new Error('Access denied'), { code: 'ACCESS_DENIED' })
      }
      return { result: { id: 100 } }
    }
    return { call, seen }
  }

  it('отказ доступа лечится вступлением, а не откатом на подпись сотрудника', async () => {
    // ⚠ Несущий случай. Без вступления КАЖДОЕ сообщение молча уходило на `im.message.add`, то есть
    // бот был зарегистрирован, виден в портале — и не написал ни строчки.
    const { call, seen } = portal()
    expect(await postChatMessage('chat15', 'привет', call, 'M-JOIN')).toBe('100')
    expect(seen).toContain('im.chat.user.add')
    expect(seen).not.toContain(CHAT_MESSAGE_METHOD)
  })

  it('в ЛИЧНЫЙ чат не вступают — там нет членства', async () => {
    // Так уходит ссылка на подключение банка (#19): `dialogId` это голый id пользователя.
    // Замерено: личное сообщение бот отправляет без всякого вступления.
    const { call, seen } = portal()
    await postChatMessage('42', 'привет', call, 'M-DM')
    expect(seen).not.toContain('im.chat.user.add')
  })

  it('вступление НЕ пробуется на отказах другого рода', async () => {
    // Иначе каждый отвергнутый портал-вложением вызов стоил бы двух лишних обращений.
    const seen: string[] = []
    const call = async (method: string) => {
      seen.push(method)
      if (method === 'imbot.v2.Bot.register') return { result: { users: [{ id: 7 }] } }
      if (method === BOT_MESSAGE_METHOD) throw Object.assign(new Error('bad attach'), { code: 'ATTACH_ERROR' })
      return { result: { id: 100 } }
    }
    await postChatMessage('chat15', 'привет', call, 'M-ATT')
    expect(seen).not.toContain('im.chat.user.add')
    expect(seen).toContain(CHAT_MESSAGE_METHOD)
  })
})

describe('аватар бота — иконка приложения (#496)', () => {
  it('профиль толкается отдельным вызовом: регистрация ничего не перезаписывает', async () => {
    const calls: { method: string, params: Record<string, unknown> }[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return method === 'imbot.v2.Bot.register' ? { result: { users: [{ id: 7 }] } } : { result: { id: 100 } }
    }
    await postChatMessage('chat1', 'привет', call, 'M-AV')
    const update = calls.find(c => c.method === BOT_PROFILE_METHOD)
    const props = ((update?.params.fields as Record<string, unknown>).properties) as Record<string, unknown>
    expect(String(props.avatar ?? '').length).toBeGreaterThan(1000)
    expect(props.name).toBeTruthy()
  })

  it('портал отверг картинку ⇒ повтор БЕЗ неё, иначе бот остался бы безымянным', async () => {
    // ⚠ Имя и аватар едут одним вызовом: отвергнув картинку, портал не применяет НИЧЕГО.
    const calls: { method: string, params: Record<string, unknown> }[] = []
    const call = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'imbot.v2.Bot.register') return { result: { users: [{ id: 7 }] } }
      const props = (params.fields as Record<string, unknown> | undefined)?.properties as Record<string, unknown> | undefined
      if (method === BOT_PROFILE_METHOD && props?.avatar) throw new Error('BOT_AVATAR_INCORRECT_SIZE')
      return { result: { id: 100 } }
    }
    await postChatMessage('chat1', 'привет', call, 'M-AV2')
    const updates = calls.filter(c => c.method === BOT_PROFILE_METHOD)
    expect(updates).toHaveLength(2)
    const second = ((updates[1]!.params.fields as Record<string, unknown>).properties) as Record<string, unknown>
    expect(second.avatar).toBeUndefined()
    expect(second.name).toBeTruthy()
  })

  it('отказ профиля НЕ мешает доставке — это оформление, а не сообщение', async () => {
    const call = async (method: string) => {
      if (method === 'imbot.v2.Bot.register') return { result: { users: [{ id: 7 }] } }
      if (method === BOT_PROFILE_METHOD) throw new Error('refused')
      return { result: { id: 100 } }
    }
    expect(await postChatMessage('chat1', 'привет', call, 'M-AV3')).toBe('100')
  })
})
