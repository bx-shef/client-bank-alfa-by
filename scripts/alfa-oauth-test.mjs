#!/usr/bin/env node
// Alfa-Bank BY OAuth 2.0 Authorization Code Grant — live test harness.
//
// Standalone: no npm deps, no build step. Works on Linux / macOS / Windows
// with Node >= 18. Walks the full Code Grant flow against the Alfa developerhub
// gateway and prints every request/response so you can confirm it end-to-end.
//
// Flow:
//   1. build + open the /authorize URL (you log in to Alfa and approve);
//   2. Alfa redirects to your redirect_uri with ?code=...&state=...;
//   3. paste that redirected URL (or just the code) back here;
//   4. the script exchanges the code at /token and prints the tokens;
//   5. it then refreshes the access_token to prove the refresh grant works.
//
// Secrets are NOT hard-coded. Pass them via flags or env vars:
//   ALFA_CLIENT_ID / --client-id
//   ALFA_CLIENT_SECRET / --client-secret
//   ALFA_REDIRECT_URI / --redirect-uri  (must match the one registered for the client)
//   ALFA_SCOPE / --scope                (default: "accounts read_documents profile")
//   ALFA_BASE / --base                  (default: https://developerhub.alfabank.by:8273)
//
// Examples:
//   Linux/macOS:
//     ALFA_CLIENT_ID=xxx ALFA_CLIENT_SECRET=yyy node scripts/alfa-oauth-test.mjs
//   Windows (PowerShell):
//     $env:ALFA_CLIENT_ID="xxx"; $env:ALFA_CLIENT_SECRET="yyy"; node scripts/alfa-oauth-test.mjs
//   Non-interactive (already have a code):
//     node scripts/alfa-oauth-test.mjs --client-id xxx --client-secret yyy --code AUTH_CODE
//   Just print the authorize URL:
//     node scripts/alfa-oauth-test.mjs --client-id xxx --url-only
//   Refresh an existing token:
//     node scripts/alfa-oauth-test.mjs --client-id xxx --client-secret yyy --refresh REFRESH_TOKEN

import { request } from 'node:https'
import { createInterface } from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { stdin as input, stdout as output, platform } from 'node:process'

// --- tiny arg parser -------------------------------------------------------
function parseArgs(argv) {
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

const args = parseArgs(process.argv.slice(2))

const cfg = {
  clientId: args['client-id'] || process.env.ALFA_CLIENT_ID || '',
  clientSecret: args['client-secret'] || process.env.ALFA_CLIENT_SECRET || '',
  redirectUri: args['redirect-uri'] || process.env.ALFA_REDIRECT_URI || 'https://www.client.example.com',
  scope: args['scope'] || process.env.ALFA_SCOPE || 'accounts read_documents profile',
  base: (args['base'] || process.env.ALFA_BASE || 'https://developerhub.alfabank.by:8273').replace(/\/+$/, ''),
  state: args['state'] || 'alfa-oauth-test'
}

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m'
}
const log = (...a) => console.log(...a)
const ok = s => log(`${C.green}✓${C.reset} ${s}`)
const err = s => log(`${C.red}✗${C.reset} ${s}`)
const head = s => log(`\n${C.bold}${C.cyan}── ${s} ──${C.reset}`)

function die(msg) {
  err(msg)
  process.exit(1)
}

if (!cfg.clientId) die('client_id is required (--client-id or ALFA_CLIENT_ID)')

// --- HTTP helpers ----------------------------------------------------------
function httpRequest(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers
        // Honour the standard CA env vars (NODE_EXTRA_CA_CERTS) — never disable
        // verification here; if the cert fails, that is a real finding to report.
      },
      (res) => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json
          try {
            json = JSON.parse(text)
          } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json })
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('request timed out after 30s')))
    if (body) req.write(body)
    req.end()
  })
}

function tokenAuthHeader() {
  // OAuth 2.0 RFC 6749 §2.3.1 — client credentials as HTTP Basic auth.
  return 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')
}

