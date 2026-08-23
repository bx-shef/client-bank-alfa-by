import { describe, expect, it } from 'vitest'
import { firstPortalErrorCode, isFilterFieldRejected, PortalRestError, portalErrorCode } from '../server/utils/portalError'

// Машинный код ошибки портала (#572).
//
// ⚠ Единственная причина, по которой этот модуль существует: у SDK код ЕСТЬ, но наш транспорт его
// терял, и отличить «админ ошибся в имени поля» от «портал молчит» можно было только разбором
// локализованного описания. Поэтому тесты проверяют не «функция что-то возвращает», а ровно два
// свойства: код доезжает, и решение принимается ПО КОДУ, а не по тексту.

describe('portalErrorCode', () => {
  it('достаёт код из нашей ошибки', () => {
    expect(portalErrorCode(new PortalRestError('Invalid filter', 'INVALID_ARG_VALUE', 'crm.item.list')))
      .toBe('INVALID_ARG_VALUE')
  })

  it('чужая ошибка кода не имеет — пустая строка, а не бросок', () => {
    // До вызывающего ошибка доезжает через `catch`, то есть с типом `unknown`: сюда прилетит что
    // угодно, включая не-Error.
    expect(portalErrorCode(new Error('boom'))).toBe('')
    expect(portalErrorCode('строка')).toBe('')
    expect(portalErrorCode(null)).toBe('')
    expect(portalErrorCode(undefined)).toBe('')
  })
})

describe('isFilterFieldRejected', () => {
  it('узнаёт отказ фильтра по КОДУ', () => {
    const measured = 'Invalid filter: field \'UF_CRM_NOPE\' is not allowed in filter'
    expect(isFilterFieldRejected(new PortalRestError(measured, 'INVALID_ARG_VALUE', 'crm.item.list'))).toBe(true)
  })

  it('НЕ опирается на текст: тот же текст без кода не считается отказом фильтра', () => {
    // ⚠ Несущее свойство. Описание приходит на языке портала; проверка по подстроке молча
    // перестала бы срабатывать на англоязычном (или любом другом) портале, а англоязычный текст
    // «invalid filter» мог бы прийти и от чего-то другого.
    const measured = 'Invalid filter: field \'UF_CRM_NOPE\' is not allowed in filter'
    expect(isFilterFieldRejected(new Error(measured))).toBe(false)
  })

  it('другие коды портала отказом фильтра НЕ считаются — они лечатся повтором', () => {
    // Недоступность, истёкший токен и отказ в правах обязаны лететь наверх и давать чистый ретрай.
    for (const code of ['ACCESS_DENIED', 'expired_token', 'QUERY_LIMIT_EXCEEDED', 'NOT_FOUND', '']) {
      expect(isFilterFieldRejected(new PortalRestError('x', code, 'm')), code || '(пусто)').toBe(false)
    }
  })
})

describe('firstPortalErrorCode', () => {
  it('берёт код из объектов ошибок SDK', () => {
    const res = {
      getErrorMessages: () => ['Invalid filter'],
      getErrors: () => [Object.assign(new Error('Invalid filter'), { code: 'INVALID_ARG_VALUE' })]
    }
    expect(firstPortalErrorCode(res)).toBe('INVALID_ARG_VALUE')
  })

  it('работает с ИТЕРАТОРОМ, а не только с массивом', () => {
    // ⚠ SDK отдаёт `IterableIterator<Error>` (значения Map), а не массив. Объявление массивом
    // ломало совместимость типов — поймано компиляторным дрейф-гардом; тест держит и поведение.
    const res = {
      getErrorMessages: () => ['x'],
      getErrors: () => new Map([['k', Object.assign(new Error('x'), { code: 'ACCESS_DENIED' })]]).values()
    }
    expect(firstPortalErrorCode(res)).toBe('ACCESS_DENIED')
  })

  it('нет аксессора / нет кода / аксессор бросает — пустая строка, но НЕ исключение', () => {
    // Потеря кода не должна превращаться в потерю самой ошибки: вызывающий всё равно бросит по
    // сообщению, просто без классификации.
    expect(firstPortalErrorCode({ getErrorMessages: () => ['x'] })).toBe('')
    expect(firstPortalErrorCode({ getErrorMessages: () => ['x'], getErrors: () => [new Error('no code')] })).toBe('')
    expect(firstPortalErrorCode({
      getErrorMessages: () => ['x'],
      getErrors: () => {
        throw new Error('аксессор SDK сломался')
      }
    })).toBe('')
  })

  it('пропускает ошибки без кода и берёт первый настоящий', () => {
    const res = {
      getErrorMessages: () => ['a', 'b'],
      getErrors: () => [new Error('без кода'), Object.assign(new Error('b'), { code: 'INVALID_ARG_VALUE' })]
    }
    expect(firstPortalErrorCode(res)).toBe('INVALID_ARG_VALUE')
  })
})
