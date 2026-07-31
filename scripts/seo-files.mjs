#!/usr/bin/env node
/*
 * Пишет `robots.txt` и `sitemap.xml` в собранную статику (#425).
 *
 * Почему генерируем, а не кладём в `public/`: карта сайта обязана перечислять РОВНО публичные
 * маршруты, а они объявлены в `app/config/routes.ts` — том же месте, откуда берётся список
 * пререндера. Статический файл был бы третьей копией этого знания и разъехался бы молча: sitemap с
 * несуществующим URL поисковик считает признаком заброшенного сайта, а забытая страница просто не
 * индексируется. Так же (генерацией на этапе сборки) в проекте уже решён CSP-хеш — см.
 * `scripts/csp-hashes.mjs`.
 *
 * Запускается из `pnpm generate` — то есть и локально, и в Docker (`RUN pnpm generate`).
 *
 * Использование: node scripts/seo-files.mjs [outDir] [siteUrl] [lastmod]
 *   outDir   куда писать                (по умолчанию: .output/public)
 *   siteUrl  базовый URL                (по умолчанию: $NUXT_PUBLIC_SITE_URL, иначе канонический)
 *   lastmod  дата изменения YYYY-MM-DD  (по умолчанию: $NUXT_PUBLIC_BUILD_DATE, иначе без lastmod)
 *
 * ⚠ Логика сборки самих файлов живёт в `app/utils/seo.ts` и покрыта юнит-тестами. Здесь — только
 * ввод-вывод: скрипт не должен уметь собрать robots.txt в обход валидации базового URL. Отсюда и
 * `crawlerFiles` вместо двух отдельных билдеров — обойти валидацию нечем.
 *
 * TS-модуль грузится нативным strip-types Node; `~/`-алиас и безрасширенные импорты чинит
 * `scripts/lib/alias-loader.mjs` — тот же приём, что у остальных дев-скриптов проекта.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const { crawlerFiles } = await import(pathToFileURL(join(here, '..', 'app', 'utils', 'seo.ts')).href)

const [outDirArg, siteUrlArg, lastmodArg] = process.argv.slice(2)
const outDir = outDirArg || '.output/public'
const siteUrl = siteUrlArg || process.env.NUXT_PUBLIC_SITE_URL || ''
const lastmod = lastmodArg || process.env.NUXT_PUBLIC_BUILD_DATE || ''

const { robots, sitemap } = crawlerFiles(siteUrl, lastmod)

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'robots.txt'), robots, 'utf8')
writeFileSync(join(outDir, 'sitemap.xml'), sitemap, 'utf8')

console.info('[seo] robots.txt + sitemap.xml written to %s%s', outDir, lastmod ? ` (lastmod ${lastmod})` : ' (без lastmod)')
