// Live end-to-end READ verification for the #109 allocation pipeline (dev-only, not
// part of the SSG build). Runs the REAL pure cores (companyLookup / stageLoader /
// invoiceLookup / paymentLookup / purposeMatch) against a live test portal seeded by
// `pnpm seed:b24`, proving the lookups resolve the fixtures correctly before the
// write-path is wired. Webhook comes from the git-ignored `.env.b24test`.
//
// Run:  node --experimental-strip-types --disable-warning=ExperimentalWarning \
//         --import ./scripts/lib/alias-loader.mjs scripts/verify-109-live.ts
// (wired as `pnpm verify:109`).

import { loadDotEnv } from './lib/env.mjs'
import { httpRequest } from './lib/http.mjs'
import { C, head, ok, err } from './lib/cli.mjs'
import { findCompanyByAccount, findMyCompanyByAccount } from '../server/utils/companyLookup.ts'
import { findInvoicesByNumber } from '../server/utils/invoiceLookup.ts'
import { loadInvoiceNegativeStage } from '../server/utils/stageLoader.ts'
import { findCompanyDealPayments } from '../server/utils/paymentLookup.ts'
import { findCandidateById } from '../server/utils/itemByIdLookup.ts'
import { findDocumentEntities } from '../server/utils/documentLookup.ts'
import { routeDocumentRef } from '../server/utils/intentResolver.ts'
import { recognizeByMatrices } from '../app/utils/purposeMatch.ts'
import { resolveAllocation, filterByAccountNumber } from '../app/utils/allocation.ts'

loadDotEnv(['.env.b24test'], { explicit: false })
const WEBHOOK = (process.env.B24_TEST_WEBHOOK ?? '').trim()
if (!WEBHOOK) {
  err('B24_TEST_WEBHOOK missing in .env.b24test')
  process.exit(1)
}

