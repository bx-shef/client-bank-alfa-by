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

describe('codeOnly — вспомогательный стриппер этого теста', () => {
  // Он уже один раз соврал (съел настоящую мету на `install.vue`), поэтому у него есть свои тесты:
  // ложное падение тут дороже, чем кажется — оно учит игнорировать красный SEO-тест.
  it('снимает строчный комментарий, даже если внутри него есть `/*`', () => {
    expect(codeOnly("// путь `/api/*`\nconst a = 1\n")).toContain('const a = 1')
  })

  it('снимает блочный комментарий и HTML-комментарий', () => {
    expect(codeOnly('/* og:title */const a = 1')).toBe('const a = 1')
    expect(codeOnly('<!-- og:title -->\n<div/>')).toContain('<div/>')
  })

  it('не съедает код, идущий ПОСЛЕ комментариев', () => {
    expect(codeOnly("// c\n/* c */\nname: 'robots'")).toContain("name: 'robots'")
  })
})

describe('страница ошибки', () => {
  // `app/error.vue` не лежит в `app/pages`, поэтому инвариант «публичная либо служебная» её не
  // видит: мету туда можно занести, а `noindex` — вынести, и всё останется зелёным.
  const code = codeOnly(readFileSync(`${root}app/error.vue`, 'utf8'))

  it('несёт robots: noindex', () => {
    expect(code).toMatch(/name:\s*'robots'[\s\S]{0,80}content:\s*'[^']*(noindex|none)/)
  })

  it('не задаёт соц-мету — это была бы копия лендинга на каждой опечатке в адресе', () => {
    expect(code).not.toMatch(/use(Server)?SeoMeta|usePublicPageSeo/)
    expect(code).not.toMatch(/og:(title|description|image)/)
  })

  it('noindex вписывается и в САМ артефакт `404.html`', () => {
    // `nuxt generate` кладёт туда SPA-оболочку: `useHead` из `error.vue` отработает только после
    // гидрации, а краулер HTML не исполняет. Поэтому тег ставит генератор — см. `injectNoindex`.
    const src = readFileSync(`${root}scripts/seo-files.mjs`, 'utf8')
    expect(src).toContain('injectNoindex')
    expect(src).toContain('404.html')
  })
})

describe('nginx: контракт SEO-поведения', () => {
  const conf = readFileSync(`${root}nginx.conf`, 'utf8')

  it('несуществующий адрес отдаёт 404, а не лендинг с кодом 200 (soft-404)', () => {
    expect(conf).not.toMatch(/try_files[^;]*\/index\.html/)
    expect(conf).toMatch(/try_files\s+\$uri\s+\$uri\/\s+=404/)
  })

  it('403 обрабатывается вместе с 404 — каталоги без index.html иначе отдают голый 403', () => {
    expect(conf).toMatch(/error_page\s+403\s+404\s+\/404\.html/)
  })

  it('`200.html` закрыт `internal` — снаружи это дубль лендинга с кодом 200', () => {
    expect(conf).toMatch(/location\s*=\s*\/200\.html\s*\{[^}]*internal/)
  })
})

describe('nuxt.config: списком маршрутов реально пользуются', () => {
  it('пререндер берёт PRERENDER_ROUTES, а не свой хардкод', () => {
    // Иначе тест состава списка зелёный, а страница просто не попала в статику.
    const code = codeOnly(readFileSync(`${root}nuxt.config.ts`, 'utf8'))
    expect(code).toMatch(/routes:\s*(\[\s*\.\.\.)?PRERENDER_ROUTES/)
  })
})

describe('публичные файлы вне app/pages', () => {
  it('public/b24-form.html закрыт noindex — гарды его не видят, тег стоит руками', () => {
    const html = readFileSync(`${root}public/b24-form.html`, 'utf8')
    expect(html).toMatch(/<meta\s+name="robots"\s+content="[^"]*noindex/)
  })
})