async function postToken(form) {
  const body = new URLSearchParams(form).toString()
  return httpRequest(`${cfg.base}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': tokenAuthHeader(),
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  })
}

function buildAuthorizeUrl() {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    state: cfg.state
  })
  return `${cfg.base}/authorize?${q.toString()}`
}

function openBrowser(url) {
  // The authorize URL contains "&", which cmd.exe treats as a command
  // separator — quote the whole URL and pass it verbatim so `start` gets it
  // as one argument. On macOS/Linux argv is passed as-is, no quoting needed.
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
  } catch { /* opening a browser is best-effort */ }
}

function printTokens(label, json) {
  log(`${C.dim}${label}:${C.reset}`)
  log(JSON.stringify(json, null, 2))
  if (json && json.access_token) {
    ok(`access_token received (${String(json.access_token).slice(0, 12)}…, type ${json.token_type || '?'}, expires_in ${json.expires_in}s)`)
  }
}

// --- preflight reachability -----------------------------------------------
async function preflight() {
  head('Preflight: gateway reachability')
  log(`${C.dim}base:${C.reset} ${cfg.base}`)
  try {
    // A bare POST /token with no grant should yield a structured OAuth error
    // (HTTP 400/401 + JSON {error}). Any such answer proves the gateway is live.
    const r = await postToken({})
    if (r.json && r.json.error) {
      ok(`/token is live — responded ${r.status} with OAuth error "${r.json.error}" (expected for an empty request)`)
    } else {
      ok(`/token responded HTTP ${r.status}`)
      if (!r.json) log(`${C.yellow}note:${C.reset} non-JSON body (first 200 chars): ${r.text.slice(0, 200)}`)
    }
    return true
  } catch (e) {
    err(`cannot reach ${cfg.base}/token — ${e.message}`)
    log(`${C.yellow}Hints:${C.reset}`)
    log('  • The Alfa OAuth gateway listens on the non-standard port 8273.')
    log('    Make sure outbound TCP to developerhub.alfabank.by:8273 is allowed')
    log('    by your network / firewall / proxy.')
    log('  • If you see a TLS/certificate error, point NODE_EXTRA_CA_CERTS at the')
    log('    proper CA bundle — do NOT disable verification.')
    return false
  }
}

async function exchangeCode(code) {
  head('Step: exchange authorization_code → tokens')
  const r = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri
  })
  log(`${C.dim}HTTP ${r.status}${C.reset}`)
  if (r.status >= 200 && r.status < 300 && r.json && r.json.access_token) {
    printTokens('token response', r.json)
    return r.json
  }
  err(`token exchange failed (HTTP ${r.status})`)
  log(r.json ? JSON.stringify(r.json, null, 2) : r.text.slice(0, 500))
  return null
}

async function refresh(refreshToken) {
  head('Step: refresh_token → new access_token')
  const r = await postToken({ grant_type: 'refresh_token', refresh_token: refreshToken })
  log(`${C.dim}HTTP ${r.status}${C.reset}`)
  if (r.status >= 200 && r.status < 300 && r.json && r.json.access_token) {
    printTokens('refresh response', r.json)
    return r.json
  }
  err(`refresh failed (HTTP ${r.status})`)
  log(r.json ? JSON.stringify(r.json, null, 2) : r.text.slice(0, 500))
  return null
}

// Accept either a raw code or a full redirected URL pasted by the user.
function extractCode(raw) {
  const s = raw.trim()
  if (!s) return null
  if (s.includes('code=') || s.startsWith('http')) {
    try {
      const u = new URL(s, 'https://placeholder.local')
      const code = u.searchParams.get('code')
      const st = u.searchParams.get('state')
      if (st && st !== cfg.state) {
        log(`${C.yellow}warning:${C.reset} state mismatch (sent "${cfg.state}", got "${st}")`)
      }
      if (code) return code
    } catch { /* fall through to treat as raw code */ }
  }
  return s
}

// --- main ------------------------------------------------------------------
async function main() {
  log(`${C.bold}Alfa-Bank BY — OAuth 2.0 Authorization Code Grant test${C.reset}`)
  log(`${C.dim}client_id:${C.reset} ${cfg.clientId}`)
  log(`${C.dim}redirect_uri:${C.reset} ${cfg.redirectUri}`)
  log(`${C.dim}scope:${C.reset} ${cfg.scope}`)

  const authorizeUrl = buildAuthorizeUrl()

  if (args['url-only']) {
    head('Authorize URL')
    log(authorizeUrl)
    return
  }

  // Direct modes (skip the interactive browser step).
  if (args['refresh']) {
    await preflight()
    await refresh(String(args['refresh']))
    return
  }
  if (args['code']) {
    await preflight()
    const tokens = await exchangeCode(String(args['code']))
    if (tokens && tokens.refresh_token) await refresh(tokens.refresh_token)
    return
  }

  // Interactive flow.
  const reachable = await preflight()
  if (!reachable) {
    log(`\n${C.yellow}Gateway not reachable from here — fix connectivity and re-run.${C.reset}`)
    log(`You can still grab the authorize URL with: --url-only`)
    process.exit(2)
  }

  head('Step: open the authorize URL in a browser')
  log(authorizeUrl)
  log(`${C.dim}(opening your default browser…)${C.reset}`)
  openBrowser(authorizeUrl)

  const rl = createInterface({ input, output })
  log('\nLog in to Alfa, approve the requested scopes, then copy the URL you are')
  log('redirected to (it contains ?code=...). The redirect page itself may fail to')
  log('load — that is fine, only the URL matters.')
  const pasted = await rl.question(`\n${C.bold}Paste the redirected URL (or just the code):${C.reset} `)
  rl.close()

  const code = extractCode(pasted)
  if (!code) die('no authorization code provided')
  ok(`got authorization code: ${code.slice(0, 12)}…`)

  const tokens = await exchangeCode(code)
  if (!tokens) process.exit(1)
  if (tokens.refresh_token) await refresh(tokens.refresh_token)

  head('Done')
  ok('Authorization Code Grant flow completed successfully.')
}

main().catch(e => die(e.stack || e.message))
