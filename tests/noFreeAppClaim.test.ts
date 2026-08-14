import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Сторож против возврата утверждения «приложение бесплатное» (#436).
//
// Приложение перешло на подписку Маркета. Прежняя модель оставила фразу «бесплатно» в ВОСЬМИ
// местах — включая `<meta name="description">` страницы `/partners` и JSON-LD лендинга, где стояла
// цена `0`. Оба уезжают в выдачу поисковика, то есть переживают любую правку видимого текста.
//
// Почему сторож, а не аккуратность: фразу вычищали дважды, и оба раза что-то оставалось. Первый
// заход правил только константы и пропустил строку, зашитую в шаблон `index.vue`; второй пропустил
// заглавную букву, потому что `grep -i` не сворачивает регистр кириллицы без UTF-8 локали. Ровно
// поэтому проверка живёт в тестах, а не в чьей-то внимательности.
//
// ⚠ Ищем НЕ слово «бесплатно» вообще: оно законно у бесплатного ТАРИФА Bitrix24 (клиент на нём —
// не целевой), у бесплатных мини-инструментов в подвале и у лицензии ECharts. Ищем связку
// «бесплатн…» рядом со словом про НАШ продукт.

const ROOT = join(import.meta.dirname, '..')

/** Слова, обозначающие наш продукт. Рядом с ними «бесплатно» — заявление о цене. */
const PRODUCT = '(?:приложени\\w*|коннектор\\w*|Marketplace-верси\\w*|Маркет\\w*)'
const FREE = '[Бб]есплатн\\w*'
// В пределах ~60 символов в любом порядке — этого хватает, чтобы поймать фразу, и мало,
// чтобы цеплять соседние независимые предложения.
const NEAR = new RegExp(`(?:${FREE}[^.\\n]{0,60}${PRODUCT})|(?:${PRODUCT}[^.\\n]{0,60}${FREE})`)

/** Файлы, где такая связка законна и проверена глазами. */
const ALLOWED = new Set([
  // Правило само по себе цитирует запрещённую фразу, чтобы объяснить, чего нельзя.
  join('docs', 'MARKETPLACE_LISTING.md'),
  join('docs', 'MARKET_GRAPHICS.md'),
  join('app', 'composables', 'usePublicPageSeo.ts'),
  join('tests', 'noFreeAppClaim.test.ts'),
  // Описание КОНКУРЕНТА («Загрузка банка») и разбор того, как сменилась отстройка.
  join('docs', 'POSITIONING.md'),
  // Разбор формата — отдельная услуга, она действительно бесплатна и после перехода на подписку.
  join('docs', 'PRICING.md')
])

function textFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.nuxt', '.output', '.git', 'reporting-kit'].includes(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...textFiles(full))
    else if (/\.(ts|vue|md)$/.test(entry)) out.push(full)
  }
  return out
}

describe('приложение больше не заявляется бесплатным (#436)', () => {
  it('ни в текстах, ни в документах нет связки «бесплатно» + «приложение/коннектор/Маркет»', () => {
    const offenders: string[] = []
    for (const dir of ['app', 'docs', 'tests']) {
      for (const file of textFiles(join(ROOT, dir))) {
        const rel = file.slice(ROOT.length + 1)
        if (ALLOWED.has(rel)) continue
        const src = readFileSync(file, 'utf8')
        src.split('\n').forEach((line, i) => {
          if (NEAR.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })

  it('сам сторож ловит формулировку, ради которой заведён', () => {
    // Мутационная проверка регулярки: если она перестанет ловить это, тест выше станет
    // тавтологией и будет зелёным на сломанном тексте.
    expect(NEAR.test('Бесплатный коннектор белорусских банков для Bitrix24')).toBe(true)
    expect(NEAR.test('Само приложение — бесплатное, есть в Маркете Bitrix24.')).toBe(true)
    expect(NEAR.test('ставит бесплатное приложение из Маркета')).toBe(true)
    // И НЕ ловит законные употребления — иначе его отключат вместе с пользой.
    expect(NEAR.test('клиент на бесплатном тарифе Bitrix24 — не наш целевой')).toBe(false)
    expect(NEAR.test('ECharts (лицензия Apache-2.0, бесплатна)')).toBe(false)
  })
})
