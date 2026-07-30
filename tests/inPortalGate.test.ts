import { describe, expect, it } from 'vitest'
import { isPreviewQuery, portalGateState } from '~/utils/inPortalGate'

// Гейт «только внутри портала» (#414). Здесь легко ошибиться в пользу «показать», а fail-open —
// это ровно тот случай, когда пользователь видит пустой интерфейс и считает приложение сломанным.

describe('portalGateState', () => {
  it('внутри портала — показываем', () => {
    expect(portalGateState({ resolved: true, inPortal: true, preview: false })).toBe('ok')
  })

  it('снаружи — заглушка, а не интерфейс', () => {
    expect(portalGateState({ resolved: true, inPortal: false, preview: false })).toBe('outside')
  })

  it('пока проверка не завершилась — НИ то, ни другое', () => {
    // Без этого состояния страница мелькнула бы интерфейсом и схлопнулась в заглушку (или
    // наоборот) — читается как поломка. `init()` асинхронный, промежуток реален.
    expect(portalGateState({ resolved: false, inPortal: false, preview: false })).toBe('checking')
    expect(portalGateState({ resolved: false, inPortal: true, preview: false })).toBe('checking')
  })

  it('preview перекрывает всё — иначе отвалилась бы вся визуальная приёмка', () => {
    // На нём держатся тесты, монтирующие страницы вне фрейма, и снятие скриншотов.
    expect(portalGateState({ resolved: false, inPortal: false, preview: true })).toBe('ok')
    expect(portalGateState({ resolved: true, inPortal: false, preview: true })).toBe('ok')
  })
})

describe('isPreviewQuery', () => {
  it('срабатывает только на явное preview=1', () => {
    expect(isPreviewQuery('1')).toBe(true)
    expect(isPreviewQuery(['0', '1'])).toBe(true)
  })

  it('не срабатывает на пустое, чужое и на иные значения', () => {
    // Голый `?preview` без значения роутер отдаёт как `null` — не обход: иначе случайная ссылка
    // открывала бы приложение снаружи портала в неработающем виде.
    expect(isPreviewQuery(null)).toBe(false)
    expect(isPreviewQuery(undefined)).toBe(false)
    expect(isPreviewQuery('')).toBe(false)
    expect(isPreviewQuery('0')).toBe(false)
    expect(isPreviewQuery('true')).toBe(false)
    expect(isPreviewQuery([])).toBe(false)
  })
})
