// Live verification for the #579 ACTIVITY BINDINGS path (dev-only, not part of SSG).
//
// The activity carries ONE owner pair. Everything else it must reach — the payments SP element, the
// write-off entity, the other company — can only be attached through `crm.activity.binding.add`,
// and three claims about that method cannot be settled by unit tests:
//
//   1. the binding actually STICKS — `BINDINGS` is a read-only field, and a write that reports
//      success proves nothing until `crm.activity.binding.list` shows it (the same silent-accept
//      trap measured on `crm.item.add` in #575);
//   2. re-binding the SAME pair is an ERROR (`ACTIVITY_IS_ALREADY_BOUND`, measured), which is why
//      the transport reads `binding.list` before retrying a halted batch instead of re-adding
//      blindly — this run proves that path stays clean on a second pass;
//   3. the owner pair is already there — which is why the planner never re-binds it.
//
// Steps:
//   1. provisionDistributionSp   — payments SP (idempotent)
//   2. seed                      — two synthetic companies + one deal (the write-off entity)
//   3. writePaymentRegistryViaRest + writeTodoActivityViaRest — the real production writers
//   4. planActivityBindings      — assert the owner is dropped
//   5. bindActivityViaRest       — then read `binding.list` back and assert every pair is there
//   6. repeat step 5             — assert the transport skips what is already bound (no error, no dupes)
//   7. teardown                  — delete activity, deal, companies, SP element
//
// ⚠ Everything written here is SYNTHETIC and stays synthetic: this file is committed to a PUBLIC
// repository and it writes to a portal (see docs/PRIVACY.md).
//
// Run:  pnpm verify:bindings            (webhook, .env.b24test)
//       pnpm verify:bindings --oauth    (prod transport, .env.b24oauth — ROTATES the refresh token)
//       add --keep to leave the created records on the portal.

import { readFileSync, writeFileSync } from 'node:fs'
import { loadDotEnv } from './lib/env.mjs'
import { httpRequest } from './lib/http.mjs'
import { C, head, ok, err } from './lib/cli.mjs'
import { provisionDistributionSp } from '../server/utils/distributionSpProvision.ts'
import { writePaymentRegistryViaRest } from '../server/utils/paymentRegistryWrite.ts'
import { writeTodoActivityViaRest } from '../server/utils/todoActivityWrite.ts'
import { bindActivityViaRest } from '../server/utils/activityBindingsWrite.ts'
import {
  ACTIVITY_BINDING_LIST_METHOD, CRM_ENTITY_TYPE_DEAL, allocationTargetRef, companyRef, itemRef,
  planActivityBindings, type CrmEntityRef
} from '../app/utils/activityBindings.ts'
import { CRM_OWNER_TYPE_COMPANY } from '../app/utils/activity.ts'
import type { SpRef } from '../app/config/distributionSp.ts'
import { makePortalSdkCall, type SdkPortalDeps } from '../server/utils/b24Sdk.ts'
import type { PortalToken } from '../server/utils/tokenStore.ts'
import type { StatementItem } from '../app/types/statement.ts'
import { B24_REQUIRED_SCOPES } from '../app/config/b24.ts'

type RestCall = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

const useOauth = process.argv.includes('--oauth')
const keep = process.argv.includes('--keep')

loadDotEnv(['.env.b24test'], { explicit: false })
loadDotEnv(['.env.b24oauth'], { explicit: false })

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

/** Rewrite access/refresh in .env.b24oauth, keeping the other lines and their order.
 *  Bitrix24 rotates the refresh token on every refresh, so skipping this would make the file
 *  stale after the FIRST run and the next one would die on `invalid_grant`. */
function persistOauthEnv(accessToken: string, refreshToken: string): void {
  const file = '.env.b24oauth'
  const lines = readFileSync(file, 'utf8').split('\n')
  const set = (key: string, value: string) => {
    const i = lines.findIndex(l => l.startsWith(`${key}=`))
    if (i >= 0) lines[i] = `${key}=${value}`
    else lines.push(`${key}=${value}`)
  }
  set('B24_OAUTH_ACCESS_TOKEN', accessToken)
  set('B24_OAUTH_REFRESH_TOKEN', refreshToken)
  writeFileSync(file, lines.join('\n'))
}

