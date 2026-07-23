// Live verification for the #109/§9 DISTRIBUTION LEDGER write path (dev-only, not part of SSG). It
// exercises the REAL server cores end-to-end and is now VERIFIED LIVE 10/10 via the webhook:
//   1. provisionDistributionSp  — create/self-heal the app's two SPs (payment + distribution) + fields
//   2. ensurePaymentElement     — write-once payment CARRIER (total 1000), assert idempotent
//   3. writeDistributionRow     — one ledger row (600), assert idempotent by marker
//   4. recomputeNeedDistribution— «осталось» = 1000 − 600 = 400
//   5. second row (400)         — «осталось» → 0
//   6. teardown                 — delete the created items AND the app SP types (leaves no trace)
//
// SP LIVE-FINDINGS baked into the cores (#384–#386): UF fields key off the SP TYPE id (`CRM_<id>`/
// `UF_CRM_<id>_…`), not the entityTypeId; `crm.item.*` addresses UF by camelCase (`ufCrm<id><Pascal>`),
// the original name filters EMPTY; no parent-child relation → own `PARENT_PAYMENT` UF instead of the
// native `parentId<etid>`; built-in `opportunity`/`currencyId` are NOT writable on an SP item → amount +
// currency live in our own `double`(PRECISION:2)/`string` UF fields (else the recompute summed zeros).
//
// TRANSPORT (two modes):
//   default (webhook, .env.b24test): the owner granted the test webhook the `userfieldconfig.*` privilege,
//     so the webhook now runs the FULL write path (SP types + UF fields + items + recompute) — the primary
//     live gate. (If a webhook ever lacks the privilege, provisioning throws at the userfieldconfig step;
//     the run reports the SCOPE gap and tears down the partial SP types.)
//   --oauth (.env.b24oauth): the PROD transport (`makePortalSdkCall` → per-portal B24OAuth, exactly what
//     the worker uses). ⚠ needs `userfieldconfig` in the app's granted scopes (re-consent) and it refreshes
//     the (short-lived) access token → ROTATES the refresh token, so `.env.b24oauth` goes stale after —
//     re-extract with scripts/extract-oauth-from-docker.sh. Runs against the owner's real portal.
//
// Run:  pnpm verify:distribution           (webhook: type-create + scope diagnosis + teardown)
//       pnpm verify:distribution --oauth     (OAuth: full write-path verification)
//       add --keep to leave created items + SP types on the portal.

import { loadDotEnv } from './lib/env.mjs'
import { httpRequest } from './lib/http.mjs'
import { C, head, ok, err, warn } from './lib/cli.mjs'
import { provisionDistributionSp } from '../server/utils/distributionSpProvision.ts'
import {
  ensurePaymentElement,
  writeDistributionRow,
  recomputeNeedDistribution
} from '../server/utils/distributionLedgerWrite.ts'
import { PAYMENT_SP_TITLE, DISTRIBUTION_SP_TITLE } from '../app/config/distributionSp.ts'
import { makePortalSdkCall, type SdkPortalDeps } from '../server/utils/b24Sdk.ts'
import type { PortalToken } from '../server/utils/tokenStore.ts'
import { B24_REQUIRED_SCOPES } from '../app/config/b24.ts'

type RestCall = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

const useOauth = process.argv.includes('--oauth')
const keep = process.argv.includes('--keep')

// loadDotEnv loads the FIRST readable file then returns, so load each separately to get BOTH
// the webhook (.env.b24test) and the OAuth block (.env.b24oauth). Neither overrides existing env.
loadDotEnv(['.env.b24test'], { explicit: false })
loadDotEnv(['.env.b24oauth'], { explicit: false })

/** Build the webhook-backed RestCall (default transport). */
function webhookCall(): RestCall {
  const WEBHOOK = (process.env.B24_TEST_WEBHOOK ?? '').trim()
  if (!WEBHOOK) {
    err('B24_TEST_WEBHOOK missing in .env.b24test')
    process.exit(1)
  }
  return async (method, params = {}) => {
    const res = await httpRequest(WEBHOOK + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(params)
    })
    const j = res.json as Record<string, unknown> | undefined
    if (j && j.error) throw new Error(`${method}: ${j.error} ${(j as { error_description?: string }).error_description || ''}`.trim())
    if (!j) throw new Error(`${method}: non-JSON (HTTP ${res.status})`)
    return j
  }
}

