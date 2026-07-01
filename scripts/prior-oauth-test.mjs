#!/usr/bin/env node
// Priorbank BY — Open Banking (СПР) sandbox end-to-end demo.
//
// Standalone: no npm deps, no build step. Node >= 18, Linux / macOS / Windows.
// Walks the СПР flow against the SANDBOX (api.priorbank.by:9344, plain TLS — no
// СКЗИ needed there; the BY-crypto TLS via АВЕСТ is a PROD-only concern, see
// docs/PRIOR_API.md and issue #41). Steps mirror the bank's official guide:
//
//   [--gen-key]  generate an RSA keypair + print the `jwks` for DCR registration
//   [--oidc]     token A → GET /oidcdiscovery (issuer, token endpoint = JWT `aud`)
//   [--dcr]      token A (tech app) → POST /register → business app client_id/secret
//   (default)    business app:
//     1. token Б  (client_credentials, scope=accounts)
//     2. POST /accountConsents           → openbanking_intent_id
//     3. GET /oauth2/authorize (signed `request` JWT) → user logs in → code
//     4. exchange code → token B
//     5. GET /accounts                   → accountId(s)
//     6. POST/GET /accounts/{id}/statements (async: create then poll)
//   [--revoke <t>]  POST /oauth2/revoke
//
// CONFIRMED from the official PDF: hosts/ports, method paths, scopes, grant_types,
// auth methods, consent permissions, sandbox test users. TO CONFIRM on the live
// run / Postman collection: the GET /accounts response shape and the create-
// statement request body (marked below) — the bank ships those in the Account API.
//
// Config auto-loads from `.env.priorbank` (then `.env.local`, `.env`); copy
// `.env.priorbank.example` and fill in. Secrets never hard-coded; real env vars
// and flags win over the file. Tokens/accounts are masked in the console and in
// the `prior-demo-output.json` dump (gitignored); pass `--full` to disable.
//   PRIOR_BASE            (default https://api.priorbank.by:9344 — sandbox)
//   PRIOR_TECH_CLIENT_ID / PRIOR_TECH_CLIENT_SECRET   (tech app — only for --dcr)
//   PRIOR_CLIENT_ID / PRIOR_CLIENT_SECRET             (business app)
//   PRIOR_REDIRECT_URI   / --redirect-uri
//   PRIOR_PRIVATE_KEY    (path to PEM, signs the authorize `request` JWT)
//   PRIOR_KID            (JWK key id; must match the `kid` published in `jwks`)
//   PRIOR_ACCOUNT_ID     / --account   (skip listing, query one account)
// Flags: --env <file> --from <YYYY-MM-DD> --to <YYYY-MM-DD> --code <code>
//        --consent <intentId> --poll 8 --delay-ms 1500 --full --url-only
//        --verbose (dump the /register request + full response for debugging)

import { request } from 'node:https'
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { randomUUID, createSign, generateKeyPairSync, createPublicKey } from 'node:crypto'
import { stdin as input, stdout as output, platform } from 'node:process'
import {
  parseArgs, trunc, extractRedirect, redactTokenSet, isHttpUrl,
  maskToken as maskTokenPure, maskNumber as maskNumberPure
} from './lib/demo-utils.mjs'
import { loadDotEnv } from './lib/env.mjs'

const args = parseArgs(process.argv.slice(2))

const explicitEnv = args['env'] ? String(args['env']) : null
const envFile = loadDotEnv(
  explicitEnv ? [explicitEnv] : ['.env.priorbank', '.env.local', '.env'],
  { explicit: Boolean(explicitEnv) }
)

