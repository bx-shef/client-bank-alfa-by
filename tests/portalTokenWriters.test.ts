import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Кто и с какими правами пишет в `portal_tokens` (#510), той же формы гард, что у банковского
// стора (#505/#509).
//
// ⚠ Зачем структурно, а не «прочитаем на ревью». Разница между `INSERT … ON CONFLICT DO UPDATE`
// и голым `UPDATE` не видна ни в одном функциональном тесте: на живой строке оба возвращают
// одно и то же и делают одно и то же. Она проявляется РОВНО в одном сценарии — когда строки уже
// нет, — а этот сценарий возникает при гонке с деинсталляцией, то есть редко, недетерминированно
// и в проде. Именно так дефект и прожил незамеченным: собственный комментарий модуля его
// описывал, тесты были зелёными, а строка удалённого портала оставалась в базе.

const ROOT = join(import.meta.dirname, '..')

describe('писатели portal_tokens классифицированы', () => {
  it('список писателей ЗАКРЫТ — новый обязан получить причину', () => {
    const store = readFileSync(join(ROOT, 'server/utils/tokenStore.ts'), 'utf8')
    const writers = new Set<string>()
    for (const m of store.matchAll(/^export (?:async )?function (\w+)/gm)) {
      const start = m.index!
      const next = store.indexOf('\nexport ', start + 1)
      const body = store.slice(start, next < 0 ? undefined : next)
      if (/(?:INSERT INTO|UPDATE|DELETE FROM)\s+portal_tokens/.test(body)) writers.add(m[1]!)
    }

    // Каждому — своя причина. Менять список молча нельзя: это и есть решение.
    const CLASSIFIED: Record<string, string> = {
      // СОЗДАЁТ регистрацию. Зовут только обработчики `ONAPPINSTALL` — роут события и
      // register-ветка воркера, — где портал прямо сейчас установил приложение. Гард тумбстоуна
      // (#77) на месте: устаревший register не воскрешает портал.
      saveToken: 'upsert-install-only',
      // ОБНОВЛЯЕТ существующую. Все пути рефреша ходят сюда: `false` значит «регистрации уже нет»,
      // и создавать её рефреш не вправе (#510).
      updatePortalTokenSecrets: 'update-only-refresh',
      // Удаление терминально: строки не станет в любом порядке, а обновление это увидит.
      deleteToken: 'delete-is-terminal',
      // ⚠ Пишет РОВНО ОДНУ колонку `grant_revoked_at` (#574) и только когда она пуста: отсчёт
      // идёт от ПЕРВОГО отказа, иначе срок отодвигался бы каждым тиком и портал не был бы стёрт
      // никогда. UPDATE-only, как все после #510. `updated_at` НЕ трогает — по нему выбираются
      // порталы для продления, и сдвинув его, отметка выключила бы сама себя.
      markGrantRevoked: 'update-only-one-column'
      // ⚠ Обратной ей — отдельного `clearGrantRevoked` — БОЛЬШЕ НЕТ, и это не упрощение. Снятие
      // отметки вшито прямо в `updatePortalTokenSecrets` и `saveToken`: успешное обновление токена
      // и снятая отметка обязаны быть ОДНОЙ записью строки. Отдельным запросом на залоченном
      // соединении оно было опасно — упав, переводило транзакцию в aborted, catch его глотал, а
      // следующий COMMIT молча становился ROLLBACK: токен у Б24 уже ротирован, а у нас не
      // сохранён, то есть портал сломан навсегда. Вернуть отдельного писателя — значит вернуть
      // эту ловушку.
    }
    expect([...writers].sort()).toEqual(Object.keys(CLASSIFIED).sort())
  })

  /**
   * Как имя `saveToken` из `tokenStore` вообще попадает в область видимости файла.
   *
   * ⚠ Форм больше одной, и мутационное ревью это доказало: прежняя проверка смотрела ТОЛЬКО на
   * именованный импорт `import { saveToken } from '…tokenStore'`, и обход через
   * `import * as NS from './tokenStore'` + `NS.saveToken(q, t, 0)` воспроизводил баг #510 целиком
   * при 75 зелёных тестах. Позвать можно лишь то, что ввёл в область видимости, — значит и
   * проверять надо ввод, а не вызов.
   */
  function reachesSaveToken(text: string): string[] {
    const ways: string[] = []
    // 1. Именованный импорт, в том числе под псевдонимом: `saveToken as persist`.
    for (const m of text.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']*tokenStore)'/gm)) {
      for (const raw of m[1]!.split(',')) {
        const [name, alias] = raw.trim().split(/\s+as\s+/).map(x => x.trim())
        if (name === 'saveToken') ways.push(`именованный импорт${alias ? ` как ${alias}` : ''}`)
      }
    }
    // 2. Неймспейс-импорт: сам по себе безобиден, нарушение — обращение к члену.
    for (const m of text.matchAll(/^import\s+\*\s+as\s+(\w+)\s+from\s+'([^']*tokenStore)'/gm)) {
      const ns = m[1]!
      if (new RegExp(`\\b${ns}\\.saveToken\\b`).test(text)) ways.push(`неймспейс ${ns}.saveToken`)
    }
    // 3. Реэкспорт — тот же ввод в область видимости, только для чужих модулей.
    for (const m of text.matchAll(/^export\s+\{([^}]*)\}\s+from\s+'([^']*tokenStore)'/gm)) {
      if (/\bsaveToken\b/.test(m[1]!)) ways.push('реэкспорт')
    }
    // 4. Динамический импорт — редкость, но ввод такой же настоящий.
    if (/await\s+import\(\s*'[^']*tokenStore'\s*\)/.test(text)) ways.push('динамический import()')
    return ways
  }

  it('регулярки не разучились находить своё', () => {
    // Без этого «нарушителей нет» достигалось бы и сломанным поиском.
    const probe = 'import { getToken, saveToken } from \'./tokenStore\''
    expect(reachesSaveToken(probe)).toHaveLength(1)
    expect(reachesSaveToken('import { saveToken as persist } from \'./tokenStore\'')).toHaveLength(1)
    expect(reachesSaveToken('import * as S from \'./tokenStore\'\nS.saveToken(q, t, 0)')).toHaveLength(1)
    expect(reachesSaveToken('import { updatePortalTokenSecrets } from \'./tokenStore\'')).toEqual([])
  })

  it('пути РЕФРЕША не получают создающий `saveToken` НИКАКОЙ формой ввода', () => {
    // ⚠ Главное правило issue. Функциональный тест обхода не увидит — на живом портале upsert
    // отработает штатно, а разойдётся всё только в гонке с деинсталляцией.
    const REFRESH_PATHS = ['server/utils/ensureAccessToken.ts', 'server/utils/b24Sdk.ts']
    for (const rel of REFRESH_PATHS) {
      const text = readFileSync(join(ROOT, rel), 'utf8')
      expect(reachesSaveToken(text), `${rel} получает создающий saveToken`).toEqual([])
      expect(text, `${rel} не импортирует updatePortalTokenSecrets`).toMatch(/updatePortalTokenSecrets/)
    }
  })

  it('создающий `saveToken` доступен ТОЛЬКО обработчикам установки', () => {
    // Обратная сторона: позовёт его завтра кто-то третий — решение должно приниматься здесь.
    // ⚠ Проверяется ВВОД в область видимости, а не текст вызова: имя `saveToken` носит ещё и поле
    // DI-порта (у банковского близнеца `ensureBankToken` ровно так же), и запрет по вызову
    // объявил бы нарушителем сам порт. К тому же прежняя версия сверяла имя первого аргумента
    // (`dbQuery|query|infra.query`) — а в `ensureAccessToken` переменная зовётся `q`, так что и
    // ПРЯМОЙ вызов там не был бы замечен.
    const ALLOWED = new Set([
      join('server', 'utils', 'tokenStore.ts'), // определение
      join('server', 'api', 'b24', 'events.post.ts'), // синхронный фолбэк установки
      join('server', 'queue', 'worker.ts') // register-ветка воркера событий
    ])
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name)
        if (entry.isDirectory()) walk(rel)
        else if (entry.name.endsWith('.ts') && !ALLOWED.has(rel)) {
          const ways = reachesSaveToken(readFileSync(join(ROOT, rel), 'utf8'))
          if (ways.length) offenders.push(`${rel}: ${ways.join(', ')}`)
        }
      }
    }
    walk('server')
    expect(offenders).toEqual([])
  })
})
