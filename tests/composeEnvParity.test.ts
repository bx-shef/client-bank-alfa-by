import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Переменная, прочитанная кодом, но не объявленная в `docker-compose.prod.yml` (#485, находка ревью).
//
// `docker compose` пробрасывает в контейнер ТОЛЬКО то, что перечислено в `environment:`. Значит
// `process.env.X` в коде и отсутствие `X` в compose дают самый неприятный вид поломки: оператор
// выставляет переменную в `.env`, документация обещает, что она работает, а backend всегда видит
// `undefined` и молча берёт дефолт. Ошибки нет, в логах ничего, проверить можно только замером.
//
// ⚠ Это не гипотеза: сам `docker-compose.prod.yml` несёт про это предупреждение прозой («the docs
// promise they are configurable — they are not unless declared here»), и ровно на этом
// споткнулся PR #518 — добавил `PENDING_MAX_AGE_DAYS` в код, `.env.example` и три документа, а в
// compose не добавил. Комментарий-предупреждение не сработал; нужен тест.
//
// ⚠ Проверяется ИМЕННО крон-плагин, а не весь `server/`: это единственное место, где сходятся
// периодические задачи и их настройки, и где цена молчаливого дефолта — ретенция ПДн и частота
// обращений к банку. Расширять охват на весь сервер сейчас нельзя: там есть переменные, которые
// заведомо задаются не через compose (например, ключи для дев-скриптов).

const ROOT = join(import.meta.dirname, '..')
const PLUGIN = readFileSync(join(ROOT, 'server/plugins/queue.ts'), 'utf8')
const COMPOSE = readFileSync(join(ROOT, 'docker-compose.prod.yml'), 'utf8')

/** Переменные, которые читает крон-плагин. */
function envReads(): string[] {
  return [...new Set([...PLUGIN.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map(m => m[1]!))].sort()
}

/** Переменные, объявленные в `environment:` любого сервиса compose. */
function envDeclared(): Set<string> {
  return new Set([...COMPOSE.matchAll(/^\s{6}([A-Z][A-Z0-9_]*):\s/gm)].map(m => m[1]!))
}

describe('переменные крон-плагина объявлены в docker-compose.prod.yml (#485)', () => {
  it('регулярки не разучились находить своё', () => {
    // Без этого «нарушителей нет» достигалось бы и сломанным поиском — тест выглядел бы зелёным,
    // ничего не проверяя.
    expect(envReads().length).toBeGreaterThan(5)
    expect(envDeclared().size).toBeGreaterThan(10)
    expect(envDeclared()).toContain('TOMBSTONE_TTL_DAYS')
  })

  /**
   * Переменные, которых в compose нет ЗАКОННО. Список закрытый: новая переменная обязана либо
   * попасть в compose, либо получить здесь причину — молча пропасть она не может.
   */
  const BAKED_AT_BUILD: Record<string, string> = {
    // Зашивается в образ на сборке (`Dockerfile`: ARG + ENV, значение из repo-переменной CI), а не
    // подаётся рантаймом. Объявить её в compose означало бы дать пустую строку поверх запечённого
    // значения — то есть сломать то, что работает.
    NUXT_PUBLIC_SITE_URL: 'baked into the image by Dockerfile ARG/ENV'
  }

  it('каждая прочитанная переменная доезжает до контейнера', () => {
    const declared = envDeclared()
    const missing = envReads().filter(name => !declared.has(name) && !(name in BAKED_AT_BUILD))
    expect(missing).toEqual([])
  })

  it('исключения не протухли — каждое всё ещё читается плагином', () => {
    // Иначе список исключений превращается в свалку, которая гасит будущие настоящие находки.
    expect(Object.keys(BAKED_AT_BUILD).filter(n => !envReads().includes(n))).toEqual([])
  })
})
