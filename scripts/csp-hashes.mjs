#!/usr/bin/env node
/*
 * Injects sha256 CSP hashes for the inline <script> blocks Nuxt emits into the
 * production nginx config, so the served CSP can drop `script-src 'unsafe-inline'`.
 *
 * Why at build time: one of the inline scripts is `window.__NUXT__.config`, whose
 * content embeds a per-build `buildId`, so its hash changes on every build and
 * cannot be hard-coded. Hashes are computed from the exact bytes nginx will serve
 * (the prerendered *.html), guaranteeing they match what the browser checks.
 *
 * Usage: node scripts/csp-hashes.mjs [htmlDir] [inConf] [outConf]
 *   htmlDir  prerendered output dir            (default: .output/public)
 *   inConf   nginx config with the placeholder (default: nginx.conf)
 *   outConf  where to write the result         (default: same as inConf, in place)
 *
 * The placeholder token `__CSP_SCRIPT_HASHES__` in inConf is replaced with the
 * space-separated list of 'sha256-...' sources. The collectHashes/htmlFiles
 * helpers are exported for unit tests; the CLI part only runs when invoked directly.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TOKEN = '__CSP_SCRIPT_HASHES__'

// Inline <script> = a script tag without a `src` attribute. The second lookahead
// skips non-executable data blocks (e.g. Nuxt's `<script type="application/json"
// id="__NUXT_DATA__">` island): CSP never evaluates those, so hashing them only
// bloats the allow-list. Executable inline scripts carry no type (or text/javascript
// / module), which this still matches.
export const INLINE_SCRIPT
  = /<script(?![^>]*\bsrc=)(?![^>]*\btype=["'][^"']*(?:json|importmap)[^"']*["'])[^>]*>([\s\S]*?)<\/script>/g

/** Recursively yields every *.html file under `dir` (pages live in subfolders:
 *  /app/index.html, /settings/index.html, …). */
export function htmlFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...htmlFiles(full))
    else if (entry.name.endsWith('.html')) out.push(full)
  }
  return out
}

/** Collects unique sha256 sources of executable inline scripts across every
 *  .html file. Empty-bodied scripts are skipped (a browser blocks them anyway,
 *  and they would only add the constant hash of "" to the allow-list). */
export function collectHashes(dir) {
  const hashes = new Set()
  for (const file of htmlFiles(dir)) {
    const html = readFileSync(file, 'utf8')
    for (const [, body] of html.matchAll(INLINE_SCRIPT)) {
      if (body.trim() === '') continue
      hashes.add(createHash('sha256').update(body, 'utf8').digest('base64'))
    }
  }
  return [...hashes].map(h => `'sha256-${h}'`)
}

/** CLI entry: compute hashes from htmlDir and inject them into inConf → outConf. */
function main(argv) {
  const htmlDir = argv[2] || '.output/public'
  const inConf = argv[3] || 'nginx.conf'
  const outConf = argv[4] || inConf

  const sources = collectHashes(htmlDir)
  if (!sources.length) {
    console.error(`csp-hashes: no inline scripts found in ${htmlDir} — refusing to write an empty allow-list`)
    process.exit(1)
  }

  const conf = readFileSync(inConf, 'utf8')
  if (!conf.includes(TOKEN)) {
    console.error(`csp-hashes: placeholder ${TOKEN} not found in ${inConf}`)
    process.exit(1)
  }

  writeFileSync(outConf, conf.replaceAll(TOKEN, sources.join(' ')))
  console.log(`csp-hashes: injected ${sources.length} hash(es) into ${outConf}:`)
  for (const s of sources) console.log(`  ${s}`)
}

// Run the CLI only when executed directly (`node scripts/csp-hashes.mjs`), not
// when imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
}