const cfg = {
  base: (args['base'] || process.env.PRIOR_BASE || 'https://api.priorbank.by:9344').replace(/\/+$/, ''),
  techId: args['tech-client-id'] || process.env.PRIOR_TECH_CLIENT_ID || '',
  techSecret: args['tech-client-secret'] || process.env.PRIOR_TECH_CLIENT_SECRET || '',
  clientId: args['client-id'] || process.env.PRIOR_CLIENT_ID || '',
  clientSecret: args['client-secret'] || process.env.PRIOR_CLIENT_SECRET || '',
  redirectUri: args['redirect-uri'] || process.env.PRIOR_REDIRECT_URI || 'https://redirect_uri.your',
  privateKeyPath: args['private-key'] || process.env.PRIOR_PRIVATE_KEY || '',
  kid: args['kid'] || process.env.PRIOR_KID || 'prior-key-1',
  accountId: args['account'] ? String(args['account']) : (process.env.PRIOR_ACCOUNT_ID || ''),
  from: args['from'] ? String(args['from']) : '',
  to: args['to'] ? String(args['to']) : '',
  poll: Number(args['poll'] || 8),
  delayMs: Number(args['delay-ms'] || 1500),
  state: args['state'] || `s-${randomUUID()}`,
  full: Boolean(args['full'])
}

// API bases (СПР), per the official guide.
const AUTH = '/open-banking-authorize/v1.0'
const DCR = '/open-banking-dcr/v1.0'
const OB = '/open-banking/v1.0'

// Consent permissions we need — statements + transactions (income & outcome).
const CONSENT_PERMISSIONS = [
  'ReadAccountsBasic', 'ReadAccountsDetail', 'ReadBalances',
  'ReadStatementsBasic', 'ReadStatementsDetail',
  'ReadTransactionsBasic', 'ReadTransactionsDetail',
  'ReadTransactionsCredits', 'ReadTransactionsDebits'
]

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

const maskToken = t => maskTokenPure(t, cfg.full)
const maskNumber = n => maskNumberPure(n, cfg.full)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const nowSec = () => Math.floor(Date.now() / 1000)

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
        // Honour NODE_EXTRA_CA_CERTS — never disable verification; a cert error
        // is a real finding. Sandbox is plain TLS; prod (:9345) is BY-crypto via
        // the СКЗИ gateway, out of this script's scope (issue #41).
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

function basicAuth(id, secret) {
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')
}

// POST to the token endpoint with client_secret_basic (sandbox auth method).
async function postToken(form, { id, secret }) {
  const body = new URLSearchParams(form).toString()
  return httpRequest(`${cfg.base}${AUTH}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': basicAuth(id, secret),
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    },
    body
  })
}

async function obRequest(path, { method = 'GET', accessToken, json } = {}) {
  const body = json ? JSON.stringify(json) : undefined
  return httpRequest(`${cfg.base}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      'x-fapi-interaction-id': randomUUID(),
      'x-idempotency-key': randomUUID()
    },
    body
  })
}

// --- JWT (RS256) -----------------------------------------------------------
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function loadPrivateKey() {
  if (!cfg.privateKeyPath) return null
  try {
    return readFileSync(cfg.privateKeyPath, 'utf8')
  } catch (e) {
    die(`cannot read PRIOR_PRIVATE_KEY at "${cfg.privateKeyPath}": ${e.message}`)
  }
}

function signJwt(payload, privateKeyPem) {
  const header = { alg: 'RS256', typ: 'JWT', kid: cfg.kid }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem)
  return `${signingInput}.${b64url(signature)}`
}

// Public JWK (n,e) from the private key, for the DCR `jwks` and --gen-key.
function publicJwk(privateKeyPem) {
  const jwk = createPublicKey(privateKeyPem).export({ format: 'jwk' })
  return { ...jwk, kid: cfg.kid, use: 'sig', alg: 'RS256' }
}

// --- browser ---------------------------------------------------------------
function openBrowser(url) {
  if (!isHttpUrl(url)) {
    warn('not opening the browser: authorize URL is not a plain http(s) URL — open it manually')
    return
  }
  const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open'
  const cmdArgs = platform === 'win32' ? ['/c', 'start', '""', `"${url}"`] : [url]
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true, windowsVerbatimArguments: platform === 'win32' })
    child.on('error', () => {})
    child.unref()
  } catch { /* best-effort */ }
}

