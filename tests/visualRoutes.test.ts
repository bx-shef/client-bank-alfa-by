import { describe, expect, it } from 'vitest'
import { VISUAL_ROUTES } from './visual/routes'
import { PUBLIC_ROUTES, SERVICE_ROUTES } from '../app/config/routes'

// Список маршрутов визуальных тестов — независимая копия, и без этой сверки он молча отстанет:
// добавили страницу, `seoMetaPlacement.test.ts` покраснел и заставил её классифицировать, а
// визуальной защиты у неё не появилось и никто об этом не узнал.
describe('покрытие визуальных регресс-тестов', () => {
  const covered = new Set(VISUAL_ROUTES.map(r => r.path.split('?')[0]))

  it('каждая страница приложения снимается', () => {
    for (const route of [...PUBLIC_ROUTES, ...SERVICE_ROUTES]) {
      expect(covered, `маршрут ${route} без визуального эталона`).toContain(route)
    }
  })

  it('лишних маршрутов нет — кроме статической страницы ошибки', () => {
    const known = new Set<string>([...PUBLIC_ROUTES, ...SERVICE_ROUTES, '/404.html'])
    for (const route of covered) {
      expect(known, `неизвестный маршрут ${route}`).toContain(route)
    }
  })

  it('slug уникальны — иначе эталоны затирали бы друг друга', () => {
    const slugs = VISUAL_ROUTES.map(r => r.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('у каждого маршрута есть хотя бы одна тема', () => {
    for (const route of VISUAL_ROUTES) expect(route.themes.length).toBeGreaterThan(0)
  })
})
