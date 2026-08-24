import { describe, expect, it } from 'vitest'
import { firstPortalErrorCode, isSettingsRejection, PortalRestError, portalErrorCode } from '../server/utils/portalError'

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

  it('читает код и с СЫРОЙ ошибки SDK — без этого механизм мёртв', () => {
    // ⚠ Главный случай, и первая редакция его не покрывала. `INVALID_ARG_VALUE` для SDK — ЖЁСТКИЙ
    // код, поэтому `abstract-http.mjs` не возвращает неуспешный результат, а БРОСАЕТ свой
    // `AjaxError`. То есть до нашей ветки `!res.isSuccess` дело не доходит вовсе, и проверка
    // только на `PortalRestError` не срабатывала бы никогда.
    expect(portalErrorCode(Object.assign(new Error('Invalid filter'), { code: 'INVALID_ARG_VALUE' })))
      .toBe('INVALID_ARG_VALUE')
  })

  it('ошибка без кода — пустая строка, а не бросок', () => {
    // До вызывающего ошибка доезжает через `catch`, то есть с типом `unknown`: сюда прилетит что
    // угодно, включая не-Error.
    expect(portalErrorCode(new Error('boom'))).toBe('')
    expect(portalErrorCode('строка')).toBe('')
    expect(portalErrorCode(null)).toBe('')
    expect(portalErrorCode(undefined)).toBe('')
    // Нестроковый `code` не считается кодом.
    expect(portalErrorCode(Object.assign(new Error('x'), { code: 400 }))).toBe('')
  })
})

describe('isSettingsRejection', () => {
  const raw = (code: string) => Object.assign(new Error('portal said no'), { code })

  it('поле: узнаёт отказ по КОДУ', () => {
    const measured = 'Invalid filter: field \'UF_CRM_NOPE\' is not allowed in filter'
    expect(isSettingsRejection(new PortalRestError(measured, 'INVALID_ARG_VALUE', 'crm.item.list'), 'field')).toBe(true)
    expect(isSettingsRejection(raw('INVALID_ARG_VALUE'), 'field')).toBe(true)
  })

  it('НЕ опирается на текст: тот же текст без кода отказом не считается', () => {
    // ⚠ Несущее. Описание приходит на языке портала; проверка по подстроке молча перестала бы
    // срабатывать на англоязычном портале, а «invalid filter» мог бы прийти и от другого.
    const measured = 'Invalid filter: field \'UF_CRM_NOPE\' is not allowed in filter'
    expect(isSettingsRejection(new Error(measured), 'field')).toBe(false)
  })

  it('смарт-процесс: ловит ЗАМЕРЕННЫЕ коды неверного entityTypeId', () => {
    // ⚠ Ради этого набор и разделён. Замерено 2026-08-23: несуществующий entityTypeId отвечает
    // `NOT_FOUND` («Смарт-процесс не найден»), а `entityTypeId: 0` — `ENTITY_TYPE_NOT_SUPPORTED`.
    // Первая редакция ловила только `INVALID_ARG_VALUE`, то есть для `smart-id` не срабатывала бы
    // на самой вероятной ошибке админа НИКОГДА — при зелёных тестах.
    for (const code of ['INVALID_ARG_VALUE', 'NOT_FOUND', 'ENTITY_TYPE_NOT_SUPPORTED']) {
      expect(isSettingsRejection(raw(code), 'entity'), code).toBe(true)
    }
  })

  it('НА ПУТИ СДЕЛКИ `NOT_FOUND` отказом настройки НЕ считается', () => {
    // ⚠ Там entityTypeId — наша собственная константа (2), поэтому `NOT_FOUND` означает что-то
    // другое, и проглотив его, мы спрятали бы НАШУ ошибку за «проверьте настройки».
    expect(isSettingsRejection(raw('NOT_FOUND'), 'field')).toBe(false)
    expect(isSettingsRejection(raw('ENTITY_TYPE_NOT_SUPPORTED'), 'field')).toBe(false)
  })

  it('коды, которые лечатся повтором, отказом настройки не считаются ни там, ни там', () => {
    for (const code of ['ACCESS_DENIED', 'expired_token', 'QUERY_LIMIT_EXCEEDED', '']) {
      expect(isSettingsRejection(raw(code), 'field'), `field/${code}`).toBe(false)
      expect(isSettingsRejection(raw(code), 'entity'), `entity/${code}`).toBe(false)
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

describe('portalErrorCode: обёртка SDK (#574)', () => {
  // ⚠ ЗАМЕРЕНО запуском версии 2.0.0: `RefreshTokenError` наследует `SdkError` как БРАТ `AjaxError`,
  // поэтому `instanceof AjaxError === false`, и `abstract-http.mjs` заворачивает его в
  // `AjaxError{code:'JSSDK_UNKNOWN_ERROR', originalError: <настоящая>}`. Без разворачивания
  // `invalid_grant` доезжает до вызывающего как `JSSDK_UNKNOWN_ERROR`, и сигнал уборщика мёртв.
  // Тесты пропустили это дважды, потому что собирали ошибку руками вместо реального пути.
  it('достаёт настоящий код из-под обёртки', () => {
    const wrapped = Object.assign(new Error('dead'), {
      code: 'JSSDK_UNKNOWN_ERROR',
      originalError: Object.assign(new Error('grant is dead'), { code: 'invalid_grant' })
    })
    expect(portalErrorCode(wrapped)).toBe('invalid_grant')
  })

  it('обычный код читается как раньше и обёрткой не перебивается', () => {
    expect(portalErrorCode(Object.assign(new Error('x'), { code: 'INVALID_ARG_VALUE' }))).toBe('INVALID_ARG_VALUE')
  })

  it('обёртка без вложенного кода остаётся собой, а не пустотой', () => {
    // Иначе диагностика потеряла бы единственное, что вообще было известно об ошибке.
    expect(portalErrorCode(Object.assign(new Error('x'), { code: 'JSSDK_UNKNOWN_ERROR' }))).toBe('JSSDK_UNKNOWN_ERROR')
  })

  it('мусор не роняет', () => {
    expect(portalErrorCode(null)).toBe('')
    expect(portalErrorCode({ originalError: null })).toBe('')
  })
})