// --- steps -----------------------------------------------------------------
// Token A / Б — client_credentials with the given scope.
async function clientCredentials(scope, { id, secret, label }) {
  const r = await postToken({ grant_type: 'client_credentials', scope }, { id, secret })
  if (r.status >= 200 && r.status < 300 && r.json && r.json.access_token) {
    ok(`${label}: HTTP ${r.status}, token ${maskToken(r.json.access_token)}, scope "${r.json.scope}", expires ${r.json.expires_in}s`)
    return r.json.access_token
  }
  err(`${label} failed (HTTP ${r.status})`)
  log(r.json ? JSON.stringify(r.json, null, 2) : trunc(r.text, 400))
  return null
}

async function oidcDiscovery(tokenA) {
  head('OIDC discovery — /oidcdiscovery (token A)')
  const res = await httpRequest(`${cfg.base}${DCR}/oidcdiscovery`, {
    headers: { Authorization: `Bearer ${tokenA}`, Accept: 'application/json' }
  })
  log(`${C.dim}HTTP ${res.status}${C.reset}`)
  if (res.json) log(JSON.stringify(res.json, null, 2))
  else log(trunc(res.text, 600))
  // JWT `aud` for the authorize `request` = the issuer (per the bank's examples
  // this is https://api.priorbank.by:9544/oauth2/token, note the :9544 auth
  // server, distinct from the :9344 API-gateway token_endpoint). Fall back to
  // token_endpoint, then the gateway default.
  const aud = res.json && (res.json.issuer || res.json.token_endpoint)
  return aud || `${cfg.base}${AUTH}/oauth2/token`
}

async function dcrRegister(tokenA, jwks) {
  head('DCR — POST /register (create business app, token A)')
  const body = {
    client_name: args['app-name'] ? String(args['app-name']) : 'OB-client-bank-alfa-by',
    redirect_uris: [cfg.redirectUri],
    grant_types: ['client_credentials', 'authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
    scope: 'accounts openid',
    ...(jwks ? { jwks } : {})
  }
  if (args['verbose']) {
    log(`${C.dim}→ POST ${cfg.base}${DCR}/register${C.reset}`)
    log(JSON.stringify(body, null, 2))
  }
  const res = await httpRequest(`${cfg.base}${DCR}/register`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tokenA}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(JSON.stringify(body))
    },
    body: JSON.stringify(body)
  })
  log(`${C.dim}HTTP ${res.status}${C.reset}`)
  if (args['verbose']) {
    log(`${C.dim}← headers:${C.reset} ${JSON.stringify(res.headers)}`)
    log(`${C.dim}← body:${C.reset} ${res.text}`)
  }
  if (res.status >= 200 && res.status < 300 && res.json) {
    ok('business app registered')
    log(`  client_id:     ${res.json.client_id}`)
    log(`  client_secret: ${maskToken(res.json.client_secret)}`)
    warn('save these into PRIOR_CLIENT_ID / PRIOR_CLIENT_SECRET (business app)')
    return res.json
  }
  err(`register failed (HTTP ${res.status})`)
  log(res.json ? JSON.stringify(res.json, null, 2) : trunc(res.text, 600))
  return null
}

async function createConsent(tokenB) {
  head('Consent — POST /accountConsents (token Б)')
  const data = {
    permissions: CONSENT_PERMISSIONS,
    ...(cfg.to ? { expirationDate: cfg.to } : {}),
    ...(cfg.from ? { transactionFromDate: cfg.from } : {}),
    ...(cfg.to ? { transactionToDate: cfg.to } : {})
  }
  const res = await obRequest(`${OB}/accountConsents`, { method: 'POST', accessToken: tokenB, json: { data } })
  log(`${C.dim}HTTP ${res.status}${C.reset}`)
  // The intent id lives under data.consentId / data.accountConsentId /
  // openbanking_intent_id depending on the revision — accept any.
  const d = res.json && res.json.data ? res.json.data : res.json
  const intentId = d && (d.consentId || d.accountConsentId || d.openbanking_intent_id || d.ConsentId)
  if (res.status >= 200 && res.status < 300 && intentId) {
    ok(`consent created — intent ${intentId}`)
    return String(intentId)
  }
  err(`consent failed (HTTP ${res.status})`)
  log(res.json ? JSON.stringify(res.json, null, 2) : trunc(res.text, 600))
  return null
}

