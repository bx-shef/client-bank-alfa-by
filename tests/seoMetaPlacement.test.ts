import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PUBLIC_ROUTES, PRERENDER_ROUTES, SERVICE_ROUTES } from '~/config/routes'

// Где живёт SEO-мета и кто закрыт от индексации (#425).
//
// ⚠ Инвариант заявлен над РЕАЛЬНЫМИ ФАЙЛАМИ `app/pages/**`, а не над списком в конфиге. Список
// можно поправить и забыть про страницу; файл забыть нельзя — он либо есть, либо нет. Именно так
// у нас и протекло: `/app`, `/import`, `/install` пререндерились и индексировались с мета-данными
// лендинга, потому что классификация жила только в голове.

const root = fileURLToPath(new URL('..', import.meta.url))
const pagesDir = `${root}app/pages`

/**
 * Файлы страниц → маршруты. Обход РЕКУРСИВНЫЙ, хотя структура сейчас плоская: у соседа
 * нерекурсивный вариант ровно так и промахнулся — вложенная страница просто не попадала в
 * сопоставление, и «третьего не дано» проходило молча на неклассифицированной странице.
 */
function pageRoutes(dir = pagesDir, prefix = ''): { route: string, file: string }[] {
  const out: { route: string, file: string }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...pageRoutes(`${dir}/${entry.name}`, `${prefix}/${entry.name}`))
      continue
    }
    if (!entry.name.endsWith('.vue')) continue
    const base = entry.name.replace(/\.vue$/, '')
    const route = base === 'index' ? (prefix || '/') : `${prefix}/${base}`
    out.push({ route, file: `${dir}/${entry.name}` })
  }
  return out
}

/**
 * Код без комментариев — чтобы упоминание в пояснении не сходило за реализацию.
 *
 * ⚠ Порядок снятия важен и выяснен на живом промахе: СНАЧАЛА строчные, ПОТОМ блочные. В `install.vue`
 * строчный комментарий содержит путь со звёздочкой — и блочный стриппер, запущенный первым, принимал
 * `/`+`*` за начало блока и съедал всё до следующего закрывающего, включая настоящую мету `robots`. Тест
 * «страница не закрыта» падал на странице, которая закрыта.
 */
function codeOnly(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

const pages = pageRoutes()

describe('классификация маршрутов', () => {
  it('каждая страница объявлена ЛИБО публичной, ЛИБО служебной — третьего не дано', () => {
    const known = new Set<string>([...PUBLIC_ROUTES, ...SERVICE_ROUTES])
    const unclassified = pages.filter(p => !known.has(p.route)).map(p => p.route)
    expect(unclassified, 'добавили страницу — впишите её в app/config/routes.ts').toEqual([])
  })

  it('в списках нет маршрутов без страниц (иначе sitemap/пререндер сошлются на 404)', () => {
    const real = new Set(pages.map(p => p.route))
    const ghosts = [...PUBLIC_ROUTES, ...SERVICE_ROUTES].filter(r => !real.has(r))
    expect(ghosts, 'страницы удалили — уберите маршрут из app/config/routes.ts').toEqual([])
  })

  it('пререндер покрывает все маршруты, кроме корня (его берёт краулер)', () => {
    const expected = [...SERVICE_ROUTES, ...PUBLIC_ROUTES.filter(r => r !== '/')].sort()
    expect([...PRERENDER_ROUTES].sort()).toEqual(expected)
  })
})

describe('служебные страницы закрыты от индексации', () => {
  it.each(SERVICE_ROUTES)('%s несёт robots: noindex', (route) => {
    const page = pages.find(p => p.route === route)!
    const code = codeOnly(readFileSync(page.file, 'utf8'))
    // `name=`, а не `property=`: краулеры читают именно `name`. `robots: 'none'` тоже засчитываем.
    expect(code, `${route}: нет мета robots со значением noindex/none`).toMatch(
      /name:\s*'robots'[\s\S]{0,80}content:\s*'[^']*(noindex|none)/
    )
  })

  it('служебные страницы НЕ несут соц-меты — это были бы дубли лендинга в выдаче', () => {
    for (const route of SERVICE_ROUTES) {
      const code = codeOnly(readFileSync(pages.find(p => p.route === route)!.file, 'utf8'))
      expect(code, route).not.toContain('useSeoMeta')
      expect(code, route).not.toContain('usePublicPageSeo')
      expect(code, route).not.toMatch(/og:(title|description|image)/)
    }
  })
})

