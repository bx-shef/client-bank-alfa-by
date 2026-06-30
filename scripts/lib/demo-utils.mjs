// Pure helpers for scripts/alfa-oauth-test.mjs — extracted so the
// security-sensitive bits (token/number masking) and the fiddly parsers
// (.env lines, OAuth redirect, CLI args) are unit-tested (tests/demoUtils.test.ts).
// Plain ESM, no deps — the demo script stays standalone (no build step).

/** Parse `--flag value` / `--bool` CLI args into a plain object. */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

/**
 * Parse one `.env` line into `[key, value]`, or null for blanks/comments.
 * Quoted values are unwrapped verbatim; for unquoted values an inline
 * `# comment` (preceded by whitespace) is stripped — a URL's `#fragment`
 * (no leading space) is preserved.
 */
export function parseDotEnvLine(line) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
  if (!m) return null
  let val = m[2]
  const quoted = (val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))
  if (quoted) {
    val = val.slice(1, -1)
  } else {
    const hash = val.search(/\s#/)
    if (hash >= 0) val = val.slice(0, hash).trimEnd()
  }
  return [m[1], val]
}

/** Mask a token for console output: first 8 chars + length. `full` disables it.
 * Empty/nullish values pass through (nothing to leak). */
export function maskToken(t, full) {
  if (full || t == null || t === '') return t
  const s = String(t)
  return `${s.slice(0, 8)}…[${s.length} chars]`
}

/** Mask an account-like number, keeping the last 4 digits. `full` disables it. */
export function maskNumber(n, full) {
  if (full || n == null || n === '') return n
  const s = String(n)
  return s.length <= 4 ? '****' : `****${s.slice(-4)}`
}

/** Truncate a string to `n` chars with an ellipsis; nullish passes through. */
export function trunc(s, n = 70) {
  return s != null && String(s).length > n ? String(s).slice(0, n) + '…' : s
}

/**
 * Pull `code`/`state` out of a pasted OAuth redirect. Accepts a full URL, a
 * bare query string, or a raw code; returns `{ code, state }`. If no `code`
 * query param is found, the whole trimmed input is treated as the code.
 */
export function extractRedirect(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { code: null, state: null }
  if (s.includes('code=') || s.startsWith('http')) {
    try {
      const u = new URL(s, 'https://placeholder.local')
      const code = u.searchParams.get('code')
      if (code) return { code, state: u.searchParams.get('state') }
    } catch { /* fall through to treat input as a raw code */ }
  }
  return { code: s, state: null }
}

/** Copy a token set with access/refresh tokens redacted (for persisted output). */
export function redactTokenSet(tokenSet) {
  if (!tokenSet || typeof tokenSet !== 'object') return tokenSet
  const out = { ...tokenSet }
  if (out.access_token) out.access_token = '[REDACTED]'
  if (out.refresh_token) out.refresh_token = '[REDACTED]'
  return out
}

/** Whether a string is a syntactically valid http(s) URL (browser-open guard). */
export function isHttpUrl(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
