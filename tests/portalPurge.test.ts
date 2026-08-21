import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Удаление приложения обязано стирать для портала ВСЁ (#77) — а список того, что стирать, живёт
 * в одном месте живой проводки (`deletePortal` в `server/queue/worker.ts`) и ничем не проверялся.
 *
 * ⚠ Гард заведён по конкретному промаху (#538): новая таблица `single_flight_lease` про портал
 * знает (её ключ содержит `member_id`), а из `deletePortal` выпала. Поймал это не набор тестов, а
 * человек на ревью — и это ровно тот класс дефекта, который набором не ловится: чистый модуль
 * покрыт, а ВЫЗОВ его из проводки — нет.
 *
 * ⚠ Инвариант структурный и самопополняющийся: любая экспортированная функция вида
 * `delete<Что>ForPortal` обязана быть вызвана. Список закрывать руками не нужно — следующая
 * таблица попадает под правило сама, в тот момент, когда для неё пишут функцию удаления.
 */
const UTILS = join(process.cwd(), 'server/utils')

/** Исходник без комментариев — судим о КОДЕ, а не о прозе рядом с ним. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('удаление приложения стирает всё для портала (#77/#538)', () => {
  it('каждая функция delete*ForPortal вызывается из deletePortal', () => {
    const purges = new Set<string>()
    for (const file of readdirSync(UTILS)) {
      if (!file.endsWith('.ts')) continue
      const code = codeOnly(readFileSync(join(UTILS, file), 'utf8'))
      for (const m of code.matchAll(/export async function (delete\w+ForPortal)\b/g)) purges.add(m[1]!)
    }
    // Пустой набор означал бы, что гард ничего не проверяет — а выглядел бы зелёным.
    expect(purges.size, 'ни одной функции delete*ForPortal не найдено — гард ослеп').toBeGreaterThan(3)

    const worker = codeOnly(readFileSync(join(process.cwd(), 'server/queue/worker.ts'), 'utf8'))
    const start = worker.indexOf('deletePortal: async (')
    expect(start, 'deletePortal не найден в живой проводке').toBeGreaterThan(-1)
    const body = worker.slice(start, worker.indexOf('\n    },', start))

    const missing = [...purges].filter(name => !body.includes(`${name}(dbQuery, memberId`)).sort()
    expect(missing, 'эти данные портала переживут удаление приложения').toEqual([])
  })
})