function buildAuthorizeUrl(intentId, aud, privateKeyPem) {
  const nonce = `n-${randomUUID()}`
  const claim = { value: intentId, essential: true }
  const requestJwt = signJwt({
    client_id: cfg.clientId,
    sub: cfg.clientId,
    response_type: 'code',
    nonce,
    redirect_uri: cfg.redirectUri,
    scope: 'openid accounts',
    aud: [aud],
    claims: {
      userinfo: { openbanking_intent_id: claim },
      id_token: { openbanking_intent_id: claim }
    },
    iss: cfg.clientId,
    exp: nowSec() + 600,
    iat: nowSec(),
    jti: `${randomUUID()}`
  }, privateKeyPem)
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: 'openid accounts',
    prompt: 'login',
    state: cfg.state,
    request: requestJwt
  })
  return `${cfg.base}${AUTH}/oauth2/authorize?${q.toString()}`
}

async function exchangeCode(code) {
  head('Exchange authorization_code → token B')
  const r = await postToken(
    { grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri },
    { id: cfg.clientId, secret: cfg.clientSecret }
  )
  log(`${C.dim}HTTP ${r.status}${C.reset}`)
  if (r.status >= 200 && r.status < 300 && r.json && r.json.access_token) {
    log(`  access_token:  ${maskToken(r.json.access_token)}`)
    log(`  refresh_token: ${maskToken(r.json.refresh_token)}`)
    log(`  expires_in: ${r.json.expires_in}s   scope: ${r.json.scope}`)
    ok('token B obtained')
    return r.json
  }
  err(`code exchange failed (HTTP ${r.status})`)
  log(r.json ? JSON.stringify(r.json, null, 2) : trunc(r.text, 600))
  return null
}

async function listAccounts(tokenB) {
  head('Accounts — GET /accounts (token B)')
  // TO CONFIRM: exact path/shape from the Account API / Postman collection.
  const res = await obRequest(`${OB}/accounts`, { accessToken: tokenB })
  log(`${C.dim}HTTP ${res.status}  ${cfg.base}${OB}/accounts${C.reset}`)
  if (res.status < 200 || res.status >= 300) {
    err(`accounts request failed (HTTP ${res.status})`)
    log(res.json ? JSON.stringify(res.json, null, 2) : trunc(res.text, 600))
    return { raw: res.json ?? res.text, accounts: [] }
  }
  const d = res.json && res.json.data ? res.json.data : res.json
  const accounts = (d && (d.account || d.accounts)) || (Array.isArray(d) ? d : [])
  ok(`${accounts.length} account(s)`)
  for (const a of accounts) {
    log(`  • id ${a.accountId ?? a.AccountId ?? '?'}  ${maskNumber(a.iban ?? a.identification ?? a.number)}  ${a.currency ?? a.currIso ?? ''}`)
  }
  return { raw: res.json, accounts }
}

