// Live smoke of the #495 activity carrier: crm.activity.todo.add + the B24-side dedup
// search (crm.activity.list filter[ORIGINATOR_ID][ORIGIN_ID]). Dev-only, not part of SSG.
//
// Exercises the EXACT code crm-sync runs to write an operation:
// `buildTodoActivity` → `writeTodoActivityViaRest` (add + marker-update) → `findActivityByMarker`,
// over the real per-portal OAuth transport (`makePortalSdkCall`) with an in-memory token store
// (no Postgres/Redis). todo.add is OAuth/app-context only, so this is the live gate the
// webhook smokes can't cover. Get OAuth creds with scripts/extract-oauth-from-docker.sh →
// .env.b24oauth (same as sdk:crm:test).
//
// Run:  node --experimental-strip-types --disable-warning=ExperimentalWarning \
//         --import ./scripts/lib/alias-loader.mjs scripts/todo-activity-test.ts \
//         --company <id> [--apply]
// (wired as `pnpm activity:test`). DRY-RUN by default (prints the params, writes nothing).
// --apply actually creates the activity, then searches the marker to prove the dedup round-trip.

import { loadDotEnv } from './lib/env.mjs'
import { C, head, ok, warn, err } from './lib/cli.mjs'
import { makePortalSdkCall, type SdkPortalDeps } from '../server/utils/b24Sdk.ts'
import type { PortalToken } from '../server/utils/tokenStore.ts'
import { B24_REQUIRED_SCOPES } from '../app/config/b24.ts'
import type { StatementItem } from '../app/types/statement.ts'
import { buildTodoActivity, ACTIVITY_ORIGINATOR_ID, activityOriginId } from '../app/utils/todoActivity.ts'
import { buildLegacyActivity } from '../app/utils/legacyActivity.ts'
import { writeTodoActivityViaRest, writeLegacyActivityViaRest } from '../server/utils/todoActivityWrite.ts'
import { findActivityByMarker } from '../server/utils/activityMarkerLookup.ts'

loadDotEnv(['.env.b24oauth', '.env.b24test'], { explicit: false })

const apply = process.argv.includes('--apply')
// --legacy exercises the #722 FALLBACK carrier (`crm.activity.add`) instead of `todo.add`.
// ⚠ This flag exists because unit tests cannot cover this class of defect at all: they check the
// SHAPE of the params, while «is this activity type supported» is known only to the portal. The
// first edition of `legacyActivity.ts` was dead on every portal (every TYPE_ID rejected) and the
// whole suite stayed green. Run this before shipping any change to the fallback builder.
const legacy = process.argv.includes('--legacy')
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
  head(`${legacy ? 'crm.activity.add (#722, запасной носитель)' : 'todo.add (#495, дедуп #259)'} · портал ${domain} · ${apply ? 'APPLY' : 'DRY-RUN'}`)
  // ⚠ DRY-RUN must print the params of the carrier it would ACTUALLY use — printing todo params
  // under --legacy would show a call we are not making, which is worse than printing nothing.
  const params = legacy
    ? buildLegacyActivity(item, { id: Number(companyId || 0) }, 0)
    : buildTodoActivity(item, { id: Number(companyId || 0) })
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
    createdId = legacy
      ? await writeLegacyActivityViaRest(item, companyId, call, undefined, memberId)
      // memberId is passed on purpose: it enables BOTH the marker self-check and the portal
      // currency dictionary (#729) — without it the smoke would exercise a path crm-sync never takes.
      : await writeTodoActivityViaRest(item, companyId, call, undefined, memberId)
    if (!createdId) {
      err('todo.add не вернул id (проверь права/контекст приложения)')
      process.exit(1)
    }
    ok(`создано дело #${createdId} (компания ${companyId})`)
  }

  // 3) post-search: the marker must now find exactly our activity (dedup round-trip).
  const after = await findActivityByMarker(ACTIVITY_ORIGINATOR_ID, originId, call)
  if (after && after === createdId) {
    ok(`дедуп-round-trip OK — crm.activity.list по паре маркера нашёл #${after}`)
  } else {
    err(`дедуп-round-trip НЕ сошёлся: создано #${createdId}, поиск вернул ${after ?? 'null'}`)
    process.exit(1)
  }

  console.log(`\n${C.green}✓ ${legacy ? 'crm.activity.add' : 'todo.add'} + B24-дедуп по маркеру работают вживую.${C.reset}\n`)
}

main().catch((e) => {
  err(`FATAL: ${(e as Error).message}`)
  process.exit(1)
})
