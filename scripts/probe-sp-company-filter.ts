// Live probe for #572 item 1: does `crm.item.list` FAIL LOUD or FAIL OPEN when filtering by
// `companyId` on a smart process that has NO client binding (`isClientEnabled: false`)?
//
// Why it matters: `intentResolver` (`smart-id` / `smart-field` branches) scopes the candidate search
// to the payer's company — that scope is the IDOR defence. Its own comment admits the gap: «If a
// given SP has no company binding, B24 may ignore the unknown filter key → scope fails open.» It was
// never measured, and trigger targets are already wired to a real mutation
// (`crm.automation.trigger.execute` behind the `autoDistribute` gate), so «unknown» is not good
// enough any more.
//
// Two outcomes, and they need OPPOSITE fixes:
//   - 400 INVALID_ARG_VALUE  → fail-loud → the scope cannot silently widen → drop the stale comment.
//   - rows come back         → fail-OPEN → another portal's element could be paid → verify each row.
//
// ⚠ This WRITES to the portal: it creates a throwaway SP + one item, then deletes both. Teardown runs
// in `finally`, and the run prints what it could not clean up — a leftover SP type in a client CRM is
// exactly the kind of litter this repo refuses to leave behind.
//
// Run:  pnpm probe:sp-filter            (webhook, .env.b24test)
//       pnpm probe:sp-filter --keep     (leave the SP for manual inspection)

import { loadDotEnv } from './lib/env.mjs'
import { httpRequest } from './lib/http.mjs'
import { C, head, ok, err, warn } from './lib/cli.mjs'
import { extractCreatedSpRef } from '../server/utils/distributionSpProvision.ts'

type RestCall = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

const keep = process.argv.includes('--keep')
loadDotEnv(['.env.b24test'], { explicit: false })

/** Title carries the issue number so a leftover is traceable to why it exists. */
const PROBE_TITLE = 'ZZZ probe 572 no-client'
/** A company id that certainly does not own our probe item — the point is that the filter must not
 *  quietly return rows anyway. */
const FOREIGN_COMPANY_ID = 999999

/** Raw call that returns the FULL envelope AND never throws — the probe must inspect errors, not die. */
function rawCall(): (method: string, params?: Record<string, unknown>) => Promise<{ ok: boolean, body: Record<string, unknown>, status?: number }> {
  const webhook = (process.env.B24_TEST_WEBHOOK ?? '').trim()
  if (!webhook) {
    err('B24_TEST_WEBHOOK missing in .env.b24test')
    process.exit(1)
  }
  return async (method, params = {}) => {
    const res = await httpRequest(webhook + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(params)
    })
    const body = (res.json ?? {}) as Record<string, unknown>
    return { ok: !body.error, body, status: res.status }
  }
}

const raw = rawCall()
/** Throwing wrapper for the setup/teardown steps, where an error IS a failure. */
const call: RestCall = async (method, params = {}) => {
  const r = await raw(method, params)
  if (!r.ok) throw new Error(`${method}: ${String(r.body.error)} ${String(r.body.error_description ?? '')}`.trim())
  return r.body
}

