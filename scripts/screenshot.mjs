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
import { createServer } from 'node:http'
import { readFile, mkdir, stat, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUBLIC_DIR = join(ROOT, '.output', 'public')
const OUT_DIR = join(ROOT, 'screenshots')

const ROUTES = process.argv.slice(2).length ? process.argv.slice(2) : ['/']
const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 900 }
]
const THEMES = /** @type {const} */ (['light', 'dark'])

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
}

// The npm `playwright` version may not match the Chromium build pre-installed
// in this environment, so point it at the existing full Chromium build instead
// of triggering a download. Resolved dynamically — survives playwright bumps.
// Returns undefined when no pre-installed build is found (let playwright resolve).
async function resolveChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!base || !existsSync(base)) return undefined
  const builds = (await readdir(base))
    .filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  for (const build of builds) {
    const bin = join(base, build, 'chrome-linux', 'chrome')
    if (existsSync(bin)) return bin
  }
  return undefined
}

async function ensurePublic() {
  try {
    await stat(PUBLIC_DIR)
  } catch {
    console.error('✖ .output/public not found — run `pnpm generate` first.')
    process.exit(1)
  }
}

// Minimal static file server for the SSG output (no extra deps).
function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
      let filePath = join(PUBLIC_DIR, normalize(urlPath))
      if ((await stat(filePath).catch(() => null))?.isDirectory()) {
        filePath = join(filePath, 'index.html')
      }
      const body = await readFile(filePath)
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('Not found')
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function run() {
  await ensurePublic()
  await mkdir(OUT_DIR, { recursive: true })
  const { server, port } = await startServer()
  const browser = await chromium.launch({ executablePath: await resolveChromium() })

  try {
    for (const route of ROUTES) {
      for (const theme of THEMES) {
        const context = await browser.newContext({ colorScheme: theme })
        const page = await context.newPage()
        for (const vp of VIEWPORTS) {
          await page.setViewportSize({ width: vp.width, height: vp.height })
          await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'networkidle' })
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
