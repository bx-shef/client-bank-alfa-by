// Resolve the pre-installed Chromium build for Playwright (shared by
// screenshot.mjs and make-og.mjs). The npm `playwright` version may not match
// the Chromium build baked into this environment, so point it at the existing
// full build instead of triggering a download. Survives playwright bumps.
// Returns undefined when no pre-installed build is found (let playwright resolve).
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function resolveChromium() {
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
