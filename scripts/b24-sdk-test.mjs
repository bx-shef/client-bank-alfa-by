// Dev smoke-test for the @bitrix24/b24jssdk transport (#191). Verifies on a LIVE
// portal that the SDK works server-side in Node and that its RestrictionManager (the
// built-in rate limiter) self-throttles — the gating unknown before we swap the
// crm-sync REST transport from the hand-rolled `callRest` to the SDK.
//
// Uses a webhook (B24Hook — simplest, no OAuth dance) read from the git-ignored
// `.env.b24test` (`B24_TEST_WEBHOOK=https://<portal>/rest/<user>/<token>/`). NEVER
// commit a real token. This is a dev tool, not part of the SSG build.
//
// Run:  pnpm sdk:test           (a few calls + limiter stats)
//       pnpm sdk:test --burst   (fire 60 quick calls to watch the limiter throttle)

import { loadDotEnv } from './lib/env.mjs'
import { C, die, head, log, ok, warn } from './lib/cli.mjs'

loadDotEnv(['.env.b24test'], { explicit: false })

const WEBHOOK = (process.env.B24_TEST_WEBHOOK ?? '').trim()
if (!WEBHOOK || !/^https:\/\/[^/]+\/rest\/\d+\/[^/]+\/?$/.test(WEBHOOK)) {
  die('B24_TEST_WEBHOOK is missing or malformed. Put it in .env.b24test as\n'
    + '  B24_TEST_WEBHOOK=https://<portal>.bitrix24.ru/rest/<user>/<token>/')
}

const burst = process.argv.includes('--burst')

// Import the real SDK only here (dev tool) — the app-side adapter (server/utils/b24Sdk.ts)
// stays SDK-free via injection.
const { B24Hook, ParamsFactory, ApiVersion } = await import('@bitrix24/b24jssdk')

head('b24jssdk transport smoke-test')
log(`webhook: ${C.dim}${WEBHOOK.replace(/\/rest\/\d+\/[^/]+/, '/rest/***/***')}${C.reset}`)

const b24 = B24Hook.fromWebhookUrl(WEBHOOK)
// The RestrictionManager is on by default; set explicit defaults so the run is reproducible.
await b24.setRestrictionManagerParams(ParamsFactory.getDefault())

/** Adapter mirror of server/utils/b24Sdk.ts `makeSdkRestCall` — same unwrap/throw. */
async function call(method, params = {}) {
  const res = await b24.actions.v2.call.make({ method, params })
  if (!res.isSuccess) throw new Error(res.getErrorMessages().join('; ') || `${method} failed`)
  return res.getData() ?? {}
}

try {
  head('1) single call — crm.item.list (smart invoices, entityTypeId 31)')
  const inv = await call('crm.item.list', { entityTypeId: 31, start: 0 })
  const items = inv?.result?.items ?? []
  ok(`got ${items.length} invoice(s); envelope has .result → matches our RestCall shape`)

  head('2) batch — two lists in one request')
  const batch = await b24.actions.v2.batch.make({
    calls: [
      { method: 'crm.item.list', params: { entityTypeId: 2, start: 0 } }, // deals
      { method: 'user.current', params: {} }
    ]
  })
  ok(`batch success: ${batch.isSuccess}`)

  if (burst) {
    head('3) burst — 60 quick calls (watch the limiter throttle, no QUERY_LIMIT_EXCEEDED)')
    const t0 = Date.now()
    await Promise.all(Array.from({ length: 60 }, () => call('user.current')))
    ok(`60 calls in ${((Date.now() - t0) / 1000).toFixed(1)}s (default drain 2 req/s ⇒ throttled, not rejected)`)
  }

  const stats = b24.getHttpClient(ApiVersion.v2).getStats?.()
  if (stats) log(`limiter stats: ${C.dim}${JSON.stringify(stats)}${C.reset}`)
  head('done')
  ok('SDK works server-side and self-throttles — safe to wire as the crm-sync transport (#191).')
} catch (e) {
  warn(`call failed: ${e?.message ?? e}`)
  die('If this is a rate/timeout error the limiter needs tuning; if auth — check the webhook scope (crm).')
}
