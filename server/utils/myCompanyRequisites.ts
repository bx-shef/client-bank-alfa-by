// Does this portal have a company marked «моя» with at least one bank account in its requisites?
//
// WHY THIS IS A PRECONDITION AND NOT A SETTING (#493). On the first live run the portal answered
// «117 обработано, 117 не опознано, 0 создано» with a completely healthy transport. The cause was
// this and nothing else: `findMyCompanyByAccount` had nothing to find.
//
// It is tempting to read that as one missing setting among many. It is not. On a fresh portal the
// counterparties are not entered yet, so the CLIENT company is never found — never, not rarely —
// and «моя компания» is the only thing that keeps a payment inside the CRM at all (§2 Этап C, #91).
// Without it the app does not degrade, it silently does nothing: every payment from an unknown
// payer disappears, and the only evidence is a counter in a database the client cannot see.
//
// So the app must REFUSE the two entry points until it exists. Refusing is kinder than working:
// the connect flow asks the account owner for their internet-bank password and their consent to
// read the company's money — spending that on a setup that cannot produce a single record is the
// expensive mistake, not the inconvenience.
//
// Pure over an injected `RestCall`, like `companyLookup.ts` — unit-testable without a portal.

import { CRM_ENTITY_TYPE_COMPANY, type RestCall } from './companyLookup'

/** Cap on how many my-companies we resolve requisites for. A portal has one, occasionally a
 *  handful; a filter that somehow matched hundreds is a bug, and we would rather answer the
 *  question from the first few than fan out a REST call per row. */
export const MAX_MY_COMPANIES = 20

/** One «my company» with the account numbers stored on its requisites. */
export interface MyCompanyAccounts {
  companyId: string
  /** Numbers exactly as CRM stores them — NOT normalised. See the note on `accounts` below. */
  accounts: string[]
}

/** Pull ids out of a `crm.item.list` envelope (`{result:{items:[{id}]}}`). */
function itemIds(resp: Record<string, unknown>): string[] {
  const items = (resp?.result as Record<string, unknown> | undefined)?.items
  if (!Array.isArray(items)) return []
  return items.map(r => `${(r as Record<string, unknown>)?.id ?? ''}`).filter(Boolean)
}

/**
 * Find every company flagged `isMyCompany='Y'` together with the settlement accounts on its
 * requisites. Three REST calls, in the same order `companyLookup` walks in reverse:
 * my companies → their requisites → the bank details of those requisites.
 *
 * ⚠ Account numbers come back **exactly as CRM stores them**, spaces and all. That is deliberate:
 * the lookup that matters (`crm.requisite.bankdetail.list` filtered by `RQ_ACC_NUM`) compares the
 * stored value verbatim, so a requisite written as `BY00 BANK …` genuinely does not match a
 * statement's `BY00BANK…`. Normalising here would make the precondition pass while the actual
 * import still failed — a green check on a broken portal, which is worse than no check (#494).
 *
 * A transport error propagates: «could not ask» must never be reported as «not configured».
 */
