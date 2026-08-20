import { describe, expect, it } from 'vitest'
import {
  DISALLOWED_PATHS, LANDING_PUBLISHER, LANDING_SITE_URL,
  buildRobotsTxt, buildSitemapXml, canonicalUrl, crawlerFiles,
  injectNoindex, isCalendarDate, ldJson, NOINDEX_META, ogImageUrl, siteBaseUrl, xmlEscape
} from '~/utils/seo'
import { PUBLIC_ROUTES, SERVICE_ROUTES, absoluteUrl } from '~/config/routes'
import { LANDING_META_DESCRIPTION, LANDING_TITLE } from '~/utils/landing'
import { PARTNERS_META_DESCRIPTION } from '~/utils/partners'

// SEO-ядро (#425). Уроки взяты из соседнего `ai-price-import` (#292/#304) — там почти каждый из
// этих кейсов сначала уехал в прод, и только потом стал тестом.

describe('siteBaseUrl', () => {
  it('нормализует до origin и срезает путь/хвостовой слеш', () => {
    expect(siteBaseUrl(`${LANDING_SITE_URL}/`)).toBe(LANDING_SITE_URL)
    expect(siteBaseUrl(`${LANDING_SITE_URL}/some/path?x=1#frag`)).toBe(LANDING_SITE_URL)
  })

  it('пустое значение → канонический адрес, а НЕ пустая строка', () => {
    // Пустая база молча ломает og:image (относительный URL скрейперы выбрасывают) — ссылку
    // шарили бы без картинки и никто бы не заметил.
    expect(siteBaseUrl('')).toBe(LANDING_SITE_URL)
    expect(siteBaseUrl(undefined)).toBe(LANDING_SITE_URL)
    expect(siteBaseUrl(null)).toBe(LANDING_SITE_URL)
    expect(siteBaseUrl('   ')).toBe(LANDING_SITE_URL)
  })

  it('ИНЪЕКЦИЯ: перевод строки в базе не протаскивает директивы в robots.txt', () => {
    // Регулярка `^https?://` такое пропускала: `Disallow: /` уезжал в файл отдельной строкой и
    // закрывал сайт целиком. Здесь значение до robots.txt не доходит вовсе — `new URL` его
    // отвергает (после вырезания перевода строки хост становится невалидным), и мы откатываемся
    // к каноническому. Проверяем не конкретный откат, а ИНВАРИАНТ: в файле нет чужих строк.
    const evil = `${LANDING_SITE_URL}\nDisallow: /`
    expect(siteBaseUrl(evil)).toBe(LANDING_SITE_URL)
    const lines = buildRobotsTxt(evil).split('\n')
    expect(lines.every(l => l === '' || /^(User-agent|Disallow|Sitemap):/.test(l))).toBe(true)
    expect(lines.filter(l => l.startsWith('Disallow:'))).toEqual(['Disallow: /api/'])
  })

  it('ПОДМЕНА ХОСТА: `@` в userinfo НЕ уводит canonical на чужой домен', () => {
    // Разбора до `.origin` мало: у такого URL origin ЧЕСТНО равен evil.test, и значение прошло бы
    // насквозь. Поэтому белый список из одного домена — не «нормализация», а сравнение.
    expect(siteBaseUrl('https://bank-import.bx-shef.by@evil.test')).toBe(LANDING_SITE_URL)
  })

  it('любой ЧУЖОЙ домен откатывается к каноническому (staging не объявляет себя главным)', () => {
    // Урок соседа #304: staging, собранный со своим NUXT_PUBLIC_SITE_URL, уводил выдачу с прода.
    expect(siteBaseUrl('https://staging.example.by')).toBe(LANDING_SITE_URL)
    expect(siteBaseUrl('http://localhost:3000')).toBe(LANDING_SITE_URL)
  })

  it('канонический домен принимается в любой записи (регистр, путь, порт по умолчанию)', () => {
    expect(siteBaseUrl('HTTPS://BANK-IMPORT.BX-SHEF.BY/x?y=1#z')).toBe(LANDING_SITE_URL)
  })

  it('не-http схемы отвергаются (javascript:/data: в canonical — очевидная дыра)', () => {
    expect(siteBaseUrl('javascript:alert(1)')).toBe(LANDING_SITE_URL)
    expect(siteBaseUrl('data:text/html,x')).toBe(LANDING_SITE_URL)
    expect(siteBaseUrl('//evil.test')).toBe(LANDING_SITE_URL) // не абсолютный URL → мусор
  })

  it('мусор не роняет сборку, а откатывается к каноническому', () => {
    expect(siteBaseUrl('не url')).toBe(LANDING_SITE_URL)
  })
})