async function fetchStatement(tokenB, accountId) {
  log(`\n${C.bold}account ${accountId}${C.reset}`)
  // Create the statement (async). TO CONFIRM: request body from the Account API;
  // sending a date window if provided.
  const createBody = (cfg.from || cfg.to)
    ? { data: { fromDateTime: cfg.from || undefined, toDateTime: cfg.to || undefined } }
    : undefined
  const created = await obRequest(`${OB}/accounts/${accountId}/statements`, {
    method: 'POST', accessToken: tokenB, json: createBody
  })
  log(`  ${C.dim}create: HTTP ${created.status}${C.reset}`)
  const cd = created.json && created.json.data ? created.json.data : created.json
  const statementId = cd && (cd.statementId || cd.StatementId || cd.id)
  if (!statementId) {
    err('  no statementId returned')
    log('  ' + (created.json ? trunc(JSON.stringify(created.json), 400) : trunc(created.text, 400)))
    return { accountId, error: created.json ?? created.text }
  }
  // Poll until ready (NotCreated error clears when the statement is built).
  for (let i = 1; i <= cfg.poll; i++) {
    await sleep(cfg.delayMs)
    const got = await obRequest(`${OB}/accounts/${accountId}/statements/${statementId}`, { accessToken: tokenB })
    const notReady = got.json && JSON.stringify(got.json).includes('NotCreated')
    if (got.status >= 200 && got.status < 300 && !notReady) {
      ok(`  statement ready (poll ${i}/${cfg.poll})`)
      return { accountId, statementId, statement: got.json ?? got.text }
    }
    log(`  ${C.dim}poll ${i}/${cfg.poll}: HTTP ${got.status}${notReady ? ' (not ready yet)' : ''}${C.reset}`)
  }
  warn(`  statement not ready after ${cfg.poll} polls — re-run GET later`)
  return { accountId, statementId, pending: true }
}

