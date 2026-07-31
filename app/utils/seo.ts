// Чистое SEO-ядро лендинга (#425): базовый URL, canonical, og:image, sitemap/robots.
//
// Портировано с уроками соседнего `ai-price-import` (#292/#304) — там это прошло три круга ревью,
// и почти каждое решение ниже написано кровью его продакшена. Ключевые уроки, которые здесь
// зафиксированы, чтобы их не «упростили» обратно:
//
//  1. **Базовый URL — КОНСТАНТА, а не env.** У соседа `NUXT_PUBLIC_SITE_URL` не доехал до сборки, а
//     лендинг пререндерится — пустой базовый URL впёкся в статику, `og:image` уехал относительным
//     (`/og.png`), и ссылку месяцами шарили без картинки: Facebook и LinkedIn относительные просто
//     выбрасывают. Env остаётся источником правды про АДРЕС РАЗВЁРТЫВАНИЯ, но ему нельзя решать,
//     работает ли превью вообще.
//  2. **Валидация через `new URL().origin`, а не регуляркой.** Регулярка `^https?://` пропускала три
//     разные дыры сразу: перевод строки внутри значения (`https://host\nDisallow: /` — инъекция
//     директив прямо в robots.txt), `https://host@evil.test` (canonical и og:image тихо указывают на
//     чужой домен) и базу с query (og:image резолвится в HTML-страницу вместо картинки). `.origin`
//     заодно нормализует регистр схемы и хоста и срезает path/query/fragment.
//  3. **Хвостовой слеш — одна форма на весь сайт.** Корень со слешем, остальное без. Иначе canonical
//     сам начинает плодить дубли, ради борьбы с которыми его и ставят.

import { PUBLIC_ROUTES, absoluteUrl } from '~/config/routes'

/**
 * Канонический адрес лендинга. Совпадает с `NUXT_PUBLIC_SITE_URL` из `.env.example`, но НЕ зависит
 * от него: превью ссылки и canonical обязаны работать в любой сборке, включая локальную и ту, где
 * переменную забыли передать. Меняется вместе с доменом — вручную, одним местом.
 */
export const LANDING_SITE_URL = 'https://bank-import.bx-shef.by'

/** Имя издателя для `og:site_name`. ⚠ НЕ равно заголовку страницы: у соседа так и было, и карточка
 *  шаринга печатала одну и ту же фразу дважды. Здесь это тот, кто публикует, а не что публикуют. */
export const LANDING_PUBLISHER = 'ИП Шевчик И. С.'

/**
 * Нормализовать базовый URL до origin, либо вернуть канонический, если дали мусор.
 *
 * Fail-safe именно в сторону канонического: сайт с канонической ссылкой на чужой домен хуже сайта
 * без canonical вообще, а пустая база молча ломает og:image (см. урок 1 в шапке).
 */
export function siteBaseUrl(raw?: string | null): string {
  const value = (raw ?? '').trim()
  if (!value) return LANDING_SITE_URL
  try {
    const url = new URL(value)
    // Только http(s): `javascript:`/`data:` в canonical — очевидная дыра, а `new URL` их принимает.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return LANDING_SITE_URL
    // ⚠ `.origin` — то самое место, где отсекаются `@evil.test`, query, path и переводы строк:
    // WHATWG-парсер CR/LF/TAB не отвергает, а вырезает, поэтому защищает именно возврат origin,
    // а не сам факт успешного разбора.
    return url.origin
  } catch {
    return LANDING_SITE_URL
  }
}

/** Канонический абсолютный URL страницы. */
export function canonicalUrl(route: string, raw?: string | null): string {
  // Абсолютный путь в аргументе не должен протащить чужой хост — сводим к корню.
  const safe = route.startsWith('/') && !route.startsWith('//') ? route : '/'
  return absoluteUrl(siteBaseUrl(raw), safe)
}