describe('canonicalUrl / ogImageUrl', () => {
  it('корень со слешем, остальное без — одна форма на весь сайт', () => {
    expect(canonicalUrl('/', LANDING_SITE_URL)).toBe(`${LANDING_SITE_URL}/`)
    expect(canonicalUrl('/partners', LANDING_SITE_URL)).toBe(`${LANDING_SITE_URL}/partners`)
  })

  it('абсолютный путь в аргументе не протаскивает чужой хост', () => {
    expect(canonicalUrl('//evil.test/x', LANDING_SITE_URL)).toBe(`${LANDING_SITE_URL}/`)
    expect(canonicalUrl('https://evil.test', LANDING_SITE_URL)).toBe(`${LANDING_SITE_URL}/`)
  })

  it('og:image ВСЕГДА абсолютный — в этом весь смысл', () => {
    // Дефект-первоисточник: относительный `/og.png` в проде ⇒ превью ссылки пустое.
    for (const base of ['', undefined, null, 'мусор', 'https://example.by/']) {
      expect(ogImageUrl(base as string | undefined)).toBe(`${LANDING_SITE_URL}/og.png`)
    }
  })
})

describe('buildRobotsTxt', () => {
  it('закрывает /api/ и указывает абсолютный sitemap', () => {
    const txt = buildRobotsTxt(LANDING_SITE_URL)
    expect(txt).toContain('Disallow: /api/')
    expect(txt).toContain(`Sitemap: ${LANDING_SITE_URL}/sitemap.xml`)
  })

  it('НЕ закрывает служебные страницы — они держатся на noindex, и Disallow его отключил бы', () => {
    // Пин решения, а не описание кода: «давайте на всякий случай закроем и их» ломает noindex,
    // потому что краулер не скачает страницу и не увидит мету. Сосед проходил это и откатывал.
    for (const route of SERVICE_ROUTES) {
      expect(buildRobotsTxt(LANDING_SITE_URL), route).not.toContain(`Disallow: ${route}`)
    }
    expect(DISALLOWED_PATHS).toEqual(['/api/'])
  })

  it('никаких директив кроме User-agent/Disallow/Sitemap', () => {
    const lines = buildRobotsTxt(LANDING_SITE_URL).split('\n').filter(Boolean)
    expect(lines.every(l => /^(User-agent|Disallow|Sitemap):/.test(l))).toBe(true)
  })
})

describe('isCalendarDate', () => {
  it('принимает настоящие даты', () => {
    expect(isCalendarDate('2026-07-31')).toBe(true)
    expect(isCalendarDate('2024-02-29')).toBe(true) // високосный
  })

  it.each(['2026-13-45', '2025-02-29', '2026-7-1', '2026-07-31T10:00:00Z', '0000-01-01', '', 'вчера'])(
    'отвергает невозможную/нестандартную дату %s (иначе карта невалидна по XSD)', (v) => {
      expect(isCalendarDate(v)).toBe(false)
    })
})

describe('buildSitemapXml', () => {
  it('перечисляет РОВНО публичные маршруты', () => {
    const xml = buildSitemapXml(LANDING_SITE_URL)
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])
    expect(locs).toEqual(PUBLIC_ROUTES.map(r => absoluteUrl(LANDING_SITE_URL, r)))
  })

  it('служебных страниц в карте нет (иначе сами приглашаем их индексировать)', () => {
    const xml = buildSitemapXml(LANDING_SITE_URL)
    for (const route of SERVICE_ROUTES) expect(xml, route).not.toContain(`${route}<`)
  })

  it('lastmod ставится только для настоящей даты; кривая — ОПУСКАЕТСЯ, а не пишется как есть', () => {
    expect(buildSitemapXml(LANDING_SITE_URL, '2026-07-31')).toContain('<lastmod>2026-07-31</lastmod>')
    expect(buildSitemapXml(LANDING_SITE_URL, '2026-13-45')).not.toContain('<lastmod>')
    expect(buildSitemapXml(LANDING_SITE_URL, '')).not.toContain('<lastmod>')
  })

  it('XML экранируется НА МЕСТЕ ПОДСТАНОВКИ — один сырой & делает документ невалидным целиком', () => {
    expect(xmlEscape('a&b<c>"d\'e')).toBe('a&amp;b&lt;c&gt;&quot;d&apos;e')
    // База с query до `<loc>` не доходит (origin её срезает) — фиксируем оба рубежа.
    expect(buildSitemapXml(`${LANDING_SITE_URL}/?a=1&b=2`)).not.toContain('&b=')
  })

  it('документ well-formed: есть XML-декларация, urlset и закрывающий тег', () => {
    const xml = buildSitemapXml(LANDING_SITE_URL)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true)
    // ≥1 <url> — пустой urlset невалиден по XSD.
    expect((xml.match(/<url>/g) ?? []).length).toBeGreaterThan(0)
  })
})

