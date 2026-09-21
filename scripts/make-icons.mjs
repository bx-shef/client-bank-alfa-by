// Generate the raster app icons from the single master public/favicon.svg.
// Run when the logo changes:  pnpm icons
//
// Why this exists at all: the Marketplace listing requires an icon that is a SQUARE JPEG/PNG with
// NO transparency, 250–650px («Требования к оформлению», §1В п.10). The master is a rounded plate,
// so every straight export of it has transparent corners and would be rejected — and the rejection
// happens at moderation, i.e. after the submission is filed. There were no raster icons in this
// repository at all, so the card had nothing to upload. Ported from the sibling ai-price-import.
//
// Rasterisation goes through the pre-installed Chromium (same resolver as make-og.mjs) — no native
// image dependency is added to the repo.
//
// Outputs (committed static assets):
//   icon-market-512.png    512×512, OPAQUE — the Marketplace listing icon
//   server/utils/botAvatar.ts  192×192 OPAQUE, base64 — the chat bot's face (#496)
//   icons.stamp.json       sha256 of the SOURCE svg + of the produced icons
//
// The stamp hashes the SOURCE, not just the output: hashing only the output would compare two files
// this same script writes, so editing favicon.svg and forgetting `pnpm icons` would leave them both
// stale AND consistent — green CI with an old logo on the listing.
//
// Adding more sizes later (favicon-16/32, apple-touch-icon, PWA 192/512, maskable) is a one-line
// change per file: call `render` with the size. They are deliberately NOT generated today — nothing
// in this app references them (app.vue links the SVG favicon only), and unreferenced binaries in
// `public/` are dead weight that still has to be reviewed on every logo change.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { resolveChromium } from './lib/chromium.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUB = join(ROOT, 'public')

/** Plate colour of the logo — the backdrop an opaque render fills the corners with.
 *  Aligned with the family reference card (ai-price-import) per the visual-language decision. */
const PLATE = '#0b1220'

/** Render the SVG at `size`. `background: transparent` keeps the rounded corners cut out. */
async function render(page, svg, size, { background = 'transparent' } = {}) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; } body { width: ${size}px; height: ${size}px; background: ${background}; }
    img { width: ${size}px; height: ${size}px; }
  </style></head><body><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(html, { waitUntil: 'load' })
  return page.screenshot({ type: 'png', omitBackground: background === 'transparent', clip: { x: 0, y: 0, width: size, height: size } })
}

const svg = await readFile(join(PUB, 'favicon.svg'), 'utf8')
const browser = await chromium.launch({ executablePath: await resolveChromium() })
try {
  await mkdir(PUB, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 })

  // Opaque backdrop in the plate's own colour: the corners simply become square and the glyph is
  // untouched. (A maskable-style render would shrink the glyph to 80% — wrong for a listing icon,
  // which is displayed as-is.)
  const market = await render(page, svg, 512, { background: PLATE })
  await writeFile(join(PUB, 'icon-market-512.png'), market)

  // The chat bot's avatar (#496). Inlined as base64 into a TS module rather than written to
  // `public/`: the profile push happens SERVER-SIDE over REST (`imbot.v2.Bot.update`), so the bytes
  // must exist in the worker process — a URL would have to be fetched by the client's portal, and
  // that is one more thing to be blocked by a firewall we do not control.
  // OPAQUE for the same reason as the listing icon: a transparent plate shows as ragged corners on
  // the messenger's own background, which is not always white.
  const avatar = await render(page, svg, 192, { background: PLATE })
  await writeFile(join(ROOT, 'server/utils/botAvatar.ts'), [
    '// Сгенерирован `pnpm icons` из public/favicon.svg — РУКАМИ НЕ ПРАВИТЬ.',
    '//',
    '// Лицо чат-бота (#496): та же иконка, что у приложения, 192×192, непрозрачная. Bitrix24 ждёт',
    '// base64 БЕЗ префикса `data:`; ограничения — «должно быть изображением», не больше 5000×5000.',
    '//',
    '// ⚠ Здесь, а не в `public/`: аватар уезжает в портал клиента серверным REST-вызовом, то есть',
    '// байты обязаны быть в процессе воркера. Ссылку портал стал бы забирать сам, а это ещё одна',
    '// зависимость от чужой сети.',
    `export const BOT_AVATAR_BASE64 = '${avatar.toString('base64')}'`,
    ''
  ].join('\n'))

  const sha = b => createHash('sha256').update(b).digest('hex')
  await writeFile(join(PUB, 'icons.stamp.json'), `${JSON.stringify({
    source: sha(svg),
    iconMarket512: sha(market),
    botAvatar192: sha(avatar)
  }, null, 2)}\n`)

  console.log('✓ icon-market-512.png, server/utils/botAvatar.ts, icons.stamp.json')
} finally {
  await browser.close()
}