/** Абсолютный URL og-картинки. Всегда абсолютный — в этом весь смысл (урок 1). */
export function ogImageUrl(raw?: string | null): string {
  return `${siteBaseUrl(raw)}/og.png`
}

// ── robots.txt ───────────────────────────────────────────────────────────────────────────────────

/**
 * Пути, закрытые в robots.txt.
 *
 * ⚠ Здесь НЕТ служебных страниц (`/app`, `/import`, `/install`, `/login`, `/queues`), и это не
 * упущение. `Disallow` и `noindex` — АЛЬТЕРНАТИВЫ, а не слои: краулер, послушавший `Disallow`,
 * страницу не скачает, а значит и `noindex` не увидит — и вполне может показать голый URL в выдаче
 * (по внешним ссылкам). Служебные страницы закрыты именно мета-тегом, и добавить их сюда — значит
 * эту защиту отключить. Сосед прошёл ровно этот путь и откатывал.
 *
 * Остаётся `/api/` — там нет HTML, который мог бы нести мету, поэтому закрыть можно только так.
 */
export const DISALLOWED_PATHS = ['/api/'] as const

/** Собрать robots.txt. Никаких яндекс-специфичных директив (`Host`, `Clean-param`) — они устарели и
 *  на одном каноническом домене бессмысленны. */
export function buildRobotsTxt(raw?: string | null): string {
  const base = siteBaseUrl(raw)
  const lines = ['User-agent: *']
  for (const path of DISALLOWED_PATHS) lines.push(`Disallow: ${path}`)
  lines.push('', `Sitemap: ${base}/sitemap.xml`)
  return `${lines.join('\n')}\n`
}

// ── sitemap.xml ──────────────────────────────────────────────────────────────────────────────────

/** Экранирование XML — НА МЕСТЕ ПОДСТАНОВКИ. Один сырой `&` (обычная строка запроса) делает весь
 *  документ невалидным, и краулер отвергает карту целиком, а не пропускает одну запись. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Настоящая ли это календарная дата `YYYY-MM-DD`.
 *
 * Проверять форму регуляркой мало: `2026-13-45` ей удовлетворяет, а XSD-тип `xsd:date` такую дату
 * отвергает — и карта становится невалидной. Round-trip через `Date` ловит и несуществующие месяцы,
 * и 29 февраля не в високосный год. Год 0000 `Date` принимает, а XSD 1.0 — нет, отсюда явная проверка.
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return false
  if (d.getUTCFullYear() < 1) return false
  return d.toISOString().slice(0, 10) === value
}

/**
 * Собрать sitemap.xml из публичных маршрутов.
 *
 * `lastmod` необязателен и **опускается**, если дата не календарная: неверная дата хуже её
 * отсутствия — краулер либо отвергнет документ, либо поверит вранью. Значение должно отражать, когда
 * менялось СОДЕРЖИМОЕ (дата коммита), а не время сборки: «сегодня» на каждый передеплой
 * неизменённого коммита поисковики обесценивают.
 */
export function buildSitemapXml(raw?: string | null, lastmod?: string | null): string {
  const base = siteBaseUrl(raw)
  const stamp = lastmod && isCalendarDate(lastmod) ? lastmod : null
  const urls = PUBLIC_ROUTES.map((route) => {
    const loc = xmlEscape(absoluteUrl(base, route))
    const mod = stamp ? `\n    <lastmod>${stamp}</lastmod>` : ''
    return `  <url>\n    <loc>${loc}</loc>${mod}\n  </url>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}

/** Оба файла разом — одной точкой входа, чтобы роут/скрипт не мог собрать один из них в обход
 *  валидации базы (у соседа именно такой обход оставлял robots.txt инъектируемым при зелёных тестах). */
export function crawlerFiles(raw?: string | null, lastmod?: string | null): { robots: string, sitemap: string } {
  return { robots: buildRobotsTxt(raw), sitemap: buildSitemapXml(raw, lastmod) }
}
