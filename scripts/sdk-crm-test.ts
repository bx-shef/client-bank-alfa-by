// Live smoke of the crm-sync SDK transport (#191, dev-only, not part of SSG). Exercises the
// EXACT adapter the worker uses when QUEUE_SDK_TRANSPORT=1 — `makePortalSdkCall` → real
// `B24OAuth` → `makeSdkRestCall` (full-envelope contract) + reactive refresh + persist — but
// with an IN-MEMORY token store (no Postgres/Redis), so it runs from a plain env block.
//
// This is the live gate the webhook smoke (`pnpm sdk:test`, B24Hook) can't cover: that uses a
// webhook client; OUR adapter uses per-portal B24OAuth. Get the OAuth creds with
// `scripts/extract-oauth-from-docker.sh` (prints a B24_OAUTH_* block), export them or drop
// them in a git-ignored `.env.b24oauth`, then run this.
//
// Run:  node --experimental-strip-types --disable-warning=ExperimentalWarning \
//         --import ./scripts/lib/alias-loader.mjs scripts/sdk-crm-test.ts [--force-refresh]
// (wired as `pnpm sdk:crm:test`). `--force-refresh` marks the access token already-expired so
// the SDK refreshes on the first call — proves the refresh+persist path (ROTATES the refresh
// token; the DB row goes stale → reinstall/re-extract on the test portal afterwards).

import { loadDotEnv } from './lib/env.mjs'
import { C, head, ok, err } from './lib/cli.mjs'
import { makePortalSdkCall, type SdkPortalDeps } from '../server/utils/b24Sdk.ts'
import type { PortalToken } from '../server/utils/tokenStore.ts'
import { B24_REQUIRED_SCOPES } from '../app/config/b24.ts'

loadDotEnv(['.env.b24oauth', '.env.b24test'], { explicit: false })

const forceRefresh = process.argv.includes('--force-refresh')

const env = (k: string) => (process.env[k] ?? '').trim()
const domain = env('B24_OAUTH_DOMAIN')
const memberId = env('B24_OAUTH_MEMBER_ID')
const accessToken = env('B24_OAUTH_ACCESS_TOKEN')
const refreshToken = env('B24_OAUTH_REFRESH_TOKEN')
const clientId = env('B24_CLIENT_ID')
const clientSecret = env('B24_CLIENT_SECRET')
const expiresIn = Number(env('B24_OAUTH_EXPIRES_IN') || 3600)

const missing = Object.entries({ B24_OAUTH_DOMAIN: domain, B24_OAUTH_MEMBER_ID: memberId, B24_OAUTH_ACCESS_TOKEN: accessToken, B24_OAUTH_REFRESH_TOKEN: refreshToken, B24_CLIENT_ID: clientId, B24_CLIENT_SECRET: clientSecret })
  .filter(([, v]) => !v).map(([k]) => k)
if (missing.length) {
  err(`Не хватает env: ${missing.join(', ')}`)
  err('Получи их через scripts/extract-oauth-from-docker.sh → .env.b24oauth (или export).')
  process.exit(1)
}

// The stored token as the worker would load it. --force-refresh backdates `expiresAt` so
// `oauthParamsFromToken` yields a past absolute `expires`; the SDK checks that BEFORE each
// request and refreshes PROACTIVELY (not only reactively on a 401), firing the persist path.
const nowMs = Date.now()
const token: PortalToken = {
  memberId, domain, accessToken, refreshToken, applicationToken: '',
  expiresAt: forceRefresh ? nowMs - 60_000 : nowMs + expiresIn * 1000
}

let persisted: PortalToken | null = null
const deps: SdkPortalDeps = {
  loadToken: async () => token,
  // In-memory persist (no DB): capture what the SDK's refresh callback hands back.
  saveToken: async (t) => { persisted = t },
  creds: { clientId, clientSecret },
  now: Date.now,
  scope: B24_REQUIRED_SCOPES.join(',')
}

async function main() {
  head(`SDK crm-транспорт (#191) · портал ${domain} · member ${memberId}${forceRefresh ? ' · --force-refresh' : ''}`)
  const call = await makePortalSdkCall(memberId, deps)
  if (!call) {
    err('makePortalSdkCall вернул null (нет токена?)')
    process.exit(1)
  }

  // 1) profile — cheapest authenticated read; proves the OAuth client + envelope contract.
  const profile = await call('profile', {})
  const p = (profile as { result?: Record<string, unknown> }).result
  if (!p || typeof p !== 'object') {
    err(`profile: нет .result в конверте: ${JSON.stringify(profile).slice(0, 200)}`)
    process.exit(1)
  }
  ok(`profile OK — конверт {result,…} корректен (ID=${String((p as { ID?: unknown }).ID ?? '?')}, ${String((p as { NAME?: unknown }).NAME ?? '')} ${String((p as { LAST_NAME?: unknown }).LAST_NAME ?? '')})`)

  // 2) a CRM list read — exercises a real business method through the rate-limited transport.
  try {
    const inv = await call('crm.item.list', { entityTypeId: 31, start: 0 })
    const items = ((inv as { result?: { items?: unknown[] } }).result?.items) ?? []
    ok(`crm.item.list (смарт-счета) OK — ${Array.isArray(items) ? items.length : 0} шт.`)
  } catch (e) {
    // Not fatal for the transport smoke — scope may differ; the transport itself worked if it threw a B24 error.
    err(`crm.item.list: ${(e as Error).message} (не критично для смоука транспорта)`)
  }

  // 3) refresh+persist verdict.
  if (forceRefresh) {
    if (persisted) {
      const rp = persisted as PortalToken
      ok(`РЕФРЕШ+PERSIST сработал — SDK обновил токен, callback сохранил свежий (access ...${rp.accessToken.slice(-6)}, expiresAt=${new Date(rp.expiresAt).toISOString()})`)
      if (rp.refreshToken !== refreshToken) ok('refresh-токен РОТИРОВАН (как ожидается) — БД-строка портала теперь устарела, переустанови/переизвлеки на тесте')
    } else {
      err('--force-refresh: persist-callback не сработал — SDK не рефрешнул (проверь, что access реально истёк / creds верны)')
      process.exit(1)
    }
  } else {
    ok('без --force-refresh: рефреш не форсили (токен свежий). Добавь --force-refresh, чтобы проверить refresh+persist.')
  }

  console.log(`\n${C.green}✓ SDK-транспорт на живом портале работает.${C.reset} Можно включать QUEUE_SDK_TRANSPORT=1 в прогоне crm-sync.\n`)
}

main().catch((e) => {
  err(`FATAL: ${(e as Error).message}`)
  process.exit(1)
})
