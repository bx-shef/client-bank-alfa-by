#!/usr/bin/env node
// Alfa-Bank BY — end-to-end Open API demo (OAuth Code Grant + accounts + statement).
//
// Standalone: no npm deps, no build step. Node >= 18, Linux / macOS / Windows.
// Walks the whole happy path and prints each step:
//   1. OAuth Authorization Code Grant  → access_token / refresh_token
//   2. GET /partner/1.2.0/accounts/    → the company's accounts + balances
//   3. GET …/accounts/statement        → statement per account, year by year
//      (default 2000…2029, `transactions=0` = all operations)
//   4. refresh_token                   → a fresh access_token
//
// Logging is masked by default: tokens, account numbers and UNP/corr accounts
// are redacted in the console. The FULL, unmasked responses are written to
// `alfa-demo-output.json` (gitignored) so you can inspect the real data locally.
// Pass `--full` to also print everything unmasked to the console.
//
// Secrets are never hard-coded. Config comes from .env (auto-loaded) / env / flags:
//   ALFA_BASE_URL       (default https://developerhub.alfabank.by:8273; prod ibapi2.alfabank.by:8273)
//   ALFA_CLIENT_ID      / --client-id
//   ALFA_CLIENT_SECRET  / --client-secret
//   ALFA_REDIRECT_URI   / --redirect-uri  (must match the one registered for the app)
//   ALFA_SCOPE          / --scope         (default "accounts")
//   ALFA_API_PREFIX     / --api-prefix    (default "/partner/1.2.0")
//
// Flags: --from-year 2000 --to-year 2029 --account <number> --delay-ms 700
//        --code <authCode> (skip browser) --refresh <token> (refresh only)
//        --url-only (just print the authorize URL) --full (no masking)

import { request } from 'node:https'
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { stdin as input, stdout as output, platform } from 'node:process'

// --- minimal .env loader (no deps) -----------------------------------------
// Node does not read .env automatically. Load KEY=VALUE pairs from .env.local
// then .env in the cwd, without overriding values already set in the real
// environment or on the command line.
function loadDotEnv() {
  for (const file of ['.env.local', '.env']) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch { continue }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      let val = m[2]
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
        val = val.slice(1, -1)
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val
    }
  }
}
loadDotEnv()

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
  base: (args['base'] || process.env.ALFA_BASE_URL || 'https://developerhub.alfabank.by:8273').replace(/\/+$/, ''),
  clientId: args['client-id'] || process.env.ALFA_CLIENT_ID || '',
  clientSecret: args['client-secret'] || process.env.ALFA_CLIENT_SECRET || '',
  redirectUri: args['redirect-uri'] || process.env.ALFA_REDIRECT_URI || 'https://www.client.example.com',
  scope: args['scope'] || process.env.ALFA_SCOPE || 'accounts',
  apiPrefix: (args['api-prefix'] || process.env.ALFA_API_PREFIX || '/partner/1.2.0').replace(/\/+$/, ''),
  state: args['state'] || 'alfa-oauth-test',
  fromYear: Number(args['from-year'] || 2000),
  toYear: Number(args['to-year'] || 2029),
  onlyAccount: args['account'] ? String(args['account']) : '',
  delayMs: Number(args['delay-ms'] || 700),
  full: Boolean(args['full'])
}

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m'
}
const log = (...a) => console.log(...a)
const ok = s => log(`${C.green}✓${C.reset} ${s}`)
const warn = s => log(`${C.yellow}!${C.reset} ${s}`)
const err = s => log(`${C.red}✗${C.reset} ${s}`)
const head = s => log(`\n${C.bold}${C.cyan}── ${s} ──${C.reset}`)

function die(msg) {
  err(msg)
  process.exit(1)
}

if (!cfg.clientId) die('client_id is required (--client-id or ALFA_CLIENT_ID)')

// --- masking (console only; full data goes to the output file) -------------
// client_id / redirect_uri are not secrets (they appear in the browser URL),
// so only tokens and account/UNP numbers are redacted here.
function maskToken(t) {
  if (cfg.full || !t) return t
  const s = String(t)
  return `${s.slice(0, 8)}…[${s.length} chars]`
}
function maskNumber(n) {
  if (cfg.full || !n) return n
  const s = String(n)
  return s.length <= 4 ? '****' : `****${s.slice(-4)}`
}
const trunc = (s, n = 70) => (s && String(s).length > n ? String(s).slice(0, n) + '…' : s)

