// Generate the Open Graph share image (public/og.png, 1200×630) from an inline
// HTML template using the pre-installed Chromium (same resolver as screenshot.mjs).
// Run when the landing title/branding changes:  pnpm og
//
// The PNG is a committed static asset (served by nginx, referenced by og:image in
// app.vue). Regenerate + commit when you edit the template below. Issue #4.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { resolveChromium } from './lib/chromium.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'public', 'og.png')
const WIDTH = 1200
const HEIGHT = 630

// NB: the card text below is intentionally standalone — it is NOT derived from
// app/utils/landing.ts (the explicit line break and shorter subtitle are tuned
// for the 1200×630 card). Re-sync by hand when the landing title/branding changes.
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; }
  .card {
    width: ${WIDTH}px; height: ${HEIGHT}px; padding: 84px 88px;
    background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%);
    color: #fff; display: flex; flex-direction: column; justify-content: center;
    font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  .eyebrow { font-size: 32px; font-weight: 600; letter-spacing: 3px;
    text-transform: uppercase; color: #93c5fd; }
  .title { font-size: 80px; font-weight: 800; line-height: 1.04; margin-top: 26px; }
  .banks { font-size: 40px; color: #e2e8f0; margin-top: 40px; }
  .foot { font-size: 30px; color: #94a3b8; margin-top: auto; }
</style></head><body>
  <div class="card">
    <div class="eyebrow">Bitrix24</div>
    <div class="title">Импорт выписки<br>из клиент-банка</div>
    <div class="banks">Альфа-Банк Беларусь · любая стандартная выписка</div>
    <div class="foot">Платежи в CRM · уведомления в чат</div>
  </div>
</body></html>`

const browser = await chromium.launch({ executablePath: await resolveChromium() })
try {
  await mkdir(join(ROOT, 'public'), { recursive: true })
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'networkidle' })
  await page.screenshot({ path: OUT, type: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } })
  console.log(`✓ ${OUT.replace(ROOT, '.')} (${WIDTH}×${HEIGHT})`)
} finally {
  await browser.close()
}
