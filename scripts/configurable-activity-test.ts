// Live smoke of the #259 Phase-B carrier: crm.activity.configurable.add + the B24-side dedup
// search (crm.activity.list filter[ORIGINATOR_ID][ORIGIN_ID]). Dev-only, not part of SSG.
//
// Exercises the EXACT code crm-sync runs when ACTIVITY_TRANSPORT=configurable:
// `buildConfigurableActivity` → `writeConfigurableActivityViaRest` → `findActivityByMarker`,
// over the real per-portal OAuth transport (`makePortalSdkCall`) with an in-memory token store
// (no Postgres/Redis). configurable.add is OAuth/app-context only, so this is the live gate the
// webhook smokes can't cover. Get OAuth creds with scripts/extract-oauth-from-docker.sh →
// .env.b24oauth (same as sdk:crm:test).
//
// Run:  node --experimental-strip-types --disable-warning=ExperimentalWarning \
//         --import ./scripts/lib/alias-loader.mjs scripts/configurable-activity-test.ts \
//         --company <id> [--apply]
// (wired as `pnpm activity:test`). DRY-RUN by default (prints the params, writes nothing).
// --apply actually creates the activity, then searches the marker to prove the dedup round-trip.

import { loadDotEnv } from './lib/env.mjs'
import { C, head, ok, warn, err } from './lib/cli.mjs'
import { makePortalSdkCall, type SdkPortalDeps } from '../server/utils/b24Sdk.ts'
import type { PortalToken } from '../server/utils/tokenStore.ts'
import { B24_REQUIRED_SCOPES } from '../app/config/b24.ts'
import type { StatementItem } from '../app/types/statement.ts'
import { buildConfigurableActivity, ACTIVITY_ORIGINATOR_ID, activityOriginId } from '../app/utils/configurableActivity.ts'
import { writeConfigurableActivityViaRest } from '../server/utils/configurableActivityWrite.ts'
import { findActivityByMarker } from '../server/utils/activityMarkerLookup.ts'

loadDotEnv(['.env.b24oauth', '.env.b24test'], { explicit: false })

const apply = process.argv.includes('--apply')
const companyArg = process.argv[process.argv.indexOf('--company') + 1]
const companyId = /^\d+$/.test(companyArg ?? '') ? companyArg! : ''

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

// A synthetic statement operation (the marker key = account|docId is fixed, so a re-run finds
// the activity created before — that IS the dedup working).
const item: StatementItem = {
  account: 'BYTEST-CONFIGURABLE',
  docId: 'cfg-smoke-1',
  docNum: '541',
  direction: 'credit',
  amount: 1840,
  currency: 'BYN',
  purpose: 'Оплата по счёту №541 [тест конфигурируемого дела]',
  counterparty: { name: 'ООО «Ромашка»', unp: '191234567', account: 'BY24X', bank: 'Альфа-Банк' },
  acceptDate: '2026-07-16T00:00:00.000Z'
}

const nowMs = Date.now()
const token: PortalToken = {
  memberId, domain, accessToken, refreshToken, applicationToken: '',
  expiresAt: nowMs + expiresIn * 1000
}
const deps: SdkPortalDeps = {
  loadToken: async () => token,
  saveToken: async () => { /* in-memory: nothing to persist for this smoke */ },
  creds: { clientId, clientSecret },
  now: Date.now,
  scope: B24_REQUIRED_SCOPES.join(',')
}

async function main() {
  head(`configurable.add (#259 Phase B) · портал ${domain} · ${apply ? 'APPLY' : 'DRY-RUN'}`)
  const params = buildConfigurableActivity(item, { id: Number(companyId || 0) })
  const originId = activityOriginId(item)
  console.log(`${C.dim}маркер: ORIGINATOR_ID=${ACTIVITY_ORIGINATOR_ID} · ORIGIN_ID=${originId}${C.reset}`)
  console.log(`${C.dim}params:${C.reset} ${JSON.stringify(params, null, 2)}`)

  if (!apply) {
    warn('DRY-RUN — ничего не пишем. Добавь --company <id> --apply, чтобы создать дело и проверить дедуп.')
    return
  }
  if (!companyId) {
    err('--apply требует --company <числовой id> (владелец дела).')
    process.exit(1)
  }

  const call = await makePortalSdkCall(memberId, deps)
  if (!call) {
    err('makePortalSdkCall вернул null (нет токена?)')
    process.exit(1)
  }

  // 1) pre-search: is the marker already present (from a prior run)?
  const before = await findActivityByMarker(ACTIVITY_ORIGINATOR_ID, originId, call)
  if (before) warn(`маркер уже есть (дело #${before}) — прошлый прогон; дедуп сработает, повторно писать не будем`)

  // 2) write (unless dedup already found it — mirrors crm-sync's read-before-write).
  let createdId = before
  if (!before) {
    createdId = await writeConfigurableActivityViaRest(item, companyId, call)
    if (!createdId) {
      err('configurable.add не вернул id (проверь layout/права/OAuth-контекст)')
      process.exit(1)
    }
    ok(`создано настраиваемое дело #${createdId} (компания ${companyId})`)
  }

  // 3) post-search: the marker must now find exactly our activity (dedup round-trip).
  const after = await findActivityByMarker(ACTIVITY_ORIGINATOR_ID, originId, call)
  if (after && after === createdId) {
    ok(`дедуп-round-trip OK — crm.activity.list по паре маркера нашёл #${after}`)
  } else {
    err(`дедуп-round-trip НЕ сошёлся: создано #${createdId}, поиск вернул ${after ?? 'null'}`)
    process.exit(1)
  }

  console.log(`\n${C.green}✓ configurable.add + B24-дедуп по маркеру работают вживую.${C.reset} Можно включать ACTIVITY_TRANSPORT=configurable.\n`)
}

main().catch((e) => {
  err(`FATAL: ${(e as Error).message}`)
  process.exit(1)
})
