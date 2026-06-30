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
 * space-separated list of 'sha256-...' sources.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Recursively yields every *.html file under `dir` (pages live in subfolders:
 *  /app/index.html, /settings/index.html, …). */
function htmlFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...htmlFiles(full))
    else if (entry.name.endsWith('.html')) out.push(full)
  }
  return out
}

const TOKEN = '__CSP_SCRIPT_HASHES__'
const htmlDir = process.argv[2] || '.output/public'
const inConf = process.argv[3] || 'nginx.conf'
const outConf = process.argv[4] || inConf

// Inline <script> = a script tag without a `src` attribute. Capture its body.
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g

/** Collects unique sha256 hashes of inline scripts across every .html file. */
function collectHashes(dir) {
  const hashes = new Set()
  for (const file of htmlFiles(dir)) {
    const html = readFileSync(file, 'utf8')
    for (const [, body] of html.matchAll(INLINE_SCRIPT)) {
      hashes.add(createHash('sha256').update(body, 'utf8').digest('base64'))
    }
  }
  return [...hashes].map(h => `'sha256-${h}'`)
}

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
