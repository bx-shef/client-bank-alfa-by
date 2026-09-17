import { describe, expect, it } from 'vitest'
import {
  BANK_CONTACT_KEY, contactDialogId, contactLabel, isValidPortalUserId, parseBankContact,
  serializeBankContact
} from '../app/utils/bankContact'

// Адресат подключения банка (#19) — кому администратор передаёт ссылку/инструкцию.

describe('идентификатор сотрудника портала', () => {
  // ⚠ Значение приходит из диалога портала, то есть ИЗВНЕ, и становится `DIALOG_ID` личного чата.
  // Мягкая проверка (`Number(v) > 0`) пропустила бы `'12 '` — сообщение ушло бы не туда молча.
  it('принимает только голое положительное целое', () => {
    expect(isValidPortalUserId('1')).toBe(true)
    expect(isValidPortalUserId('123456')).toBe(true)
    for (const bad of ['', '0', '01', '-1', '1.5', '12 ', ' 12', '12abc', 'abc', '1e3']) {
      expect(isValidPortalUserId(bad), bad).toBe(false)
    }
    expect(isValidPortalUserId(12 as unknown as string)).toBe(false)
  })
})

describe('parseBankContact', () => {
  it('читает и объект, и строку JSON (в app.option лежит строка)', () => {
    expect(parseBankContact({ userId: '7', name: 'Иванова А.' })).toEqual({ userId: '7', name: 'Иванова А.' })
    expect(parseBankContact('{"userId":"7","name":"Иванова А."}')).toEqual({ userId: '7', name: 'Иванова А.' })
  })

  // ⚠ Мусор ⇒ null («адресата нет»), а не полузапись: подпись «сотрудник #undefined» в интерфейсе
  // хуже отсутствия подписи, а отправка по такому id ушла бы в никуда.
  it('мусор и битый JSON дают null', () => {
    for (const bad of ['', '   ', 'не json', '{', null, undefined, 42, [], { name: 'без id' }, { userId: 'abc' }]) {
      expect(parseBankContact(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('имя необязательно и обрезается по длине', () => {
    expect(parseBankContact({ userId: '7' })).toEqual({ userId: '7' })
    expect(parseBankContact({ userId: '7', name: '   ' })).toEqual({ userId: '7' })
    const long = parseBankContact({ userId: '7', name: 'я'.repeat(500) })
    expect(long?.name?.length).toBe(120)
  })
})

describe('serializeBankContact', () => {
  it('круговой рейс через строку сохраняет запись', () => {
    const c = { userId: '9', name: 'Пётр' }
    expect(parseBankContact(serializeBankContact(c))).toEqual(c)
  })

  it('нечего писать ⇒ null, а не пустая строка в настройках портала', () => {
    expect(serializeBankContact(null)).toBeNull()
    expect(serializeBankContact({ userId: 'abc' })).toBeNull()
  })
})

describe('contactLabel', () => {
  // Имя в портале меняется, а адресуемся мы id — поэтому подпись честно называет id, когда имени нет.
  it('имя, иначе «сотрудник #id»', () => {
    expect(contactLabel({ userId: '7', name: 'Иванова А.' })).toBe('Иванова А.')
    expect(contactLabel({ userId: '7' })).toBe('сотрудник #7')
    expect(contactLabel(null)).toBe('')
  })
})

describe('contactDialogId', () => {
  // ⚠ Адресат ОБЯЗАН доехать до `imOpenMessenger`: без параметра метод открывает СПИСОК чатов
  // (документация), то есть ровно то, от чего кнопка «Открыть чат» должна избавлять.
  it('годный адресат превращается в число для SDK', () => {
    expect(contactDialogId({ userId: '12', name: 'Бухгалтер' })).toBe(12)
    expect(contactDialogId({ userId: '7' })).toBe(7)
  })

  it('адресата нет — открывать нечего', () => {
    expect(contactDialogId(null)).toBeNull()
  })

  // ⚠ Маска допускает 18 цифр, а `Number` за пределами 2^53 ОКРУГЛЯЕТ — то есть открыл бы
  // переписку с ДРУГИМ сотрудником, и выглядело бы это как исправно сработавшая кнопка.
  it('идентификатор, не влезающий в безопасное целое, отвергается', () => {
    const huge = '123456789012345678'
    // Сам факт округления — замер, а не допущение: без него проверка ниже читалась бы как
    // перестраховка.
    expect(Number.isSafeInteger(Number(huge))).toBe(false)
    expect(isValidPortalUserId(huge)).toBe(true) // маску он проходит — отвергает именно эта проверка
    expect(contactDialogId({ userId: huge })).toBeNull()
  })

  it('мусор в id не доезжает до портала', () => {
    expect(contactDialogId({ userId: '0' } as never)).toBeNull()
    expect(contactDialogId({ userId: '12 ' } as never)).toBeNull()
  })
})

describe('ключ хранения', () => {
  // ⚠ СВОЙ ключ, а не `SETTINGS_KEY`: общий блоб редактируется формой с явными Save/Cancel, и
  // запись адресата с сервера затиралась бы следующим сохранением формы — молча.
  it('отличается от ключа общих настроек', async () => {
    const { SETTINGS_KEY } = await import('../app/utils/settings')
    expect(BANK_CONTACT_KEY).not.toBe(SETTINGS_KEY)
  })
})