export async function findMyCompanyAccounts(call: RestCall): Promise<MyCompanyAccounts[]> {
  const mine = await call('crm.item.list', {
    entityTypeId: CRM_ENTITY_TYPE_COMPANY,
    filter: { isMyCompany: 'Y' },
    select: ['id']
  })
  const companyIds = itemIds(mine).slice(0, MAX_MY_COMPANIES)
  if (!companyIds.length) return []

  const requisites = await call('crm.requisite.list', {
    filter: { ENTITY_TYPE_ID: CRM_ENTITY_TYPE_COMPANY, ENTITY_ID: companyIds },
    select: ['ID', 'ENTITY_ID']
  })
  const rows = Array.isArray(requisites?.result) ? requisites.result as Record<string, unknown>[] : []
  /** requisite id → owning company id, so a bank detail can be attributed back. */
  const owner = new Map<string, string>()
  for (const r of rows) {
    const id = `${r?.ID ?? ''}`
    const entity = `${r?.ENTITY_ID ?? ''}`
    if (id && entity) owner.set(id, entity)
  }
  // Companies with no requisite at all still count as «exists but unusable» — the caller needs to
  // tell «нет моей компании» from «есть, но без реквизитов», because the fix differs.
  const out = new Map<string, MyCompanyAccounts>(companyIds.map(id => [id, { companyId: id, accounts: [] }]))
  if (!owner.size) return [...out.values()]

  const details = await call('crm.requisite.bankdetail.list', {
    filter: { ENTITY_ID: [...owner.keys()] },
    select: ['ENTITY_ID', 'RQ_ACC_NUM', 'RQ_IIK']
  })
  const bank = Array.isArray(details?.result) ? details.result as Record<string, unknown>[] : []
  for (const d of bank) {
    const companyId = owner.get(`${d?.ENTITY_ID ?? ''}`)
    if (!companyId) continue
    // Both fields are checked because Belarusian portals fill one or the other — the SAME
    // either/or `companyLookup` walks when searching (`RQ_ACC_NUM` → `RQ_IIK` fallback), and it is
    // a fallback there, so it is a fallback here: one bank detail row is ONE account. Pushing both
    // when both are filled (which BY portals do) would put the same physical account on the
    // reconciliation screen twice, once of them inevitably as «банк его не отдаёт».
    //
    // ⚠ THE VALUE IS PUSHED UNTRIMMED. Trimming is only how we ask «is this field filled». A
    // requisite pasted as ` BY00BANK0001` keeps that space in CRM, and the search compares the
    // stored value byte for byte — so stripping it here would let the matrix report «сопоставлено»
    // for an account the import cannot find. That is the green-check-on-a-broken-portal outcome
    // this module's header calls worse than no check at all, and it is reached precisely by being
    // helpful.
    const raw = [d?.RQ_ACC_NUM, d?.RQ_IIK]
      .map(v => `${v ?? ''}`)
      .find(v => v.trim() !== '')
    if (raw !== undefined) out.get(companyId)?.accounts.push(raw)
  }
  return [...out.values()]
}

/**
 * Whether the precondition is met, and if not — WHY. The two failures are separate states because
 * the fix differs: one is «отметьте компанию своей», the other «допишите ей счёт», and telling an
 * admin the wrong one sends them to the wrong screen.
 *   `ok`         — a my-company with at least one settlement account exists;
 *   `no-company` — nothing is flagged «моя» at all;
 *   `no-account` — flagged, but no requisite carries a settlement account.
 */
export type MyCompanyGate = 'ok' | 'no-company' | 'no-account'

/** Classify the lookup result. Pure. */
export function myCompanyGate(companies: readonly MyCompanyAccounts[]): MyCompanyGate {
  if (!companies.length) return 'no-company'
  return companies.some(c => c.accounts.length > 0) ? 'ok' : 'no-account'
}

/** What to tell the admin. Text is user-facing (Russian) and names the ACTION, not the state —
 *  «no-account» is useless to someone who does not know where requisites live. */
export const MY_COMPANY_GATE_MESSAGE: Record<Exclude<MyCompanyGate, 'ok'>, string> = {
  'no-company': 'В CRM нет компании, отмеченной как «моя». Без неё платежам не на что приземлиться: '
    + 'на новом портале контрагенты ещё не заведены, поэтому плательщик не определяется, и операция '
    + 'не сохранится никуда. Откройте карточку своей компании в CRM, включите признак «Моя компания» '
    + 'и добавьте в реквизиты расчётный счёт.',
  'no-account': 'У вашей компании в CRM нет реквизита с расчётным счётом. Приложение ищет компанию '
    + 'именно по номеру счёта, поэтому без него операции не привяжутся. Добавьте счёт в реквизиты — '
    + 'ровно в том виде, в каком он приходит из банка, без лишних пробелов.'
}