describe('crawlerFiles', () => {
  it.each([`${LANDING_SITE_URL}\nDisallow: /`, `${LANDING_SITE_URL}/?a=1&b=2`, 'javascript:alert(1)', '', '//evil.test'])(
    'враждебная база %s не ломает НИ ОДИН из двух файлов', (base) => {
      const { robots, sitemap } = crawlerFiles(base, '2026-07-31')
      // robots: ни одной посторонней директивы, и «закрыт» ровно /api/.
      const lines = robots.split('\n')
      expect(lines.every(l => l === '' || /^(User-agent|Disallow|Sitemap):/.test(l))).toBe(true)
      expect(lines.filter(l => l.startsWith('Disallow:'))).toEqual(['Disallow: /api/'])
      // sitemap: каждый <loc> — валидный http(s)-URL без сырых спецсимволов XML.
      const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]!)
      expect(locs.length).toBe(PUBLIC_ROUTES.length)
      for (const loc of locs) {
        expect(loc, base).toMatch(/^https?:\/\/[^\s"'<>]+$/)
        expect(loc).not.toContain('&') // сырой & сделал бы весь документ невалидным
      }
    })
})

describe('тексты для выдачи', () => {
  it.each([
    ['главная', LANDING_META_DESCRIPTION],
    ['партнёры', PARTNERS_META_DESCRIPTION]
  ])('meta-description (%s) укладывается в практический предел выдачи', (_page, text) => {
    // Развёрнутые тексты под hero (265 и 180 символов) обрезались бы на полуслове. Проверяем ОБЕ
    // публичные страницы: главную сократили сразу, а `/partners` осталась с длинным — ровно тот же
    // дефект уехал бы в выдачу.
    expect(text.length).toBeLessThanOrEqual(160)
    expect(text.length).toBeGreaterThan(50)
  })

  it('og:site_name — имя издателя, а не заголовок (иначе карточка печатает фразу дважды)', () => {
    expect(LANDING_PUBLISHER).not.toBe(LANDING_TITLE)
    expect(LANDING_PUBLISHER.length).toBeGreaterThan(0)
  })

  it('канонический адрес — https и без хвостового слеша', () => {
    expect(LANDING_SITE_URL).toMatch(/^https:\/\/[^/]+$/)
  })
})

describe('ldJson', () => {
  it('экранирует `<`, чтобы содержимое не могло закрыть тег <script>', () => {
    // `JSON.stringify` не трогает ни `<`, ни `/`. Строка `</script>` в любом поле разорвала бы тег,
    // и всё дальше браузер разобрал бы как разметку. Второй рубеж поверх экранирования unhead.
    const out = ldJson({ name: 'x</script><img src=x onerror=alert(1)>' })
    expect(out).not.toContain('</script')
    expect(out).toContain('\\u003c')
    expect(JSON.parse(out).name).toBe('x</script><img src=x onerror=alert(1)>') // JSON не испорчен
  })
})

describe('injectNoindex — `404.html` от `nuxt generate`', () => {
  // Оболочка SPA приходит без единого мета-тега: `useHead` из `app/error.vue` отрабатывает только
  // после гидрации, а краулер HTML не исполняет. Тег обязан быть в самом артефакте.
  it('вписывает тег сразу после <head>', () => {
    const out = injectNoindex('<html><head><title>x</title></head><body></body></html>')
    expect(out).toContain(`<head>${NOINDEX_META}<title>`)
  })

  it('идемпотентен — уже закрытый документ не трогает', () => {
    const html = `<html><head>${NOINDEX_META}</head></html>`
    expect(injectNoindex(html)).toBe(html)
  })

  it('не дублирует тег при ЛЮБОЙ уже существующей мете robots (в т.ч. `none`)', () => {
    const html = '<html><head><meta name="robots" content="none"></head></html>'
    expect(injectNoindex(html)).toBe(html)
  })

  it('без <head> возвращает документ как есть, а не рвёт разметку', () => {
    expect(injectNoindex('<p>нет головы</p>')).toBe('<p>нет головы</p>')
  })

  it('переживает <head> с атрибутами', () => {
    expect(injectNoindex('<head lang="ru"><title>x</title></head>')).toContain(
      `<head lang="ru">${NOINDEX_META}`
    )
  })
})
