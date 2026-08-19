// Headless screenshots of the built SSG site — gives the agent "eyes" for
// visual verification (see docs/VISUAL_VERIFICATION.md). Serves .output/public
// on an ephemeral port and captures each viewport × theme to screenshots/.
//
// Usage:
//   pnpm generate && pnpm screenshot            # all routes below
//   pnpm screenshot /                           # a specific route
//
// The browser is the pre-installed Chromium in this environment
// (PLAYWRIGHT_BROWSERS_PATH); no `playwright install` is needed here.
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { resolveChromium } from './lib/chromium.mjs'
import { startStaticServer } from './lib/staticServer.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUBLIC_DIR = join(ROOT, '.output', 'public')
const OUT_DIR = join(ROOT, 'screenshots')

const ROUTES = process.argv.slice(2).length ? process.argv.slice(2) : ['/']
const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 900 }
]
const THEMES = /** @type {const} */ (['light', 'dark'])

async function ensurePublic() {
  try {
    await stat(PUBLIC_DIR)
  } catch {
    console.error('\u2716 .output/public not found \u2014 run `pnpm generate` first.')
    process.exit(1)
  }
}

async function run() {
  await ensurePublic()
  await mkdir(OUT_DIR, { recursive: true })
  const { server, port } = await startStaticServer(PUBLIC_DIR)
  const browser = await chromium.launch({ executablePath: await resolveChromium() })

  try {
    for (const route of ROUTES) {
      for (const theme of THEMES) {
        // ⚠ `reducedMotion` — не косметика: счётчики на карточке сводки анимируются от нуля
        // (count-up, rAF), и снимок ловил их НА СЕРЕДИНЕ — «Операций 24» при 26 в списке. Число
        // менялось от прогона к прогону, и это читалось как расхождение данных, хотя данные одни.
        // Визуальные регресс-тесты ставят тот же флаг; ручной прогон обязан совпадать с ними,
        // иначе глазами и тестом мы смотрим на разные экраны.
        const context = await browser.newContext({ colorScheme: theme, reducedMotion: 'reduce' })
        const page = await context.newPage()
        for (const vp of VIEWPORTS) {
          await page.setViewportSize({ width: vp.width, height: vp.height })
          await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'networkidle', timeout: 15_000 })
          const slug = route === '/' ? 'index' : route.replace(/\W+/g, '-').replace(/^-|-$/g, '')
          const file = join(OUT_DIR, `${slug}.${vp.name}.${theme}.png`)
          await page.screenshot({ path: file, fullPage: true })
          console.log(`✓ ${file.replace(ROOT, '.')}`)
        }
        await context.close()
      }
    }
  } finally {
    await browser.close()
    server.close()
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
