import { describe, expect, it } from 'vitest'
import { APP_URI_PLACEMENT, buildAppUriLink, buildAppUriPath, isValidAppCode } from '../app/utils/appUriLink'
import {
  buildPlacementBindCall, buildPlacementUnbindCall, isPlacementAlreadyBound, PLACEMENT_ALREADY_BOUND
} from '../app/utils/b24PlacementRegister'

// Ссылка на экраны приложения — точка встраивания `REST_APP_URI` (#19). ВТОРОЙ, параллельный вход:
// первый (кнопки внутри приложения через `openSliderAppPage`) этими модулями не пользуется вовсе.

describe('код приложения в ссылке', () => {
  it('принимает и символьный код тиражного, и client_id локального', () => {
    expect(isValidAppCode('shef.bankimport')).toBe(true)
    expect(isValidAppCode('local.66ba434d853c87.18550109')).toBe(true)
  })

  // ⚠ Код подставляется в ПУТЬ: значение со слэшем или `..` увело бы ссылку на чужой адрес портала.
  // Код приходит от портала (`app.info`), то есть извне, — проверять обязаны.
  it('отвергает всё, что может увести ссылку из своего пути', () => {
    for (const bad of ['', '  ', 'a/b', '../evil', 'a?b', 'a#b', 'a b', '.hidden']) {
      expect(isValidAppCode(bad), bad).toBe(false)
    }
  })
})

describe('buildAppUriPath', () => {
  it('собирает адрес слайдера без параметров', () => {
    expect(buildAppUriPath('shef.bankimport')).toBe('/marketplace/view/shef.bankimport/')
  })

  // ⚠ ПЕРВАЯ ПО ЧАСТОТЕ ОШИБКА из документации: голые ключи строки запроса до обработчика НЕ
  // доезжают вовсе — в PLACEMENT_OPTIONS попадает только то, что лежало в `params[...]`. Снаружи
  // промах выглядит как «слайдер открылся, но не туда».
  it('кладёт параметры ИМЕННО в params[…]', () => {
    const path = buildAppUriPath('shef.bankimport', { place: 'app-import' })
    // ⚠ Скобки ЛИТЕРАЛЬНЫЕ — ровно та форма, что в документации (`?params[docId]=42`). Именно её
    // человек узнаёт в скопированной ссылке, и именно её мы сверяем: процентная кодировка скобок,
    // возможно, тоже прошла бы, но «возможно» не измерено, а форма из документации — измерена.
    expect(path).toBe('/marketplace/view/shef.bankimport/?params[place]=app-import')
    expect(path).not.toContain('?place=')
  })

  it('кодирует значение — оно попадает в строку запроса', () => {
    expect(buildAppUriPath('x', { place: 'a b&c' })).toContain('a%20b%26c')
  })

  it('негодный код ⇒ null, а не полуссылка', () => {
    expect(buildAppUriPath('a/b', { place: 'app-import' })).toBeNull()
  })
})

describe('buildAppUriLink', () => {
  it('абсолютная ссылка строится по ПОРТАЛЬНОМУ домену', () => {
    expect(buildAppUriLink('client.bitrix24.by', 'shef.bankimport', { place: 'app-import' }))
      .toBe('https://client.bitrix24.by/marketplace/view/shef.bankimport/?params[place]=app-import')
  })

  it('схему в домене терпим — её пишут руками', () => {
    expect(buildAppUriLink('https://c.bitrix24.by/', 'x')).toBe('https://c.bitrix24.by/marketplace/view/x/')
  })

  // ⚠ Пустая или кривая половина ⇒ null: полуссылку человек перешлёт коллеге, и разбираться будет он.
  it('без домена или с мусором в нём ссылки нет', () => {
    expect(buildAppUriLink('', 'x')).toBeNull()
    expect(buildAppUriLink('host/path', 'x')).toBeNull()
    expect(buildAppUriLink('host bitrix24', 'x')).toBeNull()
    expect(buildAppUriLink('client.bitrix24.by', '')).toBeNull()
  })
})

describe('регистрация обработчика ссылки', () => {
  it('строит placement.bind на нашу точку', () => {
    const call = buildPlacementBindCall('https://app.test/open', 'Экраны приложения')
    expect(call).toEqual({
      method: 'placement.bind',
      params: { PLACEMENT: APP_URI_PLACEMENT, HANDLER: 'https://app.test/open', TITLE: 'Экраны приложения' }
    })
  })

  // ⚠ Относительный адрес портал бы ПРИНЯЛ и открывал бы его от СВОЕГО домена — обработчиком стала
  // бы страница портала, а не наша. Тот же fail-safe, что у привязки событий.
  it('не абсолютный https-адрес ⇒ null, регистрацию не шлём', () => {
    for (const bad of ['', '/open', 'http://app.test/open', 'app.test/open', 'https://app.test']) {
      expect(buildPlacementBindCall(bad, 'x'), bad).toBeNull()
    }
  })

  it('снятие регистрации — единственный способ сменить адрес', () => {
    expect(buildPlacementUnbindCall()).toEqual({
      method: 'placement.unbind', params: { PLACEMENT: APP_URI_PLACEMENT }
    })
    expect(buildPlacementUnbindCall('https://app.test/open').params).toMatchObject({
      HANDLER: 'https://app.test/open'
    })
  })
})

describe('«уже зарегистрирован» — не отказ', () => {
  // ⚠ У точки ОДНА регистрация, поэтому на каждой переустановке повтор отвечает
  // `ERROR_PLACEMENT_MAX_COUNT`. Считать это ошибкой — значит красить исправный портал в жёлтое.
  it('узнаётся в разных обёртках ответа', () => {
    expect(isPlacementAlreadyBound(PLACEMENT_ALREADY_BOUND)).toBe(true)
    expect(isPlacementAlreadyBound({ error: PLACEMENT_ALREADY_BOUND })).toBe(true)
    expect(isPlacementAlreadyBound({ message: `Ошибка: ${PLACEMENT_ALREADY_BOUND}` })).toBe(true)
    expect(isPlacementAlreadyBound(new Error(PLACEMENT_ALREADY_BOUND))).toBe(true)
  })

  // ⚠ Смотрим на КОД, а не на человеческое описание: текст портал отдаёт локализованным, и завтра
  // он придёт на другом языке.
  it('настоящий отказ за него не выдаётся', () => {
    expect(isPlacementAlreadyBound(new Error('ACCESS_DENIED'))).toBe(false)
    expect(isPlacementAlreadyBound(null)).toBe(false)
    expect(isPlacementAlreadyBound(undefined)).toBe(false)
    expect(isPlacementAlreadyBound({})).toBe(false)
  })
})
