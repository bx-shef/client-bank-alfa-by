import { describe, expect, it } from 'vitest'
import { buildBotRegisterCall, extractBotId, isPermanentBotError } from '../app/utils/b24BotRegister'
import { B24_CHAT_BOT, B24_REQUIRED_SCOPES } from '../app/config/b24'

// Сообщения в чат приходят от владельца OAuth-токена — другого режима у `im.message.add` нет.
// Для чата ошибок это особенно неудачно: «Клиент не определён, заведите реквизит» выглядит как
// записка от коллеги, и спрашивают потом с него (#496).

describe('buildBotRegisterCall', () => {
  it('зовёт АКТУАЛЬНОЕ поколение метода', () => {
    // `imbot.register` — устаревшая пара. Ошибка тут тихая: старый метод существует и отвечает,
    // просто он из другого поколения API.
    const call = buildBotRegisterCall(B24_CHAT_BOT)
    expect(call?.method).toBe('imbot.v2.Bot.register')
  })

  it('несёт код, имя и должность', () => {
    const call = buildBotRegisterCall({ code: 'c', name: 'Имя', position: 'Должность' })
    expect(call?.params).toMatchObject({
      CODE: 'c',
      TYPE: 'B',
      PROPERTIES: { NAME: 'Имя', WORK_POSITION: 'Должность' }
    })
  })

  it('НИКОГДА не шлёт botToken — он только для вебхуков, под OAuth его быть не должно', () => {
    const call = buildBotRegisterCall(B24_CHAT_BOT)
    expect(JSON.stringify(call)).not.toMatch(/botToken/i)
  })

  it('не задаёт eventMode: умолчание `fetch` и есть то, что нужно шлющему боту', () => {
    // Указать его значило бы намекнуть на обработку колбэков, для которых мы не регистрируем URL.
    expect(JSON.stringify(buildBotRegisterCall(B24_CHAT_BOT))).not.toMatch(/eventMode/i)
  })

  it('пустой код или имя → null, а не кривая регистрация', () => {
    expect(buildBotRegisterCall({ code: '', name: 'Имя', position: 'П' })).toBeNull()
    expect(buildBotRegisterCall({ code: 'c', name: '  ', position: 'П' })).toBeNull()
  })

  it('пустая должность допустима — это косметика, а не обязательное поле', () => {
    expect(buildBotRegisterCall({ code: 'c', name: 'Имя', position: '' })).not.toBeNull()
  })
})

describe('extractBotId', () => {
  it('читает и скаляр, и объект', () => {
    expect(extractBotId({ result: 42 })).toBe('42')
    expect(extractBotId({ result: '42' })).toBe('42')
    expect(extractBotId({ result: { id: 42 } })).toBe('42')
    expect(extractBotId({ result: { ID: 42 } })).toBe('42')
  })

  it('мусор → null, а не «бот есть»', () => {
    // Худшее направление ошибки: с фиктивным id мы слали бы BOT_ID на каждом сообщении, портал
    // отвергал бы каждое, а фолбэк не включился бы — мы же «уверены», что бот есть.
    for (const junk of [{ result: 0 }, { result: -1 }, { result: 'x' }, { result: null }, {}, { result: [] }]) {
      expect(extractBotId(junk as Record<string, unknown>)).toBeNull()
    }
  })
})

describe('isPermanentBotError', () => {
  it('отказы, которые не пройдут никогда, — это свойство портала, а не сбой', () => {
    expect(isPermanentBotError(new Error('ACCESS_DENIED: REST API is available on commercial plans'))).toBe(true)
    expect(isPermanentBotError(new Error('BOT_LIMIT_EXCEEDED'))).toBe(true)
  })

  it('сетевой сбой ПОСТОЯННЫМ не считается', () => {
    // Иначе одна плохая минута подписывала бы все сообщения именем сотрудника до перезапуска.
    expect(isPermanentBotError(new Error('socket hang up'))).toBe(false)
    expect(isPermanentBotError(new Error('503 Service Unavailable'))).toBe(false)
    expect(isPermanentBotError(undefined)).toBe(false)
  })
})

describe('константы установки', () => {
  it('скоуп `imbot` запрошен — без него регистрация не пройдёт нигде', () => {
    expect(B24_REQUIRED_SCOPES).toContain('imbot')
  })

  it('код бота непустой и стабильный', () => {
    // ⚠ Это идентификатор НА ПОРТАЛЕ КЛИЕНТА и ключ идемпотентности регистрации. Смена осиротит
    // всех уже зарегистрированных ботов: новый код зарегистрируется, старые останутся висеть, а
    // порталы у предела числа ботов начнут упираться в отказ.
    expect(B24_CHAT_BOT.code).toBe('cba_statement_bot')
    expect(B24_CHAT_BOT.name.trim()).not.toBe('')
  })
})
