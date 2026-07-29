#!/usr/bin/env node
// Посев КОМПАНИЙ для ручной проверки импорта (dev-only, идемпотентно).
//
// Отличается от `seed:b24` (тот сеет всю фикстуру #109 — сделки, счета, СП, товары):
// здесь только компании с реквизитами и расчётными счетами, потому что для проверки
// «выписка → дело в карточке компании → смарт-процесс» нужны именно они.
//
//   pnpm seed:companies          # создать/обновить
//   pnpm seed:companies --list   # показать, что есть
//   pnpm seed:companies --purge  # удалить (порядок: банк-деталь → реквизит → компания)
//
// Состав: 2 «моих компании» (isMyCompany=Y — наши счета, с них платим и на них приходит),
// 5 компаний-клиентов и 5 компаний-подрядчиков. Счёт каждой компании — ключ, по которому
// приложение находит её в CRM (`RQ_ACC_NUM`), поэтому они же попадают в тестовую выписку
// (см. scripts/make-test-statement.mjs — он берёт номера отсюда).
//
// Хук — только из git-ignored `.env.b24test` (B24_TEST_WEBHOOK), в репозиторий не попадает.

import { loadDotEnv } from './lib/env.mjs'
import { httpRequest } from './lib/http.mjs'
import { C, die, head, log, ok, warn } from './lib/cli.mjs'
import { validateTestWebhook } from './lib/b24-seed-utils.mjs'

const args = process.argv.slice(2)
const MODE = args.includes('--purge') ? 'purge' : args.includes('--list') ? 'list' : 'seed'

loadDotEnv(['.env.b24test'], { explicit: false })
const WEBHOOK = validateTestWebhook(process.env.B24_TEST_WEBHOOK)
if (!WEBHOOK) {
  die('B24_TEST_WEBHOOK отсутствует или неверен. Впиши в .env.b24test:\n'
    + '  B24_TEST_WEBHOOK=https://<portal>.bitrix24.by/rest/<user>/<token>/\n'
    + '(файл в .gitignore — токен не коммитим).')
}

/** Свой тег, отдельный от CBATEST: чистка этого скрипта не должна сносить фикстуру #109. */
const TAG = 'CBACO'
const xid = suffix => `${TAG}_${suffix}`
const T = '[TEST] '

const sleep = ms => new Promise(r => setTimeout(r, ms))

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
    return j?.result
  }
}

/** Компания по title (у legacy-типов фильтр по xmlId не работает — title портативнее). */
async function ensureCompany(title, fields) {
  const found = await rest('crm.item.list', { entityTypeId: 4, filter: { title }, select: ['id', 'title'] })
  const existing = found?.items?.[0]
  if (existing) {
    await rest('crm.item.update', { entityTypeId: 4, id: existing.id, fields })
    log(`  ${C.dim}=${C.reset} ${title} (id ${existing.id}, обновлена)`)
    return existing.id
  }
  const created = await rest('crm.item.add', { entityTypeId: 4, fields: { ...fields, title } })
  const id = created?.item?.id
  ok(`${title} (id ${id}, создана)`)
  return id
}

/** Реквизит + банковский счёт. `RQ_ACC_NUM` — тот самый ключ, по которому companyLookup
 *  находит компанию по счёту плательщика из выписки. */
async function ensureRequisiteWithBank(companyId, suffix, { name, account, bank, bic, unp }) {
  const rqXml = xid(suffix + '_RQ')
  const bankXml = xid(suffix + '_BANK')
  const existRq = await rest('crm.requisite.list', { filter: { XML_ID: rqXml }, select: ['ID'] })
  let rqId = existRq?.[0]?.ID
  if (!rqId) {
    rqId = await rest('crm.requisite.add', {
      fields: {
        ENTITY_TYPE_ID: 4, ENTITY_ID: companyId, PRESET_ID: 1,
        NAME: name, RQ_COMPANY_NAME: name, RQ_INN: unp || '', ACTIVE: 'Y', XML_ID: rqXml
      }
    })
  }
  // Матчим банк-деталь по родительскому реквизиту: её XML_ID может пережить удалённый
  // реквизит и ложно закоротить проверку.
  const bankFields = {
    COUNTRY_ID: 4, NAME: bank, RQ_BANK_NAME: bank,
    RQ_ACC_NUM: account, RQ_BIC: bic, RQ_ACC_CURRENCY: 'BYN', ACTIVE: 'Y', XML_ID: bankXml
  }
  const existBank = await rest('crm.requisite.bankdetail.list', { filter: { ENTITY_ID: rqId }, select: ['ID'] })
  const bankId = existBank?.[0]?.ID
  if (bankId) await rest('crm.requisite.bankdetail.update', { id: bankId, fields: bankFields })
  else await rest('crm.requisite.bankdetail.add', { fields: { ENTITY_ID: rqId, ...bankFields } })
  log(`    ${C.dim}·${C.reset} счёт ${account} (${bank})`)
  return rqId
}

// ─────────────────────────────────────────────────────────────────────────────
// Состав фикстуры. Номера счетов — синтетические, но в белорусском формате:
// они же уходят в тестовую выписку, поэтому обязаны совпадать байт-в-байт.
// ─────────────────────────────────────────────────────────────────────────────

const ALFA = { bank: 'Альфа-Банк', bic: 'ALFABY2X' }
const PRIOR = { bank: 'Приорбанк', bic: 'PJCBBY2X' }

