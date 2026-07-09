// Seed a Bitrix24 TEST portal with a full fixture set for exercising the payment
// allocation flow (#109, docs/PROCESSING.md): smart processes (with / without
// directions), smart invoices (paid / open / overdue), deals in several
// directions (with / without a linked invoice), a couple of products, client
// companies (with / without requisites) and «my companies» (isMyCompany=Y with
// our bank account). Re-runnable: everything is tagged by a stable `XML_ID`
// prefix and looked up before creating, so a second run updates instead of
// duplicating — that is what lets us REBUILD the fixtures on a fresh portal.
//
//   pnpm seed:b24            # create / update all fixtures, print a summary
//   pnpm seed:b24 --list     # only show what already exists (no writes)
//   pnpm seed:b24 --purge    # delete every CBATEST-tagged fixture (cleanup)
//
// The webhook URL is read from `.env.b24test` (git-ignored — NEVER commit a real
// token) as `B24_TEST_WEBHOOK=https://<portal>/rest/<user>/<token>/`. Build-free
// (plain `node scripts/…`), reuses the shared lib helpers (http/env/cli).
//
// Portal facts confirmed live (b24-rvai7u, 2026-07-06): invoice entityTypeId=31,
// default invoice category 11, stages `DT31_11:P` (Оплачен, SEMANTICS=S),
// `DT31_11:D` (Не оплачен, SEMANTICS=F — excluded by invoiceLookup), `DT31_11:N`
// (Новый, open). «My company» = a Company (entityTypeId=4) with `isMyCompany=Y`;
// invoice `mycompanyId`/`companyId` are `crm_company` refs. Requisite presets
// 1=Организация, 3=ИП, 5=Физ.лицо. Bank account lives in the bank-detail
// `RQ_ACC_NUM` — the PRIMARY key server/utils/companyLookup.ts searches by, and it
// is NOT unique (the same расчётный счёт may sit on many companies — confirmed live).
// The Belarus `RQ_IIK` fallback is NOT seeded: `RQ_IIK` rejects a 28-char BY IBAN
// («Array» validation error, even with a valid checksum / a COUNTRY_ID=4 preset —
// values ≤20 chars pass), so the account goes in `RQ_ACC_NUM`; the IIK fallback stays
// covered by unit tests. Deals carry a REAL paid payment (crm.item.payment), not just
// a linked invoice — the #109 `deal-payment` target.

import { loadDotEnv } from './lib/env.mjs'
import { httpRequest } from './lib/http.mjs'
import { C, die, head, log, ok, warn } from './lib/cli.mjs'
import { extractPayments, pickFreeEntityTypeId, validateTestWebhook } from './lib/b24-seed-utils.mjs'

// ─────────────────────────────────────────────────────────────────────────────
// Config / CLI
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const MODE = args.includes('--purge') ? 'purge' : args.includes('--list') ? 'list' : 'seed'

loadDotEnv(['.env.b24test'], { explicit: false })
const WEBHOOK = validateTestWebhook(process.env.B24_TEST_WEBHOOK)
if (!WEBHOOK) {
  die('B24_TEST_WEBHOOK is missing or malformed. Put it in .env.b24test as\n'
    + '  B24_TEST_WEBHOOK=https://<portal>.bitrix24.ru/rest/<user>/<token>/\n'
    + '(git-ignored — never commit a real token).')
}

/** Stable tag: every fixture carries an XML_ID starting with this so we can
 *  find-or-create and purge without touching real portal data. */
const TAG = 'CBATEST'
const xid = suffix => `${TAG}_${suffix}`
/** Human-facing prefix on titles/names so fixtures are obvious in the UI. */
const T = '[TEST] '

// ─────────────────────────────────────────────────────────────────────────────
// REST transport (webhook): POST JSON, retry on rate-limit, surface errors.
// ─────────────────────────────────────────────────────────────────────────────

