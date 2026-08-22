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
 * Использование: node scripts/seo-files.mjs [outDir] [lastmod]
 *   outDir   куда писать                (по умолчанию: .output/public)
 *   lastmod  дата изменения YYYY-MM-DD  (по умолчанию: $NUXT_PUBLIC_BUILD_DATE, иначе без lastmod)
 *
 * ⚠ Базовый URL НЕ берётся из `NUXT_PUBLIC_SITE_URL` — он всегда канонический (`LANDING_SITE_URL`).
 * Иначе сборка со своим адресом (staging, Vibecode-таргет) выпустила бы карту сайта и `Sitemap:` со
 * СВОИМИ URL, тогда как canonical и og:url в HTML остаются прод-овыми: поисковик получил бы карту с
 * чужими адресами и спорящие сигналы. Сосед чинил ровно это отдельным заходом (#304). Env отвечает
 * за адрес РАЗВЁРТЫВАНИЯ, но не за то, что считать каноническим.
 *
 * ⚠ Логика сборки самих файлов живёт в `app/utils/seo.ts` и покрыта юнит-тестами. Здесь — только
 * ввод-вывод: скрипт не должен уметь собрать robots.txt в обход валидации базового URL. Отсюда и
 * `crawlerFiles` вместо двух отдельных билдеров — обойти валидацию нечем.
 *
 * TS-модуль грузится нативным strip-types Node; `~/`-алиас и безрасширенные импорты чинит
 * `scripts/lib/alias-loader.mjs` — тот же приём, что у остальных дев-скриптов проекта.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const { crawlerFiles, injectNoindex } = await import(pathToFileURL(join(here, '..', 'app', 'utils', 'seo.ts')).href)
const { buildLlmsTxt } = await import(pathToFileURL(join(here, '..', 'app', 'utils', 'faq.ts')).href)
const { LANDING_SITE_URL } = await import(pathToFileURL(join(here, '..', 'app', 'utils', 'seo.ts')).href)
const { SERVICE_ROUTES } = await import(pathToFileURL(join(here, '..', 'app', 'config', 'routes.ts')).href)

const [outDirArg, lastmodArg] = process.argv.slice(2)
const outDir = outDirArg || '.output/public'
const lastmod = lastmodArg || process.env.NUXT_PUBLIC_BUILD_DATE || ''

// Без базового URL: `crawlerFiles` возьмёт канонический (см. предупреждение в шапке).
const { robots, sitemap } = crawlerFiles(null, lastmod)

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'robots.txt'), robots, 'utf8')
writeFileSync(join(outDir, 'sitemap.xml'), sitemap, 'utf8')

// `llms.txt` — та же справка, что и на `/help`, но простым текстом для ИИ-агента клиента (#576).
// ⚠ Домен берётся тот же канонический, что и у карты сайта, и по той же причине: адрес
// РАЗВЁРТЫВАНИЯ здесь ни при чём, а агент, получивший ссылку на staging, отправит туда человека.
writeFileSync(join(outDir, 'llms.txt'), buildLlmsTxt(LANDING_SITE_URL), 'utf8')

// Список служебных маршрутов — для гардов сборки (Dockerfile). Хардкодить его там значило бы
// завести ТРЕТЬЮ копию знания рядом с `routes.ts` и тестом: добавили страницу — тест зелёный,
// а артефакт-гард её молча не проверяет. Файл технический, в образ не попадает.
writeFileSync(join(outDir, '..', 'service-routes.txt'), `${SERVICE_ROUTES.join('\n')}\n`, 'utf8')

// `404.html` — SPA-оболочка от `nuxt generate`: браузер дорисует `app/error.vue` при гидрации, но
// краулер видит голый документ без мета-тегов. `noindex` вписываем в артефакт (см. `injectNoindex`).
const notFound = join(outDir, '404.html')
if (existsSync(notFound)) {
  writeFileSync(notFound, injectNoindex(readFileSync(notFound, 'utf8')), 'utf8')
}

console.info('[seo] robots.txt + sitemap.xml + llms.txt written to %s%s', outDir, lastmod ? ` (lastmod ${lastmod})` : ' (без lastmod)')
