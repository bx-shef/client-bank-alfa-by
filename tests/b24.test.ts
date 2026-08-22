import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAQ } from '~/utils/faq'
import { APP_SLIDER_PLACE_IMPORT, APP_SLIDER_PLACE_SETTINGS, B24_ALL_BOUND_EVENTS, B24_BOUND_EVENTS, B24_DELETION_EVENTS, B24_REQUIRED_SCOPES, helpSliderPlace, marketDetailPath, sliderRouteForPlace } from '~/config/b24'

describe('B24_REQUIRED_SCOPES', () => {
  it('lists crm, sale, im, imbot, documentgenerator, userfieldconfig, user_brief and placement', () => {
    // `sale` — resolve an order-id → its payments (sale.payment.list, #172).
    // `documentgenerator` — the via-document bridge (crm.documentgenerator.document.list, #109).
    // `userfieldconfig` — distribution SP provisioning creates its custom fields (#408); the code
    // called `userfieldconfig.add` while the scope was NOT requested, so provisioning failed on
    // every portal that hadn't been granted it by hand.
    expect([...B24_REQUIRED_SCOPES]).toEqual(['crm', 'sale', 'im', 'imbot', 'documentgenerator', 'userfieldconfig', 'user_brief', 'placement'])
  })

  it('has no duplicate scopes', () => {
    expect(new Set(B24_REQUIRED_SCOPES).size).toBe(B24_REQUIRED_SCOPES.length)
  })
})

describe('B24_ALL_BOUND_EVENTS', () => {
  it('is the lifecycle events followed by the deletion events (§9.2), no duplicates', () => {
    expect([...B24_ALL_BOUND_EVENTS]).toEqual([...B24_BOUND_EVENTS, ...B24_DELETION_EVENTS])
    expect(new Set(B24_ALL_BOUND_EVENTS).size).toBe(B24_ALL_BOUND_EVENTS.length)
  })
})

describe('marketDetailPath', () => {
  it('builds the Bitrix24 Market detail path from a listing code', () => {
    expect(marketDetailPath('shef.bankimport')).toBe('/marketplace/detail/shef.bankimport/')
  })

  it('trims surrounding whitespace before building the path', () => {
    expect(marketDetailPath('  shef.bankimport  ')).toBe('/marketplace/detail/shef.bankimport/')
  })

  it('returns null for an empty / whitespace-only code (feature off)', () => {
    expect(marketDetailPath('')).toBeNull()
    expect(marketDetailPath('   ')).toBeNull()
  })
})

describe('sliderRouteForPlace', () => {
  it('переводит place в НАШ маршрут', () => {
    expect(sliderRouteForPlace(APP_SLIDER_PLACE_SETTINGS)).toBe('/settings')
    expect(sliderRouteForPlace(APP_SLIDER_PLACE_IMPORT)).toBe('/import')
  })

  it('чужой/пустой place не ведёт никуда — дефолта здесь быть не должно', () => {
    // Дефолт на '/settings' отправил бы фрейм импорта в настройки, а произвольная строка
    // из PLACEMENT_OPTIONS — это вход, которым мы не управляем.
    expect(sliderRouteForPlace('crm-detail-tab')).toBeUndefined()
    expect(sliderRouteForPlace('')).toBeUndefined()
    expect(sliderRouteForPlace(undefined)).toBeUndefined()
    expect(sliderRouteForPlace(null)).toBeUndefined()
  })
})

describe('контекстная справка через слайдер (#576 п.2)', () => {
  it('place справки ведёт на её якорь', () => {
    for (const e of FAQ) {
      expect(sliderRouteForPlace(helpSliderPlace(e.id))).toBe(`/help#${e.id}`)
    }
  })

  it('неизвестный якорь открывает справку с начала, а не пустоту', () => {
    // ⚠ `place` приходит от портала, то есть снаружи. Подставить его в адрес как есть значило бы
    // пустить чужое значение в маршрут; а опечатка в нашей же ссылке иначе давала бы пустой экран.
    expect(sliderRouteForPlace(helpSliderPlace('нет-такого'))).toBe('/help')
    expect(sliderRouteForPlace(helpSliderPlace('../settings'))).toBe('/help')
    expect(sliderRouteForPlace(helpSliderPlace(''))).toBe('/help')
  })

  it('якоря контекстных ссылок в UI существуют в справке', () => {
    // ⚠ Ссылка с несуществующим якорем — тихий дефект: кнопка работает, справка открывается, но
    // человек попадает не туда, где ответ на его вопрос.
    const ids = new Set(FAQ.map(e => e.id))
    const files = readdirSync(join(process.cwd(), 'app'), { recursive: true, encoding: 'utf8' })
      .map(String)
      // ⚠ Сам компонент ссылки исключён: у него `anchor` — имя пропа, а не значение якоря.
      .filter(f => f.endsWith('.vue') && !f.endsWith('HelpLink.vue'))
    const used: string[] = []
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), 'app', f), 'utf8')
      for (const m of src.matchAll(/anchor="([^"]+)"/g)) used.push(m[1]!)
    }
    expect(used.length, 'контекстных ссылок нет вовсе — проверять нечего').toBeGreaterThan(0)
    expect(used.filter(a => !ids.has(a)), 'ссылка ведёт на несуществующий раздел справки').toEqual([])
  })
})