let CALLS = 0
async function rest(method, params = {}, { tries = 4 } = {}) {
  CALLS++
  for (let attempt = 1; ; attempt++) {
    const res = await httpRequest(WEBHOOK + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(params)
    })
    const j = res.json
    if (j && j.error) {
      const retriable = j.error === 'QUERY_LIMIT_EXCEEDED' || j.error === 'OPERATION_TIME_LIMIT'
      if (retriable && attempt < tries) {
        await sleep(1000 * attempt)
        continue
      }
      throw new Error(`${method}: ${j.error} ${j.error_description || ''}`.trim())
    }
    if (res.status && res.status >= 400) throw new Error(`${method}: HTTP ${res.status} ${res.text.slice(0, 200)}`)
    // A 2xx with an unparseable body (proxy page, truncated response) must fail
    // loudly — otherwise `undefined` reads as "not found" and we'd create a dup.
    if (!j) throw new Error(`${method}: non-JSON response (HTTP ${res.status}) ${res.text.slice(0, 120)}`)
    return j.result
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─────────────────────────────────────────────────────────────────────────────
// Find-or-create helpers (idempotent by XML_ID / title).
// ─────────────────────────────────────────────────────────────────────────────

/** Ensure a currency exists on the portal (idempotent). Belarus statements are in
 *  BYN, but a fresh non-BY portal (UK/US/RU locale) ships without it, and
 *  `crm.item.add` rejects an unknown `currencyId` ("Currency is incorrect"). Add it
 *  once so the invoice/deal/smart-process fixtures load. LID is taken from the base
 *  currency so we don't pass a language the portal doesn't have. */
async function ensureCurrency(code, { amount = 1 } = {}) {
  const list = await rest('crm.currency.list', {})
  if (Array.isArray(list) && list.some(c => c.CURRENCY === code)) {
    log(`  ${C.dim}=${C.reset} валюта ${code} уже есть`)
    return
  }
  const lid = (Array.isArray(list) && (list.find(c => c.BASE === 'Y') || list[0])?.LID) || 'en'
  await rest('crm.currency.add', {
    fields: {
      CURRENCY: code, BASE: 'N', AMOUNT_CNT: 1, AMOUNT: amount, SORT: 700,
      FORMAT_STRING: `# ${code}`, DEC_POINT: '.', THOUSANDS_SEP: ' ', DECIMALS: 2, LID: lid
    }
  })
  ok(`валюта ${code} добавлена (LID=${lid})`)
}

/** A universal CRM item (company=4, deal=2, invoice=31, smart-process=NNNN)
 *  matched by its (unique) `title`. Legacy-backed types (company/deal) reject an
 *  `xmlId` filter, so title is the portable key; the `xmlId` is still stamped on
 *  create for reference. Returns the item id; updates fields if it exists. */
async function ensureItem(entityTypeId, xmlIdSuffix, fields, { label } = {}) {
  const xmlId = xid(xmlIdSuffix)
  const found = await rest('crm.item.list', {
    entityTypeId,
    filter: { title: fields.title },
    select: ['id', 'title']
  })
  const existing = found?.items?.[0]
  if (existing) {
    await rest('crm.item.update', { entityTypeId, id: existing.id, fields })
    log(`  ${C.dim}=${C.reset} ${label || xmlIdSuffix} (id ${existing.id}, updated)`)
    return existing.id
  }
  const created = await rest('crm.item.add', { entityTypeId, fields: { ...fields, xmlId } })
  const id = created?.item?.id
  ok(`${label || xmlIdSuffix} (id ${id}, created)`)
  return id
}

/** A company requisite (crm.requisite) keyed by XML_ID, with one bank detail
 *  (crm.requisite.bankdetail) also keyed by XML_ID. `account` lands in
 *  `RQ_ACC_NUM` — the PRIMARY key companyLookup searches by. (The `RQ_IIK`
 *  fallback is not seeded here: this portal is RU-locale and rejects the Belarus
 *  ИИК/IBAN field with a checksum-validation error; companyLookup's IIK fallback
 *  stays covered by unit tests. Bank BIC, if given, goes in the free `RQ_BIC`.) */
async function ensureRequisiteWithBank(companyId, xmlIdSuffix, { presetId, name, account, currency, bank, bic }) {
  const rqXml = xid(xmlIdSuffix + '_RQ')
  const bankXml = xid(xmlIdSuffix + '_BANK')
  const existRq = await rest('crm.requisite.list', { filter: { XML_ID: rqXml }, select: ['ID'] })
  let rqId = existRq?.[0]?.ID
  if (!rqId) {
    rqId = await rest('crm.requisite.add', {
      fields: {
        ENTITY_TYPE_ID: 4, ENTITY_ID: companyId, PRESET_ID: presetId,
        NAME: name, RQ_COMPANY_NAME: name, ACTIVE: 'Y', XML_ID: rqXml
      }
    })
  }
  // Match the bank detail by parent requisite (not XML_ID): a bank detail's XML_ID
  // can survive on an old/deleted requisite and wrongly short-circuit this one.
  // Update-in-place if it exists, so re-running with a changed account/currency
  // actually propagates (like ensureItem) instead of silently keeping the old row.
  const bankFields = {
    COUNTRY_ID: 4, NAME: bank || 'Тест-банк', RQ_BANK_NAME: bank || 'Тест-банк',
    RQ_ACC_NUM: account, RQ_BIC: bic || '', RQ_ACC_CURRENCY: currency || 'BYN', ACTIVE: 'Y', XML_ID: bankXml
  }
  const existBank = await rest('crm.requisite.bankdetail.list', { filter: { ENTITY_ID: rqId }, select: ['ID'] })
  const bankId = existBank?.[0]?.ID
  if (bankId) {
    await rest('crm.requisite.bankdetail.update', { id: bankId, fields: bankFields })
    log(`    ${C.dim}·${C.reset} реквизит+счёт ${account} (обновлён)`)
  } else {
    await rest('crm.requisite.bankdetail.add', { fields: { ENTITY_ID: rqId, ...bankFields } })
    log(`    ${C.dim}·${C.reset} реквизит+счёт ${account} (создан)`)
  }
  return rqId
}

/** A product (crm.product) keyed by XML_ID. */
async function ensureProduct(xmlIdSuffix, { name, price, currency }) {
  const xmlId = xid(xmlIdSuffix)
  const found = await rest('crm.product.list', { filter: { XML_ID: xmlId }, select: ['ID'] })
  if (found?.[0]?.ID) {
    log(`  ${C.dim}=${C.reset} ${name} (id ${found[0].ID}, exists)`)
    return found[0].ID
  }
  const id = await rest('crm.product.add', {
    fields: { NAME: name, CURRENCY_ID: currency || 'BYN', PRICE: price, ACTIVE: 'Y', XML_ID: xmlId }
  })
  ok(`${name} (id ${id}, created)`)
  return id
}

/** A smart-process type (crm.type) found by title, created with a chosen free
 *  even entityTypeId (>=1030) if absent. Returns its entityTypeId. */
async function ensureSmartType(title, flags) {
  const list = await rest('crm.type.list', { select: ['entityTypeId', 'title'] })
  const types = list?.types || []
  const hit = types.find(t => t.title === title)
  if (hit) {
    log(`  ${C.dim}=${C.reset} СП «${title}» (entityTypeId ${hit.entityTypeId}, exists)`)
    return hit.entityTypeId
  }
  const etid = pickFreeEntityTypeId(types.map(t => t.entityTypeId))
  const created = await rest('crm.type.add', { fields: { title, entityTypeId: etid, ...flags } })
  const id = created?.type?.entityTypeId || etid
  ok(`СП «${title}» (entityTypeId ${id}, created)`)
  return id
}

/** A pipeline/direction (crm.category) for entityTypeId, found by name. */
async function ensureCategory(entityTypeId, name) {
  const list = await rest('crm.category.list', { entityTypeId })
  const hit = (list?.categories || []).find(c => c.name === name)
  if (hit) return hit.id
  const created = await rest('crm.category.add', { entityTypeId, fields: { name } })
  return created?.category?.id
}

/** Give a deal a REAL «оплата» (a Bitrix payment object — the #109 `deal-payment`
 *  target), not just a linked invoice. The target is an UNPAID payment awaiting
 *  money: the #109 resolver only offers unpaid payments as candidates, and the
 *  app's own action on a match is `payment.pay`. So we do NOT pay it here (and the
 *  internal-account pay-system needs a buyer balance anyway — "Insufficient funds").
 *  Flow confirmed live: add a product row → crm.item.payment.add → link the row
 *  (sets the sum) → leave unpaid. Idempotent: keeps a single unpaid payment that
 *  already carries a sum; drops empty/leftover payments before recreating. */
async function ensureDealPayment(dealId, productId, amount) {
  const payments = extractPayments(await rest('crm.item.payment.list', { entityId: dealId, entityTypeId: 2 }))
  // Already have the fixture we want — one unpaid payment with a real sum.
  if (payments.some(p => p.paid !== 'Y' && Number(p.sum) > 0)) {
    log(`    ${C.dim}·${C.reset} неоплаченная оплата сделки уже есть (пропуск)`)
    return
  }
  // Drop empty/paid leftovers (e.g. a productless payment from an interrupted run)
  // so exactly one clean unpaid target remains.
  for (const p of payments) {
    await rest('crm.item.payment.delete', { id: p.id }).catch(() => {})
  }
  // Reuse the product row for THIS product if present, else add one.
  const rowsResp = await rest('crm.item.productrow.list', { filter: { '=ownerType': 'D', '=ownerId': dealId }, select: ['id', 'productId'] })
  let rowId = (rowsResp?.productRows || []).find(r => String(r.productId) === String(productId))?.id
  if (!rowId) {
    const pr = await rest('crm.item.productrow.add', { fields: { ownerType: 'D', ownerId: dealId, productId, price: amount, quantity: 1 } })
    rowId = pr?.productRow?.id
  }
  // Fresh payment → link the product row (sets the sum), leave UNPAID. Retry the link
  // once: a just-created payment is occasionally not yet resolvable ("Payment has not been found").
  const payId = await rest('crm.item.payment.add', { entityId: dealId, entityTypeId: 2 })
  try {
    await rest('crm.item.payment.product.add', { paymentId: payId, rowId, quantity: 1 })
  } catch {
    await sleep(1000)
    await rest('crm.item.payment.product.add', { paymentId: payId, rowId, quantity: 1 })
  }
  log(`    ${C.dim}·${C.reset} неоплаченная оплата сделки создана (id ${payId}, ${amount})`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Purge (cleanup): delete every CBATEST-tagged fixture.
// ─────────────────────────────────────────────────────────────────────────────

async function purge() {
  head('Purge — удаляю все CBATEST-фикстуры')
  // ORDER MATTERS — confirmed live: bank detail → requisite → company, all while
  // the parent COMPANY still exists (Bitrix grants delete access through it).
  // Deleting the company first orphans requisites/bank details BEYOND REST reach:
  // `get`/`delete` then return «Access denied» forever, yet the zombie bank detail
  // keeps turning up in RQ_ACC_NUM search. `crm.requisite.delete` already cascades
  // its bank details, but we delete the bank details explicitly first so the safe
  // order holds even if the cascade ever changes.
  const reqs = await rest('crm.requisite.list', { filter: { '%XML_ID': TAG + '_' }, select: ['ID'] })
  for (const r of reqs || []) {
    const banks = await rest('crm.requisite.bankdetail.list', { filter: { ENTITY_ID: r.ID }, select: ['ID'] })
    for (const b of banks || []) {
      await rest('crm.requisite.bankdetail.delete', { id: b.ID }).catch(e => warn(String(e.message)))
    }
    await rest('crm.requisite.delete', { id: r.ID }).catch(e => warn(String(e.message)))
    log(`  ${C.red}−${C.reset} requisite id=${r.ID} (+ ${(banks || []).length} bank details)`)
  }
  // Now the items: invoices (31), deals (2), companies (4), smart-process elements.
  // `%title` is a SUBSTRING match, so re-check the prefix in JS before deleting —
  // never touch a record that merely contains "[TEST] " somewhere in its name.
  const typeList = await rest('crm.type.list', { select: ['id', 'entityTypeId', 'title'] })
  const smartTypes = (typeList?.types || []).filter(t => (t.title || '').startsWith(T))
  const itemEntityTypes = [31, 2, 4, ...smartTypes.map(t => Number(t.entityTypeId))]
  for (const et of itemEntityTypes) {
    const found = await rest('crm.item.list', { entityTypeId: et, filter: { '%title': T }, select: ['id', 'title'] })
    for (const it of (found?.items || []).filter(i => String(i.title || '').startsWith(T))) {
      // A deal with active payments can't be deleted («У заказа есть активные
      // оплаты») — remove its payments first. A PAID payment can't be deleted
      // either without first cancelling it, and cancelling needs the `sale` scope
      // (this webhook is `crm`-only → `insufficient_scope`). So an UNPAID payment
      // is removed here; a PAID one blocks deal deletion — we warn and skip rather
      // than crash. Grant the webhook `sale` scope (or delete the deal in the UI)
      // to fully purge such deals.
      if (et === 2) {
        const pl = await rest('crm.item.payment.list', { entityId: it.id, entityTypeId: 2 })
        for (const p of extractPayments(pl)) {
          await rest('crm.item.payment.delete', { id: p.id }).catch(e => warn(`payment ${p.id}: ${e.message}`))
        }
      }
      try {
        await rest('crm.item.delete', { entityTypeId: et, id: it.id })
        log(`  ${C.red}−${C.reset} item et=${et} id=${it.id}`)
      } catch (e) {
        warn(`item et=${et} id=${it.id} не удалён: ${e.message}`)
      }
    }
  }
  // Deal directions (crm.category on system type 2) are NOT cascaded by anything —
  // delete our tagged pipelines explicitly. Smart-process categories DO go away
  // with their type (crm.type.delete below), so only entityTypeId=2 needs this.
  const dealCats = await rest('crm.category.list', { entityTypeId: 2 })
  for (const c of (dealCats?.categories || []).filter(c => String(c.name || '').startsWith(T))) {
    await rest('crm.category.delete', { entityTypeId: 2, id: c.id }).catch(e => warn(String(e.message)))
    log(`  ${C.red}−${C.reset} воронка сделок id=${c.id} «${c.name}»`)
  }
  for (const t of smartTypes) {
    // crm.type.delete needs the type `id` (7, 9…), NOT the entityTypeId (1030…).
    await rest('crm.type.delete', { id: t.id }).catch(e => warn(String(e.message)))
    log(`  ${C.red}−${C.reset} СП «${t.title}» (entityTypeId ${t.entityTypeId})`)
  }
  const prods = await rest('crm.product.list', { filter: { '%XML_ID': TAG + '_' }, select: ['ID'] })
  for (const p of prods || []) {
    await rest('crm.product.delete', { id: p.ID }).catch(() => {})
    log(`  ${C.red}−${C.reset} product id=${p.ID}`)
  }
  ok(`Purge готов (${CALLS} REST-вызовов).`)
}

// ─────────────────────────────────────────────────────────────────────────────
// The fixture manifest — the actual test data.
// ─────────────────────────────────────────────────────────────────────────────

async function seed() {
  const created = {}

  head('0/6 · Валюта портала (BYN для выписок Беларуси)')
  await ensureCurrency('BYN')

  head('1/6 · Товары')
  created.prodInternal = await ensureProduct('PROD_IMPL', { name: T + 'Внедрение', price: 1500, currency: 'BYN' })
  created.prodLicense = await ensureProduct('PROD_LICENSE', { name: T + 'Лицензия', price: 500, currency: 'BYN' })

  head('2/6 · Мои компании (isMyCompany=Y, наш счёт для §2 Этап C)')
  created.my1 = await ensureItem(4, 'MY_1', { title: T + 'Моя компания Раз', isMyCompany: 'Y' }, { label: 'Моя компания Раз' })
  await ensureRequisiteWithBank(created.my1, 'MY_1', {
    presetId: 1, name: T + 'Моя компания Раз', account: 'BY04ALFA30129000000000009100', currency: 'BYN', bank: 'Альфа-Банк', bic: 'ALFABY2X'
  })
  created.my2 = await ensureItem(4, 'MY_2', { title: T + 'Моя компания Два', isMyCompany: 'Y' }, { label: 'Моя компания Два' })
  await ensureRequisiteWithBank(created.my2, 'MY_2', {
    presetId: 1, name: T + 'Моя компания Два', account: 'BY04ALFA30129000000000009200', currency: 'BYN', bank: 'Альфа-Банк', bic: 'ALFABY2X'
  })

  head('3/6 · Компании-клиенты (с реквизитами и без)')
  created.clientAlfa = await ensureItem(4, 'CO_ALFA', { title: T + 'Клиент Альфа' }, { label: 'Клиент Альфа (с реквизитами)' })
  await ensureRequisiteWithBank(created.clientAlfa, 'CO_ALFA', {
    presetId: 1, name: T + 'Клиент Альфа', account: 'BY04ALFA30129000000000009001', currency: 'BYN', bank: 'Альфа-Банк', bic: 'ALFABY2X'
  })
  created.clientBeta = await ensureItem(4, 'CO_BETA', { title: T + 'Клиент Бета (ИП)' }, { label: 'Клиент Бета (ИП, с реквизитами)' })
  await ensureRequisiteWithBank(created.clientBeta, 'CO_BETA', {
    presetId: 3, name: T + 'Клиент Бета', account: 'BY24PJCB30129000000000009002', currency: 'BYN', bank: 'Приорбанк', bic: 'PJCBBY2X'
  })
  created.clientGamma = await ensureItem(4, 'CO_GAMMA', { title: T + 'Клиент Гамма (без реквизитов)' }, { label: 'Клиент Гамма (без реквизитов — путь UNMATCHED)' })

  head('4/6 · Смарт-счета (инвойсы): оплачен / открытый / просрочен')
  const INV_CAT = 11
  created.invPaid = await ensureItem(31, 'INV_PAID', {
    title: T + 'Счёт оплачен', accountNumber: 'СЧ-0001', categoryId: INV_CAT, stageId: 'DT31_11:P',
    companyId: created.clientAlfa, mycompanyId: created.my1, opportunity: 1000, currencyId: 'BYN'
  }, { label: 'Счёт СЧ-0001 (оплачен, DT31_11:P)' })
  created.invOpen = await ensureItem(31, 'INV_OPEN', {
    title: T + 'Счёт открытый', accountNumber: 'СЧ-0002', categoryId: INV_CAT, stageId: 'DT31_11:N',
    companyId: created.clientBeta, mycompanyId: created.my1, opportunity: 750, currencyId: 'BYN'
  }, { label: 'Счёт СЧ-0002 (открытый, DT31_11:N)' })
  created.invOverdue = await ensureItem(31, 'INV_OVERDUE', {
    title: T + 'Счёт не оплачен', accountNumber: 'СЧ-0003', categoryId: INV_CAT, stageId: 'DT31_11:D',
    companyId: created.clientAlfa, mycompanyId: created.my2, opportunity: 300, currencyId: 'BYN'
  }, { label: 'Счёт СЧ-0003 (Не оплачен DT31_11:D — SEMANTICS=F, исключается invoiceLookup)' })
  // NB: Bitrix enforces a UNIQUE invoice `accountNumber` portal-wide — two invoices
  // can't share a number, so invoiceLookup(number+company) matches at most one
  // invoice. Multi-candidate ambiguity for #109 only arises ACROSS entity kinds
  // (invoice vs deal payment), not among invoices. A second open invoice for the
  // same client, with its own number, for a distinct-target allocation test:
  created.invSecond = await ensureItem(31, 'INV_SECOND', {
    title: T + 'Счёт второй открытый', accountNumber: 'СЧ-0100', categoryId: INV_CAT, stageId: 'DT31_11:N',
    companyId: created.clientAlfa, mycompanyId: created.my1, opportunity: 640, currencyId: 'BYN'
  }, { label: 'Счёт СЧ-0100 (второй открытый, тот же клиент)' })

  head('5/6 · Сделки в разных направлениях (с оплатой-инвойсом и без)')
  const dealOpt = await ensureCategory(2, T + 'Направление Опт')
  const dealRetail = await ensureCategory(2, T + 'Направление Розница')
  created.dealOpt = await ensureItem(2, 'DEAL_OPT', {
    title: T + 'Сделка Опт', categoryId: dealOpt, opportunity: 1200, currencyId: 'BYN', companyId: created.clientAlfa
  }, { label: 'Сделка Опт (направление Опт)' })
  // A REAL paid payment on the deal (the #109 `deal-payment` target)…
  await ensureDealPayment(created.dealOpt, created.prodInternal, 1200)
  // …plus a paid invoice linked to the same deal (parentId2) — the invoice target.
  created.dealOptInvoice = await ensureItem(31, 'INV_DEAL_OPT', {
    title: T + 'Счёт по сделке Опт', accountNumber: 'СЧ-1200', categoryId: INV_CAT, stageId: 'DT31_11:P',
    companyId: created.clientAlfa, mycompanyId: created.my1, opportunity: 1200, currencyId: 'BYN', parentId2: created.dealOpt
  }, { label: 'Счёт по сделке Опт (СЧ-1200, оплачен, привязан к сделке)' })
  created.dealRetail = await ensureItem(2, 'DEAL_RETAIL', {
    title: T + 'Сделка Розница (без оплаты)', categoryId: dealRetail, opportunity: 800, currencyId: 'BYN', companyId: created.clientBeta
  }, { label: 'Сделка Розница (направление Розница, без оплаты)' })
  created.dealGeneral = await ensureItem(2, 'DEAL_GENERAL', {
    title: T + 'Сделка Общая', categoryId: 0, opportunity: 999, currencyId: 'BYN', companyId: created.clientGamma
  }, { label: 'Сделка Общая (воронка по умолчанию)' })

  head('6/6 · Смарт-процессы (с направлениями и без) + элементы')
  const spFlags = {
    isCategoriesEnabled: 'N', isStagesEnabled: 'Y', isClientEnabled: 'Y',
    isMycompanyEnabled: 'Y', isLinkWithProductsEnabled: 'Y', isRecyclebinEnabled: 'Y'
  }
  const spNoDir = await ensureSmartType(T + 'СП без направлений', spFlags)
  created.spNoDir = spNoDir
  await ensureItem(spNoDir, 'SP_NODIR_1', {
    title: T + 'Элемент СП-1', opportunity: 400, currencyId: 'BYN', companyId: created.clientAlfa, mycompanyId: created.my1
  }, { label: 'Элемент СП без направлений #1' })

  const spDir = await ensureSmartType(T + 'СП с направлениями', { ...spFlags, isCategoriesEnabled: 'Y' })
  created.spDir = spDir
  const spCatA = await ensureCategory(spDir, T + 'Направление А')
  const spCatB = await ensureCategory(spDir, T + 'Направление Б')
  await ensureItem(spDir, 'SP_DIR_A', {
    title: T + 'Элемент СП напр. А', categoryId: spCatA, opportunity: 250, currencyId: 'BYN', companyId: created.clientAlfa, mycompanyId: created.my1
  }, { label: 'Элемент СП напр. А' })
  await ensureItem(spDir, 'SP_DIR_B', {
    title: T + 'Элемент СП напр. Б', categoryId: spCatB, opportunity: 260, currencyId: 'BYN', companyId: created.clientBeta, mycompanyId: created.my2
  }, { label: 'Элемент СП напр. Б' })

  return created
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only listing (--list): show what already exists on the portal.
// ─────────────────────────────────────────────────────────────────────────────

async function listExisting() {
  head('Существующие CBATEST-фикстуры')
  const types = await rest('crm.type.list', { select: ['entityTypeId', 'title'] })
  const smart = (types?.types || []).filter(t => (t.title || '').startsWith(T))
  for (const et of [4, 31, 2, ...smart.map(t => Number(t.entityTypeId))]) {
    const found = await rest('crm.item.list', { entityTypeId: et, filter: { '%title': T }, select: ['id', 'title'] })
    // `%title` is a substring match — keep only true "[TEST] " prefixes (same
    // guard purge uses, so --list mirrors exactly what --purge would remove).
    const items = (found?.items || []).filter(i => String(i.title || '').startsWith(T))
    log(`${C.cyan}entityTypeId ${et}${C.reset}: ${items.length} шт.`)
    for (const it of items) log(`  · id ${it.id} «${it.title}»`)
  }
  const prods = await rest('crm.product.list', { filter: { '%XML_ID': TAG + '_' }, select: ['ID', 'NAME'] })
  log(`${C.cyan}products${C.reset}: ${(prods || []).length} шт.`)
  for (const p of prods || []) log(`  · id ${p.ID} «${p.NAME}»`)
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const portal = WEBHOOK.replace(/\/rest\/.*/, '')
  head(`Тестовый портал: ${portal}  ·  режим: ${MODE}`)
  if (MODE === 'list') {
    await listExisting()
    return
  }
  if (MODE === 'purge') {
    await purge()
    return
  }
  await seed()
  head('Готово')
  ok(`Создано/обновлено фикстур, REST-вызовов: ${CALLS}.`)
  log(`${C.dim}Смотреть в портале: CRM → Компании/Счета/Сделки/Смарт-процессы, фильтр по «[TEST]».${C.reset}`)
  log(`${C.dim}Очистить: pnpm seed:b24 --purge${C.reset}`)
}

main().catch(e => die(e.stack || String(e)))