async function oauthCall(): Promise<{ call: RestCall, label: string }> {
  const env = (k: string) => (process.env[k] ?? '').trim()
  const memberId = env('B24_OAUTH_MEMBER_ID')
  const domain = env('B24_OAUTH_DOMAIN')
  const req = {
    B24_OAUTH_DOMAIN: domain, B24_OAUTH_MEMBER_ID: memberId,
    B24_OAUTH_ACCESS_TOKEN: env('B24_OAUTH_ACCESS_TOKEN'), B24_OAUTH_REFRESH_TOKEN: env('B24_OAUTH_REFRESH_TOKEN'),
    B24_CLIENT_ID: env('B24_CLIENT_ID'), B24_CLIENT_SECRET: env('B24_CLIENT_SECRET')
  }
  const missing = Object.entries(req).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) {
    err(`--oauth: не хватает env: ${missing.join(', ')}`)
    process.exit(1)
  }
  const token: PortalToken = {
    memberId, domain, accessToken: env('B24_OAUTH_ACCESS_TOKEN'), refreshToken: env('B24_OAUTH_REFRESH_TOKEN'),
    applicationToken: '', expiresAt: Date.now() + Number(env('B24_OAUTH_EXPIRES_IN') || 3600) * 1000
  }
  const deps: SdkPortalDeps = {
    loadToken: async () => token,
    saveToken: async (t) => {
      try {
        persistOauthEnv(t.accessToken, t.refreshToken)
        console.log(`${C.dim}   (токен обновлён, .env.b24oauth перезаписан)${C.reset}`)
      } catch (e) {
        err(`не удалось сохранить обновлённый токен: ${String((e as Error)?.message ?? e)}`)
      }
    },
    creds: { clientId: env('B24_CLIENT_ID'), clientSecret: env('B24_CLIENT_SECRET') },
    now: Date.now,
    scope: B24_REQUIRED_SCOPES.join(',')
  }
  const call = await makePortalSdkCall(memberId, deps)
  if (!call) {
    err('--oauth: makePortalSdkCall вернул null')
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

const stamp = process.env.BINDINGS_PROBE_STAMP || String(Math.floor(Date.now() / 1000))

/** Synthetic operation. ⚠ Every value is made up — see the privacy note in the header. */
const OP: StatementItem = {
  account: `BY00PROBE${stamp}`,
  docId: `bindings-${stamp}`,
  direction: 'credit',
  amount: 500,
  currency: 'BYN',
  purpose: 'Оплата по счёту СЧ-1 (синтетическая проба #579)',
  counterparty: {
    name: 'ООО «Проба Привязок»',
    unp: '000000000',
    account: `BY00CPTY${stamp}`,
    bank: 'Проба-банк'
  },
  acceptDate: '2026-08-22T00:00:00+03:00'
}

/** id from the `{result: {item?: {id}} | id}` envelope — the shape differs per method. */
function idOf(resp: Record<string, unknown>): string {
  const result = resp?.result as unknown
  if (result && typeof result === 'object') {
    const item = (result as { item?: { id?: unknown } }).item
    if (item && item.id !== undefined) return String(item.id)
    const id = (result as { id?: unknown }).id
    if (id !== undefined) return String(id)
  }
  return String(result ?? '')
}

async function main() {
  head('#579 — привязки дела к сущностям, живая проверка')
  const { call, label } = useOauth ? await oauthCall() : { call: webhookCall(), label: 'webhook .env.b24test' }
  console.log(`${C.dim}транспорт: ${label}${C.reset}\n`)
  const restCall = call as unknown as (m: string, p: Record<string, unknown>) => Promise<Record<string, unknown>>

  head('1. Провижининг СП «платежи»')
  const prov = await provisionDistributionSp(restCall)
  const sp: SpRef = prov.payment
  check('СП доступен', sp.entityTypeId > 0 && sp.id > 0, `entityTypeId=${sp.entityTypeId} id=${sp.id}`)

  head('2. Посев: две компании и сделка')
  const clientId = idOf(await call('crm.company.add', { fields: { TITLE: `Проба привязок — клиент ${stamp}` } }))
  const myCompanyId = idOf(await call('crm.company.add', { fields: { TITLE: `Проба привязок — моя компания ${stamp}` } }))
  const dealId = idOf(await call('crm.deal.add', { fields: { TITLE: `Проба привязок — сделка ${stamp}` } }))
  check('компании и сделка созданы', !!clientId && !!myCompanyId && !!dealId,
    `client=${clientId} my=${myCompanyId} deal=${dealId}`)

  head('3. Реестр платежей и дело — теми же писателями, что в проде')
  const elementId = await writePaymentRegistryViaRest(OP, clientId, 'alfa-by', sp, restCall)
  check('элемент реестра записан', !!elementId, `id=${elementId}`)
  const activityId = await writeTodoActivityViaRest(OP, clientId, restCall)
  check('дело записано', !!activityId, `id=${activityId}`)

  // ⚠ Everything from here on runs inside try/finally. Steps 4-6 talk to a live portal, so ANY of
  // them can throw — and the records seeded in step 2 are real CRM rows. Without the finally an
  // aborted run left two companies, a deal, an activity and an SP element behind, and since the
  // probe stamps a fresh id every time, each retry piled up another set for a human to delete.
  try {
    if (!activityId || !elementId) {
      err('дальше проверять нечего')
      return
    }

    head('4. Отбор привязок: владелец не дублируется')
    const owner = companyRef(clientId)!
    const planned = planActivityBindings({
      owner,
      refs: [
        itemRef(sp.entityTypeId, elementId),
        allocationTargetRef({ kind: 'deal', id: dealId }),
        companyRef(myCompanyId),
        companyRef(clientId) // the owner — must be dropped by the planner
      ]
    })
    check('владелец не попал в план', !planned.some(r => r.entityTypeId === owner.entityTypeId && r.entityId === owner.entityId))
    check('в плане три привязки', planned.length === 3, `получено ${planned.length}`)

    head('5. Запись привязок и чтение обратно')
    const outcome = await bindActivityViaRest(activityId, planned, restCall)
    check('вызовы прошли без отказов', outcome.failed === 0, `bound=${outcome.bound} failed=${outcome.failed}`)
    const listed = await call(ACTIVITY_BINDING_LIST_METHOD, { activityId: Number(activityId) })
    const rows = (listed.result as Array<Record<string, unknown>>) ?? []
    const have = new Set(rows.map(r => `${r.ENTITY_TYPE_ID ?? r.entityTypeId}:${r.ENTITY_ID ?? r.entityId}`))
    console.log(`${C.dim}   привязок на деле: ${[...have].join(', ')}${C.reset}`)
    const want: Array<[string, CrmEntityRef]> = [
      ['элемент реестра', itemRef(sp.entityTypeId, elementId)!],
      ['сделка (сущность списания)', { entityTypeId: CRM_ENTITY_TYPE_DEAL, entityId: Number(dealId) }],
      ['вторая компания', { entityTypeId: CRM_OWNER_TYPE_COMPANY, entityId: Number(myCompanyId) }]
    ]
    for (const [human, ref] of want) {
      check(`${human} привязана`, have.has(`${ref.entityTypeId}:${ref.entityId}`), `${ref.entityTypeId}:${ref.entityId}`)
    }
    check('владелец присутствует сам по себе', have.has(`${owner.entityTypeId}:${owner.entityId}`),
      'портал держит пару владельца без нашего вызова')

    head('6. Повтор: транспорт не пытается привязать уже привязанное')
    const again = await bindActivityViaRest(activityId, planned, restCall)
    // ⚠ The portal answers a repeat binding with an ERROR (`ACTIVITY_IS_ALREADY_BOUND`), so «no
    // failures» here does not prove the method is idempotent — it proves the transport reads
    // `binding.list` first and does not call `binding.add` a second time.
    check('повтор не отказал (список прочитан, лишних вызовов нет)', again.failed === 0, `bound=${again.bound} failed=${again.failed}`)
    const listed2 = await call(ACTIVITY_BINDING_LIST_METHOD, { activityId: Number(activityId) })
    const rows2 = (listed2.result as Array<Record<string, unknown>>) ?? []
    check('дубликатов не появилось', rows2.length === rows.length, `было ${rows.length}, стало ${rows2.length}`)
  } finally {
    if (!keep) {
      head('7. Уборка')
      const drop = async (method: string, params: Record<string, unknown>) => {
        try {
          await call(method, params)
        } catch (e) {
          err(`${method}: ${String((e as Error)?.message ?? e)}`)
        }
      }
      if (activityId) await drop('crm.activity.delete', { id: Number(activityId) })
      if (elementId) await drop('crm.item.delete', { entityTypeId: sp.entityTypeId, id: Number(elementId) })
      await drop('crm.deal.delete', { id: Number(dealId) })
      await drop('crm.company.delete', { id: Number(clientId) })
      await drop('crm.company.delete', { id: Number(myCompanyId) })
      ok('созданные записи удалены')
    } else {
      console.log(`${C.dim}--keep: записи оставлены на портале${C.reset}`)
    }
  }

  head('Итог')
  console.log(`${pass} ok, ${fail} fail`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  err(String((e as Error)?.stack ?? e))
  process.exit(1)
})