async function main(): Promise<void> {
  head('#572 — фильтр companyId на смарт-процессе БЕЗ привязки к клиенту')

  let entityTypeId = 0
  let typeId = 0
  let itemId = 0
  try {
    // 1. Throwaway SP with NO client binding — the exact shape the resolver worries about.
    // ⚠ The raw response is captured BEFORE parsing so a shape change cannot orphan the SP: the
    // portal has already created it by then, and a throw from `extractCreatedSpRef` used to leave
    // `typeId = 0`, so `finally` deleted nothing AND said nothing. An orphan smart process in a
    // client CRM is exactly the litter this file promises never to leave.
    const created = await call('crm.type.add', {
      fields: {
        title: PROBE_TITLE,
        isStagesEnabled: false,
        isCategoriesEnabled: false,
        isClientEnabled: false,
        isMycompanyEnabled: false,
        isAutomationEnabled: false,
        isBizProcEnabled: false,
        isRecyclebinEnabled: true
      }
    })
    const rawTypeId = Number(((created.result as { type?: { id?: unknown } })?.type)?.id ?? 0)
    if (Number.isInteger(rawTypeId) && rawTypeId > 0) typeId = rawTypeId // teardown can proceed even if the ref fails to parse
    const ref = extractCreatedSpRef(created)
    if (!ref) throw new Error(`crm.type.add вернул СП без entityTypeId/id (title "${PROBE_TITLE}", сырой id ${rawTypeId || '—'})`)
    entityTypeId = ref.entityTypeId
    typeId = ref.id
    ok(`СП создан: entityTypeId=${entityTypeId}, typeId=${typeId} ${C.dim}(isClientEnabled: false)${C.reset}`)

    // 2. One item — without a row to leak, «fail open» and «empty SP» look identical.
    const addResp = await call('crm.item.add', { entityTypeId, fields: { title: 'probe item 572' } })
    itemId = Number(((addResp.result as { item?: { id?: unknown } })?.item)?.id ?? 0)
    if (!itemId) throw new Error('crm.item.add вернул элемент без id')
    ok(`элемент создан: id=${itemId}`)

    // 3. Baseline: the item IS visible with no filter. Without this the probe cannot tell «filter
    //    worked» from «SP was empty all along».
    const baseline = await raw('crm.item.list', { entityTypeId })
    const baseItems = (((baseline.body.result as { items?: unknown[] })?.items) ?? []) as unknown[]
    // ⚠ ASSERTED, not merely printed. Found in review: the verdict below branched only on the
    // filtered call, so if the baseline came back empty for any unrelated reason (indexing lag, a
    // non-JSON response coerced to `{}` by `rawCall`), BOTH calls would read `items=0` and the
    // script would print a confident green FAIL-CLOSED while proving nothing. A precondition that
    // is only logged is not a precondition.
    if (baseItems.length === 0) throw new Error('база пуста: элемент не виден и БЕЗ фильтра — замер недействителен')
    ok(`база (без фильтра): items=${baseItems.length}`)

    // 4. THE MEASUREMENT.
    // ⚠ `select` mirrors the production shape (`itemByIdParams`), minus `parentId2`, which
    // `selectFields` already excludes for a deal. Measured separately: an UNKNOWN field in `select`
    // is IGNORED silently (HTTP 200) — only the filter is strict — so `select` cannot be the cause
    // of the verdict either way.
    const probe = await raw('crm.item.list', {
      entityTypeId,
      filter: { companyId: FOREIGN_COMPANY_ID },
      select: ['id', 'companyId', 'stageId', 'opportunity', 'currencyId']
    })
    const probeItems = (((probe.body.result as { items?: unknown[] })?.items) ?? []) as unknown[]

    head('РЕЗУЛЬТАТ')
    if (!probe.ok) {
      ok(`FAIL-LOUD: портал отверг фильтр — ${String(probe.body.error)}: ${String(probe.body.error_description ?? '')}`)
      console.log(`${C.dim}Скоуп по компании не может молча расшириться: незнакомый ключ фильтра роняет вызов.${C.reset}`)
    } else if (probeItems.length === 0) {
      ok(`FAIL-CLOSED: фильтр принят и отдал items=0 — чужие строки не возвращаются`)
    } else {
      err(`FAIL-OPEN: фильтр ПРОИГНОРИРОВАН — вернулось items=${probeItems.length} при чужом companyId=${FOREIGN_COMPANY_ID}`)
      console.log(`${C.dim}Значит скоуп по компании на таком СП не защищает — нужна сверка каждой строки.${C.reset}`)
    }
    console.log(`${C.dim}сырой ответ: ${JSON.stringify(probe.body).slice(0, 400)}${C.reset}`)
  } finally {
    if (keep) {
      warn(`--keep: СП ${entityTypeId || '—'} оставлен на портале, удалите вручную`)
    } else {
      // ⚠ Teardown is best-effort but LOUD: silence here would leave litter in a client CRM.
      if (itemId && entityTypeId) {
        await call('crm.item.delete', { entityTypeId, id: itemId }).then(() => ok('элемент удалён'),
          (e: unknown) => err(`элемент НЕ удалён (${entityTypeId}/${itemId}): ${String(e)}`))
      }
      if (typeId) {
        await call('crm.type.delete', { id: typeId }).then(() => ok('СП удалён'),
          (e: unknown) => err(`СП НЕ удалён (typeId=${typeId}): ${String(e)} — удалите вручную`))
      } else if (entityTypeId) {
        err(`СП создан, но его id неизвестен — найдите и удалите вручную по названию "${PROBE_TITLE}"`)
      }
    }
  }
}

main().catch((e: unknown) => {
  err(String(e))
  process.exit(1)
})
