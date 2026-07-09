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
import { recognizeByMatrices } from '../app/utils/purposeMatch.ts'

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

// 5) paymentLookup — the deal's unpaid payment is a deal-payment candidate.
if (alfaId) {
  const pool = await findCompanyDealPayments(alfaId, {}, call)
  const has1200 = pool.some(p => Number((p as { amount?: number }).amount) === 1200)
  check('paymentLookup: company-пул оплат содержит неоплаченную 1200 BYN (сделка Опт)', has1200, JSON.stringify(pool))
}

head(fail === 0 ? `Все проверки пройдены (${pass})` : `Провалено ${fail} из ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