// RestCall over the webhook: POST JSON, return the FULL envelope ({result,…}) the
// cores expect, throw on a B24 error (the RestCall contract our lookups rely on).
const call = async (method: string, params: Record<string, unknown> = {}) => {
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

// Seeded fixtures (from scripts/seed-test-b24.mjs).
const ACC_CLIENT_ALFA = 'BY04ALFA30129000000000009001'
const ACC_CLIENT_BETA = 'BY24PJCB30129000000000009002'
const ACC_MY_1 = 'BY04ALFA30129000000000009100'
const INV_CAT = 11

// Any thrown/rejected REST error surfaces as a clean failure + exit(1), not a raw
// stack trace mid-checklist (dev harness — keep the output legible).
process.on('unhandledRejection', (e) => {
  err(`Прогон упал: ${(e as { message?: string })?.message ?? String(e)}`)
  process.exit(1)
})

head('#109 live READ verification · ' + WEBHOOK.replace(/\/rest\/\d+\/[^/]+/, '/rest/***/***'))

// 1) companyLookup — client + my company by account, and the not-found path.
const alfaId = await findCompanyByAccount(ACC_CLIENT_ALFA, call)
check('companyLookup: клиент Альфа по счёту → компания', !!alfaId, `id=${alfaId}`)
const betaId = await findCompanyByAccount(ACC_CLIENT_BETA, call)
check('companyLookup: клиент Бета (ИП) по счёту → компания', !!betaId, `id=${betaId}`)
const myId = await findMyCompanyByAccount(ACC_MY_1, call)
check('companyLookup: МОЯ компания по нашему счёту (isMyCompany=Y)', !!myId, `id=${myId}`)
const none = await findCompanyByAccount('BY00NONE00000000000000000000', call)
check('companyLookup: несуществующий счёт → null (не падает)', none === null, `→ ${none}`)

// Hard precondition: the client/my-company ids gate every downstream block. If any is
// null (e.g. the portal isn't seeded), FAIL LOUDLY instead of silently skipping the
// dependent checks and still printing a green summary with fewer asserts.
if (!alfaId || !betaId || !myId) {
  err('companyLookup не вернул id — портал не засеян? Прогоните `pnpm seed:b24`. Дальнейшие проверки невозможны.')
  process.exit(1)
}

// 2) stageLoader — negative-stage predicate for the invoice category.
const isNeg = await loadInvoiceNegativeStage(INV_CAT, call)
check('stageLoader: DT31_11:D (Не оплачен) — отрицательная стадия', isNeg('DT31_11:D') === true)
check('stageLoader: DT31_11:P (Оплачен) — НЕ отрицательная', isNeg('DT31_11:P') === false)
check('stageLoader: DT31_11:N (открытый) — НЕ отрицательная', isNeg('DT31_11:N') === false)

// 3) invoiceLookup — by number + company, with stage filter and IDOR scoping.
if (alfaId) {
  const paid = await findInvoicesByNumber('СЧ-0001', { companyId: alfaId, isNegativeStage: isNeg }, call)
  check('invoiceLookup: СЧ-0001 (оплачен) найден в компании клиента', paid.length === 1, JSON.stringify(paid[0]))
  // СЧ-0100 is the OPEN invoice under Альфа (СЧ-0002 belongs to Бета — a good
  // negative for the IDOR check below, not this company's invoice).
  const open = await findInvoicesByNumber('СЧ-0100', { companyId: alfaId, isNegativeStage: isNeg }, call)
  check('invoiceLookup: СЧ-0100 (открытый, компания Альфа) найден', open.length === 1, JSON.stringify(open[0]))
  const unpaid = await findInvoicesByNumber('СЧ-0003', { companyId: alfaId, isNegativeStage: isNeg }, call)
  check('invoiceLookup: СЧ-0003 (Не оплачен) ИСКЛЮЧЁН по стадии', unpaid.length === 0)
}
if (betaId) {
  const idor = await findInvoicesByNumber('СЧ-0001', { companyId: betaId, isNegativeStage: isNeg }, call)
  check('invoiceLookup: СЧ-0001 НЕ виден из чужой компании (IDOR-скоуп)', idor.length === 0)
}

// 4) purposeMatch — recognize the invoice number from a payment purpose by matrix.
const rec = recognizeByMatrices('Оплата по счету СЧ-0001 за услуги, без НДС', [{ mask: 'СЧ-dddd', kind: 'invoice-number' }], 'cyrillic')
const recJson = JSON.stringify(rec)
check('purposeMatch: распознан «СЧ-0001» из назначения по матрице', recJson.includes('0001') && rec.length > 0, recJson)

// 5) resolveAllocation — SINGLE exact target: invoiceLookup candidate fed into the pure
// decision (exactly what crm-sync does before it acts on a match).
{
  const cands = await findInvoicesByNumber('СЧ-0001', { companyId: alfaId, isNegativeStage: isNeg }, call)
  // СЧ-0001 is 1000 BYN → an exact-amount payment allocates to it, unambiguously.
  const dExact = resolveAllocation({ amount: 1000, currency: 'BYN', candidates: cands })
  check('resolveAllocation: платёж 1000 BYN / СЧ-0001 → allocate invoice#' + cands[0]?.id + ' (один кандидат)',
    dExact.action === 'allocate' && dExact.target.id === cands[0]?.id && dExact.ambiguous === false, JSON.stringify(dExact))
  // A different amount → manual (no exact match) — never mis-allocated.
  const dManual = resolveAllocation({ amount: 999, currency: 'BYN', candidates: cands })
  check('resolveAllocation: платёж 999 BYN / СЧ-0001 → manual (сумма не совпала)', dManual.action === 'manual', dManual.action)
  // Wrong currency → manual too (owner rule: currency must match).
  const dCur = resolveAllocation({ amount: 1000, currency: 'USD', candidates: cands })
  check('resolveAllocation: платёж 1000 USD / СЧ-0001 → manual (валюта не совпала)', dCur.action === 'manual', dCur.action)
}

// 6) deal-payment pool + AMBIGUOUS decision — pool fetched ONCE. Сделки Опт и Опт-2
// несут по неоплаченной оплате 1200 BYN → two distinct deal-payment targets of equal
// amount → resolveAllocation auto-allocates the smallest id AND flags `ambiguous`.
{
  const pool = await findCompanyDealPayments(alfaId, {}, call)
  const cands1200 = pool.filter(p => Number((p as { amount?: number }).amount) === 1200)
  check('paymentLookup: company-пул содержит ≥2 неоплаченные 1200 BYN (Опт + Опт-2)', cands1200.length >= 2, JSON.stringify(pool))
  const dPay = resolveAllocation({ amount: 1200, currency: 'BYN', candidates: pool })
  check('resolveAllocation: платёж 1200 BYN → allocate deal-payment + AMBIGUOUS (две цели)',
    dPay.action === 'allocate' && dPay.target.kind === 'deal-payment' && dPay.ambiguous === true, JSON.stringify(dPay))
  // Auto-allocated to the SMALLEST id among the equal-amount candidates (owner rule).
  const minId = String(Math.min(...cands1200.map(c => Number((c as { id: string }).id))))
  check('resolveAllocation: выбран минимальный id среди равных (min-ID правило)',
    dPay.action === 'allocate' && dPay.target.id === minId, dPay.action === 'allocate' ? `target=${dPay.target.id}, min=${minId}` : dPay.action)

  // 7) payment-number path — filterByAccountNumber over the SAME company pool: a
  // recognized payment number is matched against each payment's own accountNumber
  // (the IDOR-safe resolver path for `payment-number`). Uses a real accountNumber from
  // the live pool so the fixture's exact value (portal-assigned) doesn't matter.
  const accNum = (pool[0] as { accountNumber?: string })?.accountNumber
  const byNum = filterByAccountNumber(pool, accNum ?? '')
  check(`filterByAccountNumber: по номеру оплаты «${accNum}» из пула → найдена, и только с этим номером`,
    !!accNum && byNum.length >= 1 && byNum.every(c => (c as { accountNumber?: string }).accountNumber === accNum), JSON.stringify(byNum))
  // A number absent from the pool → empty (no accidental over-match).
  check('filterByAccountNumber: несуществующий номер оплаты → пусто', filterByAccountNumber(pool, 'НЕТ-ТАКОГО/000').length === 0)
  // Empty number → empty (never sweeps the whole pool).
  check('filterByAccountNumber: пустой номер → пусто (не сметает пул)', filterByAccountNumber(pool, '').length === 0)
}

// 8) via-document bridge (#109, §4) — LIVE. A document is generated from the seeded
// template and bound to a deal; find it by number → route the bound ref → resolve the
// entity SCOPED to the payer company (IDOR: a wrong company must not see it). This is
// the exact chain intentResolver runs for a `document-number` intent.
{
  // Ensure a document exists bound to a deal in the Alfa company pool (idempotent: reuse
  // if already present so the check is repeatable without piling up documents).
  const pool = await findCompanyDealPayments(alfaId, {}, call)
  const dealId = String((pool[0] as { dealId?: string })?.dealId ?? '')
  let docNumber = ''
  if (dealId) {
    const listed = await call('crm.documentgenerator.document.list', { filter: { entityTypeId: 2, entityId: Number(dealId) } })
    const docs = ((listed.result as { documents?: Array<{ number?: string }> })?.documents) ?? []
    if (docs.length && docs[0]?.number) {
      docNumber = String(docs[0].number)
    } else {
      const tpls = await call('crm.documentgenerator.template.list')
      const tplId = Object.keys(((tpls.result as { templates?: Record<string, unknown> })?.templates) ?? {})[0]
      if (tplId) {
        const added = await call('crm.documentgenerator.document.add', { templateId: Number(tplId), entityTypeId: 2, entityId: Number(dealId), values: {} })
        docNumber = String((added.result as { document?: { number?: string } })?.document?.number ?? '')
      }
    }
  }
  check('via-document: подготовлен документ на сделку из пула компании', !!docNumber, `deal=${dealId} number=${docNumber}`)

  if (docNumber) {
    const refs = await findDocumentEntities(docNumber, call)
    const ref = refs.find(r => r.entityTypeId === '2')
    check('documentLookup: обратный filter:{number} находит документ, ref несёт entityTypeId/entityId', !!ref && !!ref?.entityId, JSON.stringify(refs))
    // Control: a number that doesn't exist → empty (filter is honored, not ignored).
    check('documentLookup: несуществующий номер → пусто (фильтр не игнорируется)', (await findDocumentEntities('НЕТ-ТАКОГО-000', call)).length === 0)

    const routed = ref ? routeDocumentRef(ref, undefined) : null
    check('routeDocumentRef: entityTypeId=2 → цель deal', routed?.targetKind === 'deal' && routed?.entityTypeId === 2, JSON.stringify(routed))

    if (ref && routed) {
      const found = await findCandidateById(routed.targetKind, routed.entityTypeId, ref.entityId, { companyId: alfaId, isNegativeStage: isNeg }, call)
      check('via-document: мост → deal-кандидат в компании плательщика', found?.kind === 'deal' && found?.id === ref.entityId, JSON.stringify(found))
      // IDOR: the same document's deal must NOT resolve from a different company.
      const wrong = await findCandidateById(routed.targetKind, routed.entityTypeId, ref.entityId, { companyId: betaId, isNegativeStage: isNeg }, call)
      check('via-document: тот же документ НЕ виден из чужой компании (IDOR-скоуп)', wrong === null, JSON.stringify(wrong))
    }
  }
}

head(fail === 0 ? `Все проверки пройдены (${pass})` : `Провалено ${fail} из ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