describe('публичные страницы несут полный набор', () => {
  it.each(PUBLIC_ROUTES)('%s вызывает usePublicPageSeo со своим маршрутом', (route) => {
    const code = codeOnly(readFileSync(pages.find(p => p.route === route)!.file, 'utf8'))
    expect(code).toContain('usePublicPageSeo(')
    expect(code, `${route}: маршрут в usePublicPageSeo должен совпадать с реальным`).toMatch(
      new RegExp(`route:\\s*'${route.replace('/', '\\/')}'`)
    )
  })

  it('публичные страницы НЕ закрыты noindex (иначе лендинг просто исчезнет из выдачи)', () => {
    for (const route of PUBLIC_ROUTES) {
      const code = codeOnly(readFileSync(pages.find(p => p.route === route)!.file, 'utf8'))
      expect(code, route).not.toMatch(/content:\s*'[^']*noindex/)
    }
  })
})

describe('РЕГРЕСС #425: SEO-мета не возвращается в общие обёртки', () => {
  // Первопричина утечки: `useSeoMeta` в корневом `app.vue` применялся ко ВСЕМ страницам. Матчим по
  // форме кода, а не по имени функции — иначе мимо проскочат `useHead({meta:[{property:'og:image'}]})`
  // и `useServerSeoMeta`.
  const shared = [
    'app/app.vue',
    ...readdirSync(`${root}app/layouts`).filter(f => f.endsWith('.vue')).map(f => `app/layouts/${f}`)
  ]

  it.each(shared)('%s не задаёт SEO-мету', (rel) => {
    const code = codeOnly(readFileSync(`${root}${rel}`, 'utf8'))
    expect(code, `${rel}: useSeoMeta/useServerSeoMeta`).not.toMatch(/use(Server)?SeoMeta/)
    expect(code, `${rel}: og:-мета`).not.toMatch(/og:(title|description|image|url|site_name|locale)/)
    expect(code, `${rel}: description-мета`).not.toMatch(/name:\s*'description'/)
    expect(code, `${rel}: canonical`).not.toMatch(/rel:\s*'canonical'/)
  })

  it('nuxt.config.ts не задаёт SEO-мету в app.head', () => {
    const code = codeOnly(readFileSync(`${root}nuxt.config.ts`, 'utf8'))
    expect(code).not.toMatch(/use(Server)?SeoMeta/)
    expect(code).not.toMatch(/og:(title|description|image)/)
  })
})

describe('генератор краулерных файлов', () => {
  it('ходит через crawlerFiles, а не собирает файлы двумя билдерами в обход валидации базы', () => {
    // Иначе `robots.txt` снова станет инъектируемым, а все остальные тесты останутся зелёными:
    // они проверяют ядро, а не то, что скрипт им пользуется.
    const src = readFileSync(`${root}scripts/seo-files.mjs`, 'utf8')
    expect(src).toContain('crawlerFiles')
    expect(src).not.toContain('buildRobotsTxt')
    expect(src).not.toContain('buildSitemapXml')
  })

  it('НЕ берёт базовый URL из окружения — иначе staging-сборка позовёт в индекс себя', () => {
    const src = codeOnly(readFileSync(`${root}scripts/seo-files.mjs`, 'utf8'))
    expect(src).not.toContain('NUXT_PUBLIC_SITE_URL')
  })

  it('подключён к `pnpm generate` — сгенерированная статика без robots/sitemap бесполезна', () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.generate).toContain('seo:files')
    expect(pkg.scripts['seo:files']).toContain('scripts/seo-files.mjs')
  })
})

describe('публичные файлы вне app/pages', () => {
  it('public/b24-form.html закрыт noindex — гарды его не видят, тег стоит руками', () => {
    const html = readFileSync(`${root}public/b24-form.html`, 'utf8')
    expect(html).toMatch(/<meta\s+name="robots"\s+content="[^"]*noindex/)
  })
})