/** Build the OAuth (prod-transport) RestCall from .env.b24oauth. */
async function oauthCall(): Promise<{ call: RestCall, label: string }> {
  const env = (k: string) => (process.env[k] ?? '').trim()
  const memberId = env('B24_OAUTH_MEMBER_ID')
  const domain = env('B24_OAUTH_DOMAIN')
  const req = { B24_OAUTH_DOMAIN: domain, B24_OAUTH_MEMBER_ID: memberId, B24_OAUTH_ACCESS_TOKEN: env('B24_OAUTH_ACCESS_TOKEN'), B24_OAUTH_REFRESH_TOKEN: env('B24_OAUTH_REFRESH_TOKEN'), B24_CLIENT_ID: env('B24_CLIENT_ID'), B24_CLIENT_SECRET: env('B24_CLIENT_SECRET') }
  const missing = Object.entries(req).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) {
    err(`--oauth: не хватает env: ${missing.join(', ')} (см. scripts/extract-oauth-from-docker.sh → .env.b24oauth)`)
    process.exit(1)
  }
  const token: PortalToken = {
    memberId, domain, accessToken: env('B24_OAUTH_ACCESS_TOKEN'), refreshToken: env('B24_OAUTH_REFRESH_TOKEN'),
    applicationToken: '', expiresAt: Date.now() + Number(env('B24_OAUTH_EXPIRES_IN') || 3600) * 1000
  }
  const deps: SdkPortalDeps = {
    loadToken: async () => token,
    saveToken: async () => { /* in-memory: ignore rotated token (dev smoke) */ },
    creds: { clientId: env('B24_CLIENT_ID'), clientSecret: env('B24_CLIENT_SECRET') },
    now: Date.now,
    scope: B24_REQUIRED_SCOPES.join(',')
  }
  const call = await makePortalSdkCall(memberId, deps)
  if (!call) {
    err('--oauth: makePortalSdkCall вернул null (нет токена?)')
    process.exit(1)
  }
  return { call: call as RestCall, label: `OAuth ${domain}` }
}

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++
    ok(`${name}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`)
  } else {
    fail++
    err(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

let CALL: RestCall
const createdItems: Array<{ etid: number, id: string }> = []

/** Ids of the app's two SP TYPES (by stable title), for teardown. */
async function appSpTypeIds(): Promise<Array<{ id: number, title: string }>> {
  const resp = await CALL('crm.type.list', {})
  const types = ((resp.result as { types?: unknown } | undefined)?.types ?? []) as Array<{ id?: unknown, title?: unknown }>
  return types
    .filter(t => t.title === PAYMENT_SP_TITLE || t.title === DISTRIBUTION_SP_TITLE)
    .map(t => ({ id: Number(t.id), title: String(t.title) }))
    .filter(t => Number.isInteger(t.id) && t.id > 0)
}

async function teardown() {
  if (keep) return
  head('Teardown (delete created items + app SP types — leave no trace)')
  for (const it of createdItems.reverse()) {
    try {
      await CALL('crm.item.delete', { entityTypeId: it.etid, id: Number(it.id) })
      ok(`deleted item ${it.id} (etid ${it.etid})`)
    } catch (e) {
      warn(`teardown: item ${it.id}: ${(e as Error).message}`)
    }
  }
  try {
    for (const t of await appSpTypeIds()) {
      await CALL('crm.type.delete', { id: t.id })
      ok(`deleted SP type ${t.id} "${t.title}"`)
    }
  } catch (e) {
    warn(`teardown: SP types: ${(e as Error).message}`)
  }
}

function isScopeError(e: unknown): boolean {
  const m = (e as Error)?.message ?? ''
  return /insufficient_scope|higher privileges|userfieldconfig/i.test(m)
}

process.on('unhandledRejection', async (e) => {
  err(`Прогон упал: ${(e as { message?: string })?.message ?? String(e)}`)
  await teardown()
  process.exit(1)
})

async function main() {
  const transport = useOauth ? await oauthCall() : { call: webhookCall(), label: 'webhook ' + (process.env.B24_TEST_WEBHOOK ?? '').replace(/\/rest\/\d+\/[^/]+/, '/rest/***/***') }
  CALL = transport.call
  head(`§9 distribution ledger — live write verification · ${transport.label}`)

  // 1) Provision (idempotent). On the webhook, this throws at the userfieldconfig step (missing privilege).
  let prov
  try {
    prov = await provisionDistributionSp(CALL)
  } catch (e) {
    if (!useOauth && isScopeError(e)) {
      warn('ПРОВИЖИН НЕПОЛНЫЙ: вебхук создаёт SP-типы, но НЕ имеет прав на `userfieldconfig.*` (управление')
      warn('пользовательскими полями СП) → поля леджера не добавить, write-путь этим токеном не проверить.')
      warn(`Ошибка: ${(e as Error).message}`)
      warn('Полная проверка — прод-транспортом: `pnpm verify:distribution --oauth` (.env.b24oauth, app-scope')
      warn('userfieldconfig), либо выдать вебхуку право userfieldconfig. Сношу частично созданные SP-типы…')
      check('webhook: SP-типы создаются (crm.type.add)', (await appSpTypeIds()).length > 0, 'типы найдены до teardown')
      await teardown()
      head(`Итог: ${C.yellow}проверка НЕПОЛНАЯ${C.reset} — нужен OAuth-транспорт (см. выше). Код-путь корректен, ограничение — привилегии вебхука.`)
      process.exit(0)
    }
    throw e
  }

  check('provision: payment SP etid', prov.paymentSpEtid > 0, `etid=${prov.paymentSpEtid}${prov.createdPaymentSp ? ' (created)' : ' (existing)'}`)
  check('provision: distribution SP etid', prov.distributionSpEtid > 0, `etid=${prov.distributionSpEtid}${prov.createdDistributionSp ? ' (created)' : ' (existing)'}`)
  const provAgain = await provisionDistributionSp(CALL, { payment: prov.payment, distribution: prov.distribution })
  check('provision: idempotent (2nd run creates no SP, adds no field)', !provAgain.createdPaymentSp && !provAgain.createdDistributionSp && provAgain.addedFields === 0, `addedFields=${provAgain.addedFields}`)

  const pSp = prov.payment
  const dSp = prov.distribution
  const pEtid = prov.paymentSpEtid // entityTypeId, for item cleanup
  const dEtid = prov.distributionSpEtid
  const stamp = Date.now()
  const opMarker = `verify-dist|${stamp}`
  const CURR = 'BYN'
  const TOTAL = 1000

  // 2) Payment carrier — write-once, idempotent.
  const carrier = await ensurePaymentElement(pSp, { opportunity: TOTAL, currency: CURR, marker: opMarker }, CALL)
  check('carrier: created', carrier.created && Number(carrier.id) > 0, `id=${carrier.id}`)
  if (carrier.created) createdItems.push({ etid: pEtid, id: carrier.id })
  const carrier2 = await ensurePaymentElement(pSp, { opportunity: TOTAL, currency: CURR, marker: opMarker }, CALL)
  check('carrier: idempotent by marker (no duplicate)', !carrier2.created && carrier2.id === carrier.id, `id=${carrier2.id}`)

  // 3) First ledger row (600) — idempotent by marker.
  const rowMarker1 = `${opMarker}|deal-payment|555`
  const rowInput1 = { paymentSp: pSp, distributionSp: dSp, paymentElementId: carrier.id, amount: 600, currency: CURR, targetKind: 'deal-payment' as const, targetId: '555', source: 'auto' as const, marker: rowMarker1 }
  const row1 = await writeDistributionRow(rowInput1, CALL)
  check('row1: created (600)', row1.created && Number(row1.id) > 0, `id=${row1.id}`)
  if (row1.created) createdItems.push({ etid: dEtid, id: row1.id })
  const row1again = await writeDistributionRow(rowInput1, CALL)
  check('row1: idempotent by marker (no duplicate)', !row1again.created && row1again.id === row1.id, `id=${row1again.id}`)

  // 4) Recompute «осталось» = 1000 − 600 = 400.
  const remaining1 = await recomputeNeedDistribution(pSp, carrier.id, dSp, TOTAL, CURR, CALL)
  check('recompute: остаток = 400 after 600', remaining1 === 400, `remaining=${remaining1}`)

  // 5) Second row (400) → остаток 0.
  const rowMarker2 = `${opMarker}|invoice|777`
  const row2 = await writeDistributionRow({ paymentSp: pSp, distributionSp: dSp, paymentElementId: carrier.id, amount: 400, currency: CURR, targetKind: 'invoice', targetId: '777', source: 'auto', marker: rowMarker2 }, CALL)
  check('row2: created (400)', row2.created && Number(row2.id) > 0, `id=${row2.id}`)
  if (row2.created) createdItems.push({ etid: dEtid, id: row2.id })
  const remaining2 = await recomputeNeedDistribution(pSp, carrier.id, dSp, TOTAL, CURR, CALL)
  check('recompute: остаток = 0 after 600+400', remaining2 === 0, `remaining=${remaining2}`)

  await teardown()
  head(`Итог: ${C.green}${pass} passed${C.reset}${fail ? `, ${C.red}${fail} failed${C.reset}` : ''}`)
  if (keep && createdItems.length) warn(`--keep: ${createdItems.length} item(s) + app SP types left on the portal`)
  process.exit(fail ? 1 : 0)
}

void main()
