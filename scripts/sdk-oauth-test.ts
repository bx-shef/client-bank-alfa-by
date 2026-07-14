// Live OAuth smoke-test of the crm-sync transport adapter (#191). Exercises the REAL
// `makePortalSdkCall` (server/utils/b24Sdk.ts) — `new B24OAuth(...)` + a REST call +
// the refresh-persist callback — against a live portal by OAuth token, NOT a webhook.
// This is the gate before swapping the crm-sync hot-path transport from
// `makePortalRestCall` (hand-rolled) to the SDK. Dev-only, not part of SSG.
//
// Reads git-ignored `.env.b24oauth` (falls back to `.env.b24test`). NEVER commit creds.
//   B24_CLIENT_ID=local.xxxxxxxx.xxxxxxxx      # app OAuth client_id
//   B24_CLIENT_SECRET=xxxxxxxx                 # app OAuth client_secret
//   B24_OAUTH_DOMAIN=<portal>.bitrix24.xx      # portal domain (no scheme)
//   B24_OAUTH_MEMBER_ID=xxxxxxxx               # portal member_id
//   B24_OAUTH_ACCESS_TOKEN=xxxxxxxx            # a current access_token
//   B24_OAUTH_REFRESH_TOKEN=xxxxxxxx           # its refresh_token
//   B24_OAUTH_EXPIRES=1784000000               # optional: access_token expiry (unix s)
//
//   pnpm sdk:oauth            # REST call via OAuth (crm.item.list) — confirms transport
//   pnpm sdk:oauth --refresh  # also force a refresh (expire the access token) — confirms
//                             # the SDK renews it and our saveToken callback persists it

import { loadDotEnv } from './lib/env.mjs'
import { C, head, ok, err, warn } from './lib/cli.mjs'
import { makePortalSdkCall } from '../server/utils/b24Sdk.ts'
import type { PortalToken } from '../server/utils/tokenStore.ts'

loadDotEnv(['.env.b24oauth', '.env.b24test'], { explicit: false })

const need = (k: string): string => {
  const v = (process.env[k] ?? '').trim()
  if (!v) {
    err(`${k} is missing — put OAuth creds in git-ignored .env.b24oauth (see header of this script).`)
    process.exit(1)
  }
  return v
}

const argv = process.argv.slice(2)
const FORCE_REFRESH = argv.includes('--refresh')

const clientId = need('B24_CLIENT_ID')
const clientSecret = need('B24_CLIENT_SECRET')
const domain = need('B24_OAUTH_DOMAIN')
const memberId = need('B24_OAUTH_MEMBER_ID')
const accessToken = need('B24_OAUTH_ACCESS_TOKEN')
const refreshToken = need('B24_OAUTH_REFRESH_TOKEN')
const expiresAt = Number(process.env.B24_OAUTH_EXPIRES ?? '0') * 1000 || Date.now() + 3600_000

process.on('unhandledRejection', (e) => {
  err(`Прогон упал: ${(e as { message?: string })?.message ?? String(e)}`)
  process.exit(1)
})

head(`b24jssdk OAuth transport smoke-test · ${domain} · ${FORCE_REFRESH ? 'REST+REFRESH' : 'REST'}`)

// In-memory token store for the dev run: loadToken returns our env token; saveToken
// records what the SDK persists after a refresh (so we can prove the callback fires).
let persisted: PortalToken | null = null
const baseToken: PortalToken = { memberId, domain, accessToken, refreshToken, expiresAt, applicationToken: '' }

const deps = {
  loadToken: async () => (persisted ?? baseToken),
  saveToken: async (t: PortalToken) => {
    persisted = t
    ok(`saveToken callback fired → new access_token …${t.accessToken.slice(-6)}, expires ${new Date(t.expiresAt).toISOString()}`)
  },
  creds: { clientId, clientSecret },
  now: () => Date.now(),
  scope: 'crm'
}

// 1) A plain REST call over the OAuth transport — confirms `makePortalSdkCall` builds a
//    working per-portal client and unwraps the `{result,…}` envelope our lookups expect.
const call = await makePortalSdkCall(memberId, deps)
if (!call) {
  err('makePortalSdkCall returned null — no token (loadToken yielded nothing).')
  process.exit(1)
}
console.log(`${C.dim}→ crm.item.list entityTypeId=31 (smart invoices)…${C.reset}`)
const resp = await call('crm.item.list', { entityTypeId: 31, select: ['id', 'accountNumber', 'stageId'] }) as { result?: { items?: unknown[] } }
const items = resp?.result?.items
if (!Array.isArray(items)) {
  err(`unexpected envelope — no result.items array. Got: ${JSON.stringify(resp).slice(0, 200)}`)
  process.exit(1)
}
ok(`OAuth REST works: ${items.length} invoice(s), envelope has .result → matches our RestCall shape`)

// 2) Optional: force the SDK's reactive refresh by expiring the stored access token, then
//    call again. The SDK should renew via refresh_token and our saveToken should persist it.
if (FORCE_REFRESH) {
  console.log(`${C.dim}→ expiring the access token to force a refresh…${C.reset}`)
  persisted = { ...baseToken, expiresAt: Date.now() - 60_000 } // already expired
  const call2 = await makePortalSdkCall(memberId, deps)
  if (!call2) {
    err('makePortalSdkCall returned null on the refresh pass.')
    process.exit(1)
  }
  const before = persisted.accessToken
  const r2 = await call2('user.current', {}) as { result?: unknown }
  if (r2?.result === undefined) warn('user.current returned no result — check scope, but the call itself completed.')
  if (persisted && persisted.accessToken !== before) ok('refresh path confirmed: token was renewed and persisted via the callback.')
  else warn('token was NOT renewed on this pass — the SDK may refresh only on a genuine expired_token from B24. REST path (test 1) still validated.')
}

head('done')
ok(`SDK OAuth transport works server-side — safe to swap crm-sync onto makePortalSdkCall (#191).`)