// --- HTTP ------------------------------------------------------------------
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
        // verification here; a cert failure is a real finding to report.
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
    req.setTimeout(40000, () => req.destroy(new Error('request timed out after 40s')))
    if (body) req.write(body)
    req.end()
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function tokenAuthHeader() {
  // RFC 6749 §2.3.1 — client credentials as HTTP Basic auth. Never logged.
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

async function apiGet(path, accessToken, query) {
  const qs = query ? '?' + query.toString() : ''
  return httpRequest(`${cfg.base}${path}${qs}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  })
}

// --- OAuth helpers ---------------------------------------------------------
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
  // cmd.exe treats "&" in the URL as a command separator — quote it and pass
  // verbatim so `start` gets the whole URL as one argument.
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

function extractCode(raw) {
  const s = String(raw).trim()
  if (!s) return null
  if (s.includes('code=') || s.startsWith('http')) {
    try {
      const u = new URL(s, 'https://placeholder.local')
      const st = u.searchParams.get('state')
      if (st && st !== cfg.state) warn(`state mismatch (sent "${cfg.state}", got "${st}")`)
      const code = u.searchParams.get('code')
      if (code) return code
    } catch { /* fall through */ }
  }
  return s
}

// --- steps -----------------------------------------------------------------
async function preflight() {
  head('Preflight: gateway reachability')
  log(`${C.dim}base:${C.reset} ${cfg.base}`)
  try {
    const r = await postToken({})
    if (r.json && r.json.error) {
      ok(`/token is live — ${r.status} OAuth error "${r.json.error}" (expected for an empty request)`)
    } else {
      ok(`/token responded HTTP ${r.status}`)
    }
    return true
  } catch (e) {
    err(`cannot reach ${cfg.base}/token — ${e.message}`)
    log(`${C.yellow}Hint:${C.reset} the gateway is on the non-standard port 8273 — ensure outbound`)
    log('  TCP to that host:port is allowed. On a TLS/cert error set NODE_EXTRA_CA_CERTS')
    log('  (do NOT disable verification).')
    return false
  }
}

async function exchangeCode(code) {
  head('Step 1: exchange authorization_code → tokens')
  const r = await postToken({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri })
  log(`${C.dim}HTTP ${r.status}${C.reset}`)
  if (r.status >= 200 && r.status < 300 && r.json && r.json.access_token) {
    log(`  access_token:  ${maskToken(r.json.access_token)}`)
    log(`  refresh_token: ${maskToken(r.json.refresh_token)}`)
    log(`  token_type:    ${r.json.token_type}   expires_in: ${r.json.expires_in}s`)
    log(`  scope granted: ${r.json.scope}`)
    if (r.json.scope && cfg.scope.split(/\s+/).some(s => !String(r.json.scope).split(/\s+/).includes(s))) {
      warn(`requested "${cfg.scope}" but got "${r.json.scope}" — some scopes were not granted`)
    }
    ok('token exchange OK')
    return r.json
  }
  err(`token exchange failed (HTTP ${r.status})`)
  log(r.json ? JSON.stringify(r.json, null, 2) : trunc(r.text, 500))
  return null
}

async function getAccounts(accessToken) {
  head('Step 2: GET /accounts/ — company accounts & balances')
  const r = await apiGet(`${cfg.apiPrefix}/accounts/`, accessToken)
  log(`${C.dim}HTTP ${r.status}  ${cfg.base}${cfg.apiPrefix}/accounts/${C.reset}`)
  if (r.status < 200 || r.status >= 300) {
    err(`accounts request failed (HTTP ${r.status})`)
    log(r.json ? JSON.stringify(r.json, null, 2) : trunc(r.text, 500))
    return { raw: r.json ?? r.text, accounts: [] }
  }
  const accounts = (r.json && (r.json.accounts || r.json.account)) || (Array.isArray(r.json) ? r.json : [])
  ok(`${accounts.length} account(s)`)
  for (const a of accounts) {
    log(`  • ${maskNumber(a.number)}  ${a.currIso ?? ''}  balance ${a.amount ?? '?'}  `
      + `${a.type ?? ''}${a.isCard ? ' [card]' : ''}`
      + `${a.isArrested ? ' [arrested]' : ''}${a.actualBalanceDate ? `  @${a.actualBalanceDate}` : ''}`)
  }
  return { raw: r.json, accounts }
}

async function getStatementYear(accessToken, number, year) {
  const q = new URLSearchParams({
    number,
    dateFrom: `01.01.${year}`,
    dateTo: `31.12.${year}`,
    transactions: '0',
    pageNo: '0',
    pageRowCount: '0'
  })
  const r = await apiGet(`${cfg.apiPrefix}/accounts/statement`, accessToken, q)
  const page = (r.json && r.json.page) || []
  const errors = (r.json && r.json.errors) || []
  const statistics = (r.json && r.json.statistics) || []
  return { status: r.status, page, errors, statistics, raw: r.json ?? r.text }
}

async function getStatements(accessToken, accounts) {
  head(`Step 3: statements per account, year by year (${cfg.fromYear}…${cfg.toYear}, all operations)`)
  const numbers = accounts
    .map(a => a.number)
    .filter(Boolean)
    .filter(n => !cfg.onlyAccount || String(n) === cfg.onlyAccount)
  if (!numbers.length) {
    warn('no account numbers to query')
    return []
  }
  const out = []
  for (const number of numbers) {
    log(`\n${C.bold}account ${maskNumber(number)}${C.reset}`)
    let total = 0
    for (let y = cfg.fromYear; y <= cfg.toYear; y++) {
      let res
      try {
        res = await getStatementYear(accessToken, number, y)
      } catch (e) {
        err(`  ${y}: request error — ${e.message}`)
        continue
      }
      out.push({ account: number, year: y, ...res })
      if (res.errors.length) {
        warn(`  ${y}: HTTP ${res.status}, ${res.errors.length} error(s): ${res.errors.map(e => trunc(e.message || JSON.stringify(e), 80)).join('; ')}`)
      } else if (res.page.length) {
        total += res.page.length
        const sample = res.page[0]
        log(`  ${y}: ${res.page.length} op(s)  ${C.dim}e.g.${C.reset} ${sample.operType ?? '?'} ${sample.amount ?? '?'} ${sample.currIso ?? ''} `
          + `← ${trunc(sample.corrName, 24) ?? ''} (${maskNumber(sample.corrNumber)}) "${trunc(sample.purpose, 40)}"`)
      } else if (res.status >= 200 && res.status < 300) {
        log(`  ${C.dim}${y}: 0 ops${C.reset}`)
      } else {
        warn(`  ${y}: HTTP ${res.status}`)
      }
      if (cfg.delayMs > 0) await sleep(cfg.delayMs)
    }
    ok(`account ${maskNumber(number)}: ${total} operation(s) across ${cfg.fromYear}…${cfg.toYear}`)
  }
  return out
}

async function refresh(refreshToken) {
  head('Step 4: refresh_token → new access_token')
  const r = await postToken({ grant_type: 'refresh_token', refresh_token: refreshToken })
  log(`${C.dim}HTTP ${r.status}${C.reset}`)
  if (r.status >= 200 && r.status < 300 && r.json && r.json.access_token) {
    log(`  new access_token:  ${maskToken(r.json.access_token)}`)
    log(`  new refresh_token: ${maskToken(r.json.refresh_token)}`)
    log(`  expires_in: ${r.json.expires_in}s`)
    ok('refresh OK')
    return r.json
  }
  err(`refresh failed (HTTP ${r.status})`)
  log(r.json ? JSON.stringify(r.json, null, 2) : trunc(r.text, 500))
  return null
}

function saveOutput(data) {
  const file = 'alfa-demo-output.json'
  try {
    writeFileSync(file, JSON.stringify(data, null, 2))
    ok(`full unmasked data written to ${file} (gitignored)`)
  } catch (e) {
    warn(`could not write ${file}: ${e.message}`)
  }
}

// --- main ------------------------------------------------------------------
async function main() {
  log(`${C.bold}Alfa-Bank BY — Open API end-to-end demo${C.reset}`)
  log(`${C.dim}client_id:${C.reset} ${cfg.clientId}`)
  log(`${C.dim}redirect_uri:${C.reset} ${cfg.redirectUri}`)
  log(`${C.dim}scope:${C.reset} ${cfg.scope}   ${C.dim}masking:${C.reset} ${cfg.full ? 'OFF (--full)' : 'ON'}`)

  if (args['url-only']) {
    head('Authorize URL')
    log(buildAuthorizeUrl())
    return
  }
  if (args['refresh']) {
    await preflight()
    await refresh(String(args['refresh']))
    return
  }

  const reachable = await preflight()
  if (!reachable) {
    warn('gateway not reachable from here — fix connectivity and re-run (--url-only still works)')
    process.exit(2)
  }

  // Authorize (unless a code was supplied).
  let code = args['code'] ? String(args['code']) : null
  if (!code) {
    head('Authorize: open this URL, log in, approve')
    const url = buildAuthorizeUrl()
    log(url)
    openBrowser(url)
    log(`${C.dim}(opening your browser…)${C.reset}`)
    const rl = createInterface({ input, output })
    const pasted = await rl.question(`\n${C.bold}Paste the redirected URL (or just the code):${C.reset} `)
    rl.close()
    code = extractCode(pasted)
  }
  if (!code) die('no authorization code provided')

  const tokens = await exchangeCode(code)
  if (!tokens) process.exit(1)

  const { raw: accountsRaw, accounts } = await getAccounts(tokens.access_token)
  const statements = await getStatements(tokens.access_token, accounts)

  const refreshed = tokens.refresh_token ? await refresh(tokens.refresh_token) : null

  head('Save')
  saveOutput({
    generatedAt: new Date().toISOString(),
    base: cfg.base,
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    requestedScope: cfg.scope,
    grantedScope: tokens.scope,
    tokenExchange: tokens,
    refresh: refreshed,
    accounts: accountsRaw,
    statements
  })

  head('Done')
  ok('OAuth → accounts → statement → refresh completed.')
}

main().catch(e => die(e.stack || e.message))
