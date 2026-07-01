// Tiny console/CLI helpers shared by the bank sandbox demo scripts
// (alfa-oauth-test.mjs, prior-oauth-test.mjs): ANSI colours, the ✓/!/✗ log
// prefixes, section headers, `die`, and a cross-platform browser opener.
// Standalone (no npm deps) so the scripts stay build-free.

import { spawn } from 'node:child_process'
import { platform } from 'node:process'
import { isHttpUrl } from './demo-utils.mjs'

/** ANSI colour codes used across the demo output. */
export const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m'
}

export const log = (...a) => console.log(...a)
/** Success line (green ✓). */
export const ok = s => log(`${C.green}✓${C.reset} ${s}`)
/** Warning line (yellow !). */
export const warn = s => log(`${C.yellow}!${C.reset} ${s}`)
/** Error line (red ✗). */
export const err = s => log(`${C.red}✗${C.reset} ${s}`)
/** Section header (bold cyan `── … ──`). */
export const head = s => log(`\n${C.bold}${C.cyan}── ${s} ──${C.reset}`)

/** Print an error and exit non-zero. */
export function die(msg) {
  err(msg)
  process.exit(1)
}

/**
 * Best-effort: open a URL in the user's default browser. Refuses anything that
 * is not a plain http(s) URL so a malformed value can't break out of the
 * `start "" "…"` quoting on Windows (windowsVerbatimArguments passes the string
 * through unescaped, so cmd.exe's "&" separator is neutralised by the quotes).
 */
export function openBrowser(url) {
  if (!isHttpUrl(url)) {
    warn('not opening the browser: URL is not a plain http(s) URL — open it manually')
    return
  }
  const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open'
  const cmdArgs = platform === 'win32' ? ['/c', 'start', '""', `"${url}"`] : [url]
  try {
    const child = spawn(cmd, cmdArgs, {
      stdio: 'ignore',
      detached: true,
      windowsVerbatimArguments: platform === 'win32'
    })
    child.on('error', () => {})
    child.unref()
  } catch { /* best-effort */ }
}
