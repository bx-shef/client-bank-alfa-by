// GET /api/bank/matrix — both halves of the «наш счёт ↔ счёт в банке» screen (#494), plus the
// matrix computed from them. Pure over injected I/O (DI); the thin route wires live transports.
//
// The two halves come from opposite worlds and neither alone answers the admin's question:
//   CRM  — the settlement accounts on the requisites of companies flagged «моя» (§2 Этап C is the
//          only thing that keeps a payment inside the CRM when the payer is unknown);
//   BANK — what the bank's consent actually covers.
// The interesting rows are the ones present on ONE side only, or on both but written differently.
//
// AUTH is the same gate as the rest of `/api/bank/*`: portal installed → frame token proven for
// THAT domain (blocks X-B24-Domain spoofing) → ADMIN. Both halves are portal-wide financial
// identity; a non-admin has no business enumerating them.
//
// ⚠ The CRM half is read with the ADMIN'S OWN frame token, not the stored OAuth grant. That is
// deliberate: the caller has just been proven to be an admin of this portal, and using their token
// keeps the read inside the permissions they already have — a stored-grant read would answer for
// portals whose admin is looking at a stale page.

import type { CrmSideAccount, MatrixRow } from '../../app/utils/bankAccountMatrix'
import { buildAccountMatrix } from '../../app/utils/bankAccountMatrix'
import type { BankSideProviderResult } from './bankAccountList'
import type { MyCompanyAccounts } from './myCompanyRequisites'

export interface BankMatrixResult {
  status: number
  body: Record<string, unknown>
}

export interface BankMatrixDeps {
  memberIdByDomain: (domain: string) => Promise<string | null>
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
  /** «Мои компании» + the account numbers on their requisites, VERBATIM. */
  myCompanies: (domain: string, accessToken: string) => Promise<MyCompanyAccounts[]>
  /** What each connected bank reports, per provider (fail-soft: each may carry an `error`). */
  bankSide: (memberId: string) => Promise<BankSideProviderResult[]>
  /** Account keys the portal holds a token for (pending excluded). */
  connected: (memberId: string) => Promise<string[]>
}

export interface BankMatrixInput {
  accessToken: string
  domain: string
}

/** Flatten «my companies» into matrix rows. A company with no account contributes nothing here —
 *  that state is the `myCompany` row of the readiness screen (#493), not a matrix row. */
export function crmSideAccounts(companies: readonly MyCompanyAccounts[]): CrmSideAccount[] {
  const out: CrmSideAccount[] = []
  for (const c of companies) {
    for (const number of c.accounts) out.push({ companyId: c.companyId, number })
  }
  return out
}

export async function handleBankMatrix(deps: BankMatrixDeps, input: BankMatrixInput): Promise<BankMatrixResult> {
  const accessToken = input.accessToken?.trim() ?? ''
  const domain = input.domain?.trim() ?? ''
  if (!accessToken || !domain) {
    return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  }
  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed (no key)' } }

  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token for this portal' } }
  }
  if (!frame.isAdmin) {
    return { status: 403, body: { error: 'bank connections are administrator-only' } }
  }

  // The CRM half is the one that must be right: a transport failure here would render a screen
  // full of `bank-only` rows — «в реквизитах ничего нет» — which is an actively misleading answer
  // to «почему платежи не приземляются». So it fails loud (502) while the bank half fails soft.
  let crm: CrmSideAccount[]
  try {
    crm = crmSideAccounts(await deps.myCompanies(domain, accessToken))
  } catch {
    return { status: 502, body: { error: 'не удалось прочитать реквизиты «моих компаний» в CRM' } }
  }

  const providers = await deps.bankSide(memberId)
  const connectedKeys = await deps.connected(memberId)
  const bank = providers.flatMap(p => p.accounts)
  // ⚠ A provider that errored contributes NO accounts, so without this flag every CRM account
  // would be classified «банк его не отдаёт» — a confident claim about a question we never got to
  // ask. `listBankSideAccounts` only returns providers the portal actually connected, so this is
  // «a bank we asked stayed silent», never «Приор не подключён».
  const bankIncomplete = providers.some(p => Boolean(p.error))
  const rows: MatrixRow[] = buildAccountMatrix({ crm, bank, connectedKeys, bankIncomplete })

  return {
    status: 200,
    body: {
      rows,
      // Per-provider errors are reported separately from the rows: an empty bank side caused by a
      // failed request must not read as «банк не отдаёт ни одного счёта», which would send the
      // admin to fix requisites that are perfectly fine.
      providers: providers.map(p => ({ provider: p.provider, count: p.accounts.length, error: p.error ?? null }))
    }
  }
}