async function revoke(token) {
  head('Revoke token — POST /oauth2/revoke')
  const body = new URLSearchParams({ token }).toString()
  const res = await httpRequest(`${cfg.base}${AUTH}/oauth2/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': basicAuth(cfg.clientId, cfg.clientSecret),
      'Content-Length': Buffer.byteLength(body)
    },
    body
  })
  log(`${C.dim}HTTP ${res.status}${C.reset}`)
  res.status >= 200 && res.status < 300 ? ok('revoked') : err(`revoke failed (HTTP ${res.status})`)
}

function saveOutput(data) {
  const file = 'prior-demo-output.json'
  try {
    writeFileSync(file, JSON.stringify(data, null, 2))
    ok(`data written to ${file} (gitignored)${cfg.full ? ' — with live tokens (--full)' : ' — tokens redacted'}`)
  } catch (e) {
    warn(`could not write ${file}: ${e.message}`)
  }
}

// --- main ------------------------------------------------------------------
async function main() {
  const isSandbox = /api\.priorbank\.by:9344/.test(cfg.base)
  log(`${C.bold}Priorbank BY — Open Banking (СПР) sandbox demo${C.reset}`)
  log(`${C.dim}env file:${C.reset} ${envFile ?? '(none — process env / flags)'}   `
    + `${isSandbox ? `${C.yellow}● SANDBOX${C.reset}` : `${C.red}● NON-SANDBOX${C.reset} (${cfg.base})`}`)
  if (!isSandbox) warn('base is not the sandbox host — prod needs BY-crypto TLS via the СКЗИ gateway (issue #41)')

  // --gen-key: RSA keypair + jwks for DCR registration. No network.
  if (args['gen-key']) {
    head('Generate RSA keypair + jwks (for DCR registration)')
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    writeFileSync('prior_private_key.pem', pem)
    ok('wrote prior_private_key.pem (gitignored) — set PRIOR_PRIVATE_KEY to it')
    const jwks = { keys: [publicJwk(pem)] }
    writeFileSync('prior_jwks.json', JSON.stringify(jwks, null, 2))
    ok(`wrote prior_jwks.json — paste as the "jwks" param when registering (kid=${cfg.kid})`)
    log(JSON.stringify(jwks, null, 2))
    return
  }

  // --dcr: token A (tech app) → optional oidc → register business app.
  if (args['dcr']) {
    if (!cfg.techId || !cfg.techSecret) die('--dcr needs PRIOR_TECH_CLIENT_ID / PRIOR_TECH_CLIENT_SECRET (tech app)')
    head('Token A — client_credentials (apim:subscribe apim:app_manage)')
    const tokenA = await clientCredentials('apim:subscribe apim:app_manage', { id: cfg.techId, secret: cfg.techSecret, label: 'token A' })
    if (!tokenA) process.exit(1)
    if (args['oidc']) await oidcDiscovery(tokenA)
    const pem = loadPrivateKey()
    const jwks = pem ? { keys: [publicJwk(pem)] } : null
    if (!jwks) warn('no PRIOR_PRIVATE_KEY — registering without jwks (authorization_code/private_key_jwt will need it)')
    await dcrRegister(tokenA, jwks)
    return
  }

  // --oidc only (token A → discovery).
  if (args['oidc'] && !args['dcr']) {
    if (!cfg.techId || !cfg.techSecret) die('--oidc needs the tech app creds (PRIOR_TECH_CLIENT_ID/SECRET)')
    const tokenA = await clientCredentials('apim:subscribe apim:app_manage', { id: cfg.techId, secret: cfg.techSecret, label: 'token A' })
    if (tokenA) await oidcDiscovery(tokenA)
    return
  }

  if (args['revoke']) {
    if (!cfg.clientId) die('--revoke needs the business app creds')
    await revoke(String(args['revoke']))
    return
  }

  // Default flow (business app): consent → authorize → code → statement.
  if (!cfg.clientId || !cfg.clientSecret) die('business app creds required (PRIOR_CLIENT_ID / PRIOR_CLIENT_SECRET) — run --dcr first')
  const pem = loadPrivateKey()
  if (!pem) die('PRIOR_PRIVATE_KEY is required to sign the authorize `request` JWT — run --gen-key first')

  // `--url-only` with a known `--consent` builds the authorize URL fully offline
  // (no token Б / consent / oidc calls) — handy to inspect the signed request JWT.
  const offlineUrl = args['url-only'] && args['consent']

  let intentId = args['consent'] ? String(args['consent']) : null
  if (!intentId) {
    head('Token Б — client_credentials (scope=accounts)')
    const tokenB0 = await clientCredentials('accounts', { id: cfg.clientId, secret: cfg.clientSecret, label: 'token Б' })
    if (!tokenB0) process.exit(1)
    intentId = await createConsent(tokenB0)
    if (!intentId) process.exit(1)
  }

  // aud for the request JWT — the token endpoint (fetch via oidc if tech creds
  // are present, else default to the known sandbox token endpoint).
  let aud = `${cfg.base}${AUTH}/oauth2/token`
  if (!offlineUrl && cfg.techId && cfg.techSecret) {
    const tokenA = await clientCredentials('apim:subscribe apim:app_manage', { id: cfg.techId, secret: cfg.techSecret, label: 'token A (for aud)' })
    if (tokenA) aud = await oidcDiscovery(tokenA)
  }

  head('Authorize — open, log in (sandbox user testspr_le / testspr_pi), approve')
  const url = buildAuthorizeUrl(intentId, aud, pem)
  log(url)
  if (args['url-only']) return
  openBrowser(url)
  const rl = createInterface({ input, output })
  const pasted = await rl.question(`\n${C.bold}Paste the redirected URL (or just the code):${C.reset} `)
  rl.close()
  const parsed = extractRedirect(pasted)
  if (parsed.state && parsed.state !== cfg.state) warn(`state mismatch (sent "${cfg.state}", got "${parsed.state}")`)
  const code = args['code'] ? String(args['code']) : parsed.code
  if (!code) die('no authorization code provided')

  const tokens = await exchangeCode(code)
  if (!tokens) process.exit(1)

  const ids = cfg.accountId
    ? [cfg.accountId]
    : (await listAccounts(tokens.access_token)).accounts
        .map(a => a.accountId || a.AccountId).filter(Boolean)
  head('Statements (async create + poll)')
  const statements = []
  for (const id of ids) statements.push(await fetchStatement(tokens.access_token, id))

  head('Save')
  saveOutput({
    generatedAt: new Date().toISOString(),
    base: cfg.base,
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    intentId,
    tokenExchange: cfg.full ? tokens : redactTokenSet(tokens),
    statements
  })
  head('Done')
  ok('consent → authorize → code → statement completed.')
}

main().catch(e => die(e.stack || e.message))
