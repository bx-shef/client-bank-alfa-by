import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Визуальные регресс-тесты (#3): снимок ключевых экранов сравнивается с эталоном на каждом PR.
// Раньше «зрение» было только ручным (`pnpm screenshot`), то есть поехавшая вёрстка ловилась лишь
// тогда, когда кто-то догадался посмотреть на пиксели.
//
// Снимаем СОБРАННУЮ статику (`.output/public`), а не дев-сервер: проверять надо тот артефакт,
// который уедет за nginx, а не промежуточное состояние сборщика.

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PUBLIC_DIR = join(ROOT, '.output', 'public')

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain', '.webmanifest': 'application/manifest+json'
}

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 900 }
] as const

// Страницы приложения закрыты `InPortalGate` — без `?preview=1` снимется заглушка «откройте внутри
// Bitrix24», то есть эталон получился бы бесполезным МОЛЧА (ровно тот провал, ради которого
// написан docs/VISUAL_VERIFICATION.md).
const ROUTES = [
  { slug: 'index', path: '/' },
  { slug: 'partners', path: '/partners' },
  { slug: 'app', path: '/app?preview=1' },
  { slug: 'import', path: '/import?preview=1' },
  { slug: 'install', path: '/install?preview=1' },
  { slug: 'queues', path: '/queues?preview=1' },
  { slug: 'login', path: '/login' },
  { slug: 'error', path: '/404.html' }
] as const

/** Минимальный статик-сервер для собранной статики (без лишних зависимостей; тот же приём, что в
 *  `scripts/screenshot.mjs`). Отдаёт `404.html` на неизвестный путь — как nginx в проде. */
function startServer(): Promise<{ server: Server, port: number }> {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]!)
      let filePath = join(PUBLIC_DIR, normalize(urlPath))
      if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      if ((await stat(filePath).catch(() => null))?.isDirectory()) filePath = join(filePath, 'index.html')
      const body = await readFile(filePath)
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('Not found')
    }
  })
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('не удалось определить порт статик-сервера'))
        return
      }
      resolve({ server, port: addr.port })
    })
  })
}

/** Всё, что меняется само по себе, — и потому сделало бы эталон мигающим. Каждая строка здесь
 *  закрывает конкретный источник недетерминизма, а не «на всякий случай». */
const FREEZE_CSS = `
  /* Анимации и переходы: снимок иначе ловит случайный кадр. */
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  /* Каретка в полях и фокус-кольцо зависят от того, куда браузер поставил фокус при загрузке. */
  *:focus, *:focus-visible { outline-color: transparent !important; }
`

/** Что маскируем (закрашивается ровным цветом, содержимое не сравнивается) — только то, что
 *  МЕНЯЕТСЯ ОТ ПРОГОНА К ПРОГОНУ. Маскировать «сложное» вообще — способ получить зелёный тест,
 *  который ничего не проверяет, поэтому список короткий и каждый пункт объяснён. */
function masks(page: Page) {
  return [
    // Canvas-анимация hero: физика узлов не воспроизводится покадрово даже при reduced-motion
    // (там статичный кадр, но он зависит от таймингов раскладки).
    page.locator('canvas'),
    // Подвал несёт SHA сборки: локально «dev», в CI — хеш коммита, то есть отличался бы ВСЕГДА.
    page.locator('[data-testid="build-sha"]'),
    // Монитор очередей рисует шкалу времени от текущего момента.
    page.locator('[data-testid="queue-chart"]')
  ]
}

let server: Server
let port: number

test.beforeAll(async () => {
  if (!(await stat(PUBLIC_DIR).catch(() => null))) {
    throw new Error('.output/public не найден — сначала `pnpm generate`')
  }
  const started = await startServer()
  server = started.server
  port = started.port
})

test.afterAll(() => server?.close())

for (const route of ROUTES) {
  for (const theme of ['light', 'dark'] as const) {
    for (const vp of VIEWPORTS) {
      test(`${route.slug} · ${theme} · ${vp.name}`, async ({ browser }) => {
        const context = await browser.newContext({
          colorScheme: theme,
          viewport: { width: vp.width, height: vp.height },
          reducedMotion: 'reduce'
        })
        const page = await context.newPage()
        await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {})
        await page.goto(`http://127.0.0.1:${port}${route.path}`, { waitUntil: 'networkidle', timeout: 30_000 })
        // Стиль добавляем ПОСЛЕ навигации тоже: `addStyleTag` до `goto` теряется вместе с
        // документом, а нам нужно заглушить анимации именно на отрисованной странице.
        await page.addStyleTag({ content: FREEZE_CSS })
        // Шрифты — самая частая причина «дрожащего» снимка: без ожидания первый кадр приходит с
        // системным фолбэком, и эталон фиксирует не тот текст, что увидит пользователь.
        await page.evaluate(() => document.fonts.ready)
        await expect(page).toHaveScreenshot(`${route.slug}.${theme}.${vp.name}.png`, {
          fullPage: true,
          mask: masks(page),
          animations: 'disabled'
        })
        await context.close()
      })
    }
  }
}
