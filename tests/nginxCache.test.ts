import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Кэширование статики (#555).
//
// Симптом, ради которого этот тест написан: приложение выкачено, а слайдер в портале открывается
// СТАРОЙ сборкой — то есть свежий код до пользователя не доезжает, и правка выглядит нерабочей.
// Причина была в тишине: без `Cache-Control` nginx не говорит о кэшировании ничего, и браузер
// применяет эвристику. Тишину в конфиге глазами не заметишь — поэтому проверяем.

const CONF = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8')

/** Тело `location`-блока по его заголовку. */
function block(header: string): string {
  const start = CONF.indexOf(header)
  expect(start, `в nginx.conf нет блока ${header}`).toBeGreaterThan(-1)
  const end = CONF.indexOf('\n    }', start)
  return CONF.slice(start, end)
}

describe('nginx: кэширование', () => {
  it('HTML отдаётся с no-cache — иначе выкат доезжает не до всех', () => {
    // Заголовок стоит на уровне server (не в `location /`): add_header внутри location отменяет
    // весь унаследованный набор, и туда пришлось бы дублировать CSP.
    const serverLevel = CONF.slice(CONF.indexOf('add_header Cache-Control "no-cache"'))
    expect(serverLevel).toContain('add_header Cache-Control "no-cache" always;')
  })

  it('хешированные ассеты остаются immutable — сверять их незачем', () => {
    // У `/_nuxt/` собственный набор заголовков, поэтому серверный no-cache его не задевает.
    expect(block('location /_nuxt/ {')).toContain('add_header Cache-Control "public, immutable" always;')
  })

  it('форма Б24 — тоже HTML, и тоже не кэшируется', () => {
    // ⚠ У блока свои add_header, а они ОТМЕНЯЮТ серверные: без явной строки этот документ
    // остался бы единственным, застревающим в кэше.
    expect(block('location = /b24-form.html {')).toContain('add_header Cache-Control "no-cache" always;')
  })
})
