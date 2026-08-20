import { describe, expect, it } from 'vitest'
import { isSamePath, trimTrailingSlash } from '../app/utils/routePath'

// Правило родилось из живой регрессии (#537): отложенный редирект фрейма слайдера сверял текущий
// путь с исходным строгим `!==`, а веб-сервер отдаёт статику по `/app/` — и редирект отменялся
// всегда, «решив», что пользователь ушёл со страницы.
describe('isSamePath', () => {
  it('не различает пути по хвостовому слэшу', () => {
    expect(isSamePath('/app', '/app/')).toBe(true)
    expect(isSamePath('/app/', '/app')).toBe(true)
    expect(isSamePath('/app', '/app')).toBe(true)
  })

  it('разные пути остаются разными', () => {
    expect(isSamePath('/app', '/settings')).toBe(false)
    expect(isSamePath('/app', '/app/settings')).toBe(false)
    // ⚠ Не префикс: иначе уход на /import читался бы как «мы всё ещё на /im».
    expect(isSamePath('/im', '/import')).toBe(false)
  })

  it('корень остаётся корнем', () => {
    // Срезать слэш здесь значило бы получить пустой путь, который не равен уже ничему.
    expect(trimTrailingSlash('/')).toBe('/')
    expect(isSamePath('/', '/')).toBe(true)
    expect(isSamePath('/', '')).toBe(false)
  })
})