export const MY_COMPANIES = [
  { key: 'MY1', title: T + 'Моя компания Раз', account: 'BY04ALFA30129000000000001001', unp: '190000001', ...ALFA },
  { key: 'MY2', title: T + 'Моя компания Два', account: 'BY04ALFA30129000000000001002', unp: '190000002', ...ALFA }
]

export const CLIENTS = [
  { key: 'CL1', title: T + 'Клиент Ромашка', account: 'BY04ALFA30129000000000002001', unp: '191000001', ...ALFA },
  { key: 'CL2', title: T + 'Клиент Василёк', account: 'BY24PJCB30129000000000002002', unp: '191000002', ...PRIOR },
  { key: 'CL3', title: T + 'Клиент Одуванчик', account: 'BY04ALFA30129000000000002003', unp: '191000003', ...ALFA },
  { key: 'CL4', title: T + 'Клиент Подсолнух', account: 'BY24PJCB30129000000000002004', unp: '191000004', ...PRIOR },
  { key: 'CL5', title: T + 'Клиент Незабудка', account: 'BY04ALFA30129000000000002005', unp: '191000005', ...ALFA }
]

export const CONTRACTORS = [
  { key: 'CN1', title: T + 'Подрядчик Строймонтаж', account: 'BY04ALFA30129000000000003001', unp: '192000001', ...ALFA },
  { key: 'CN2', title: T + 'Подрядчик Электросети', account: 'BY24PJCB30129000000000003002', unp: '192000002', ...PRIOR },
  { key: 'CN3', title: T + 'Подрядчик Логистик', account: 'BY04ALFA30129000000000003003', unp: '192000003', ...ALFA },
  { key: 'CN4', title: T + 'Подрядчик Ремсервис', account: 'BY24PJCB30129000000000003004', unp: '192000004', ...PRIOR },
  { key: 'CN5', title: T + 'Подрядчик Техснаб', account: 'BY04ALFA30129000000000003005', unp: '192000005', ...ALFA }
]

async function seed() {
  head('1/3 · Мои компании (isMyCompany=Y)')
  for (const c of MY_COMPANIES) {
    const id = await ensureCompany(c.title, { isMyCompany: 'Y' })
    await ensureRequisiteWithBank(id, c.key, { name: c.title, account: c.account, bank: c.bank, bic: c.bic, unp: c.unp })
  }

  head('2/3 · Компании-клиенты')
  for (const c of CLIENTS) {
    const id = await ensureCompany(c.title, { isMyCompany: 'N' })
    await ensureRequisiteWithBank(id, c.key, { name: c.title, account: c.account, bank: c.bank, bic: c.bic, unp: c.unp })
  }

  head('3/3 · Компании-подрядчики')
  for (const c of CONTRACTORS) {
    const id = await ensureCompany(c.title, { isMyCompany: 'N' })
    await ensureRequisiteWithBank(id, c.key, { name: c.title, account: c.account, bank: c.bank, bic: c.bic, unp: c.unp })
  }

  ok(`Готово. REST-вызовов: ${CALLS}`)
  log(`${C.dim}Выписку под эти счета собери: pnpm make:statement${C.reset}`)
}

async function list() {
  head('Компании фикстуры')
  for (const c of [...MY_COMPANIES, ...CLIENTS, ...CONTRACTORS]) {
    const found = await rest('crm.item.list', { entityTypeId: 4, filter: { title: c.title }, select: ['id', 'title'] })
    const item = found?.items?.[0]
    log(item ? `  ${C.green}✓${C.reset} ${c.title} (id ${item.id}) · ${c.account}` : `  ${C.red}×${C.reset} ${c.title} — нет`)
  }
}

async function purge() {
  head('Удаление фикстуры')
  // ПОРЯДОК ВАЖЕН (подтверждено вживую): банк-деталь → реквизит → компания, пока компания жива.
  // Если снести компанию первой, реквизиты осиротеют вне досягаемости REST, и «зомби»-банк-деталь
  // навсегда испортит поиск компании по счёту.
  const reqs = await rest('crm.requisite.list', { filter: { '%XML_ID': TAG + '_' }, select: ['ID'] })
  for (const r of reqs || []) {
    const banks = await rest('crm.requisite.bankdetail.list', { filter: { ENTITY_ID: r.ID }, select: ['ID'] })
    for (const b of banks || []) await rest('crm.requisite.bankdetail.delete', { id: b.ID }).catch(e => warn(String(e.message)))
    await rest('crm.requisite.delete', { id: r.ID }).catch(e => warn(String(e.message)))
    log(`  ${C.red}−${C.reset} реквизит id=${r.ID} (+ ${(banks || []).length} счетов)`)
  }
  for (const c of [...MY_COMPANIES, ...CLIENTS, ...CONTRACTORS]) {
    const found = await rest('crm.item.list', { entityTypeId: 4, filter: { title: c.title }, select: ['id'] })
    const item = found?.items?.[0]
    if (!item) continue
    await rest('crm.item.delete', { entityTypeId: 4, id: item.id }).catch(e => warn(String(e.message)))
    log(`  ${C.red}−${C.reset} ${c.title} (id ${item.id})`)
  }
  ok(`Удалено. REST-вызовов: ${CALLS}`)
}

const run = MODE === 'purge' ? purge : MODE === 'list' ? list : seed
run().catch((e) => {
  die(String(e?.message ?? e))
})
