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
      deleteToken: 'delete-is-terminal'
    }
    expect([...writers].sort()).toEqual(Object.keys(CLASSIFIED).sort())
  })

  it('пути РЕФРЕША вообще не ИМПОРТИРУЮТ создающий `saveToken`', () => {
    // ⚠ Главное правило issue, и обойти его тривиально: функции лежат в одном модуле и делают
    // почти одно и то же. Функциональный тест обхода не увидит — на живом портале upsert
    // отработает штатно, а разойдётся всё только в гонке с деинсталляцией.
    //
    // ⚠ Проверяется ИМПОРТ, а не текст вызова. Имя `saveToken` носит ещё и поле DI-порта (у
    // банковского близнеца `ensureBankToken` ровно так же — порт зовётся `saveToken`, а связан с
    // UPDATE-only `updateBankTokenSecrets`), поэтому запрет по вызову объявил бы нарушителем сам
    // порт. А импорта достаточно: не импортировав, позвать нельзя.
    const REFRESH_PATHS = ['server/utils/ensureAccessToken.ts', 'server/utils/b24Sdk.ts']
    for (const rel of REFRESH_PATHS) {
      const text = readFileSync(join(ROOT, rel), 'utf8')
      const imports = [...text.matchAll(/^import\s+\{([^}]*)\}\s+from\s+'([^']*tokenStore)'/gm)]
      expect(imports.length, `${rel}: импорт из tokenStore не найден`).toBeGreaterThan(0)
      const named = imports.flatMap(m => m[1]!.split(',').map(x => x.trim().split(/\s+as\s+/)[0]!.trim()))
      expect(named, `${rel} импортирует создающий saveToken`).not.toContain('saveToken')
      expect(named, `${rel} не импортирует updatePortalTokenSecrets`).toContain('updatePortalTokenSecrets')
    }
  })

  it('создающий `saveToken` зовут ТОЛЬКО обработчики установки', () => {
    // Обратная сторона: если завтра его позовёт кто-то третий, решение должно приниматься здесь,
    // а не молча.
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
          const code = readFileSync(join(ROOT, rel), 'utf8').split('\n')
            .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
          // ⚠ Именно вызов из `tokenStore`, а не любое слово `saveToken`: банковский стор несёт
          // одноимённый по смыслу `saveBankToken`, а DI-порты называют своё поле `saveToken:` —
          // это другие вещи, и объявить их нарушителями значило бы обесценить гард.
          if (/\bsaveToken\s*\(\s*(dbQuery|query|infra\.query)/.test(code)) offenders.push(rel)
        }
      }
    }
    walk('server')
    expect(offenders).toEqual([])
  })
})
