import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ⚠ Nuxt авто-импортит ВЕСЬ `app/utils/**` в ОДНО плоское пространство имён. Значит два модуля с
// одинаковым экспортируемым именем — это не «две независимые константы», а одна: какая победит,
// зависит от порядка импортов, и никто об этом не узнает.
//
// Заведено по живой находке (#576 п.4): новый модуль объявил `ACTIVITY_DELETE_METHOD`, который уже
// был в `todoActivity.ts`. Значения совпадали, поэтому НЕ СЛОМАЛОСЬ НИЧЕГО — vitest лишь печатал
// «Duplicated imports … ignored» среди прочего вывода. Разойдись они потом хоть на символ, и
// удаление дела пошло бы не тем методом, а красным не стал бы ни один тест.
//
// ⚠ Проект уже дважды решал эту задачу переименованием вручную (три имени в `priorOauth.ts` носят
// префикс `Prior` ровно поэтому). Правило есть, памяти о нём нет — вот она.

const DIR = join(process.cwd(), 'app/utils')

/** Имена, экспортированные модулем: `export const|function|class|interface|type|enum X`. */
function exportedNames(file: string): string[] {
  const src = readFileSync(join(DIR, file), 'utf8')
  const names: string[] = []
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.push(m[1]!)
  }
  return names
}

describe('app/utils — плоское пространство имён Nuxt', () => {
  it('ни одно экспортируемое имя не объявлено дважды', () => {
    const files = readdirSync(DIR).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    expect(files.length).toBeGreaterThan(10) // иначе тест ничего не проверяет

    const owners = new Map<string, string[]>()
    for (const file of files) {
      for (const name of exportedNames(file)) {
        owners.set(name, [...(owners.get(name) ?? []), file])
      }
    }
    const clashes = [...owners.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name}: ${files.join(', ')}`)

    // ⚠ Сообщение перечисляет виновников: правило нарушают редко, но когда нарушают — надо сразу
    // видеть, какие два модуля спорят, а не идти это выяснять.
    expect(clashes, `одно имя в двух модулях app/utils:\n${clashes.join('\n')}`).toEqual([])
  })
})
