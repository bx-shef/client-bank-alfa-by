// The «наш счёт ↔ счёт в банке» matrix (#494) — pure matching, no I/O.
//
// WHY A MATRIX AND NOT A TEXT FIELD. Today the admin TYPES the account number after connecting.
// Both sides are already known to the program: the CRM side sits in the requisites of companies
// flagged «моя», the bank side is returned by the bank itself. Asking a human to retype what can be
// shown as a list is not merely tedious — a one-character slip produces no error at all. Polling
// runs, operations arrive, `findMyCompany` finds nothing, and payments land nowhere. That is
// exactly what the first live run looked like.
//
// ⚠ THE HARD PART IS THE COMPARISON, NOT THE TABLE. The lookup that decides everything
// (`crm.requisite.bankdetail.list` filtered by `RQ_ACC_NUM`) compares the STORED value verbatim,
// and the statement side is stripped of whitespace before the search. So a requisite written as
// `BY00 BANK …` genuinely is a different account from the bank's `BY00BANK…` — the human sees one
// account, the program sees two. If this module «helpfully» normalised both sides for display, the
// screen would go green while the import stayed broken: a worse outcome than having no screen,
// because it converts an unanswered question into a wrong answer. Hence `looks-same` is its OWN
// state, never folded into `matched`.

import type { BankProviderId } from '~/types/statement'

/** How the statement side is normalised before the CRM search — the SAME rule as
 *  `normalizeAccount` in `server/utils/companyLookup.ts`, duplicated here because this module must
 *  stay free of server imports (it renders in the browser). Kept in sync by a test that imports
 *  both. */
export function normalizeForCompare(v: string): string {
  return v.replace(/\s+/g, '').trim().toUpperCase()
}

/** One account as the BANK reports it. */
export interface BankSideAccount {
  /** The number as the bank returns it (IBAN for both our banks). */
  number: string
  currency?: string
  /**
   * WHICH bank reported it. Not decoration — a portal may hold Alfa and Prior at once (that is the
   * designed behaviour), and an untagged list would let a Prior IBAN be offered as the account of
   * an Alfa connection. `account_key` is used LITERALLY as the `number=` parameter of Alfa's own
   * statement call, so accepting that suggestion would key the connection with a number Alfa has
   * never heard of and silently kill its polling — with no conflict raised, because the uniqueness
   * check is scoped per provider.
   */
  provider?: BankProviderId
}

/** One account as CRM stores it, with its owning company. */
export interface CrmSideAccount {
  companyId: string
  /** VERBATIM from the requisite — see the note at the top of this file. */
  number: string
}

/**
 * State of one row of the matrix:
 *   `matched`    — present on both sides, byte-identical; the import will find this company;
 *   `looks-same` — ⚠ present on both sides but written differently (spaces, case). One account to
 *                  a human, two to the program — the import will NOT find it;
 *   `crm-only`   — in CRM, the bank does not report it (not connected, or another bank);
 *   `bank-only`  — the bank reports it, CRM has no such requisite → payments land nowhere;
 *   `unchecked`  — ⚠ in CRM, and we NEVER GOT TO ASK: a bank failed to answer this run. Absence of
 *                  an answer is not an answer, and this state exists precisely so the screen cannot
 *                  pretend otherwise (see the note on `MatrixInput.bankIncomplete`).
 */
export type MatrixRowState = 'matched' | 'looks-same' | 'crm-only' | 'bank-only' | 'unchecked'

/**
 * Which states are something the admin must ACT on.
 *
 * ⚠ A `Record` over the union rather than a `!==` list at each call site: a new state then cannot
 * compile until someone has decided what it means, and the two consumers (the composable and the
 * component) cannot drift apart. They already had two hand-written copies of `state !== 'matched'`,
 * which is exactly how `unchecked` would have silently become «a problem to fix».
 */
export const MATRIX_ROW_ACTIONABLE: Record<MatrixRowState, boolean> = {
  'bank-only': true,
  'looks-same': true,
  'crm-only': true,
  // Nothing to do about either of these: one works, the other was never asked about.
  'unchecked': false,
  'matched': false
}

/** Rows that carry an instruction — the ones rendered in full. */
export function matrixProblems(rows: readonly MatrixRow[]): MatrixRow[] {
  return rows.filter(r => MATRIX_ROW_ACTIONABLE[r.state])
}

export interface MatrixRow {
  state: MatrixRowState
  /** CRM side, when there is one. */
  crm?: CrmSideAccount
  /** Bank side, when there is one. */
  bank?: BankSideAccount
  /** Whether this account currently has a stored connection (`bank_tokens`). */
  connected: boolean
}

export interface MatrixInput {
  crm: readonly CrmSideAccount[]
  bank: readonly BankSideAccount[]
  /** Account keys we already hold a token for. */
  connectedKeys: readonly string[]
  /**
   * ⚠ TRUE WHEN AT LEAST ONE CONNECTED BANK FAILED TO ANSWER this run (a lock timeout while the
   * token is being renewed is the common, self-healing case — #539). The bank side is then
   * INCOMPLETE, and a CRM account missing from it proves nothing.
   *
   * Without this flag the matrix stated the opposite of what it knew: every CRM account fell into
   * `crm-only` — «банк его не отдаёт», with an instruction to connect the bank — while the alert
   * directly above said the bank's list was unknown. A healthy portal was told to go fix healthy
   * requisites, in a screen that exists to stop exactly that.
   *
   * ⚠ REQUIRED, not optional-defaulting-to-false: forgetting to wire it must not silently restore
   * the old confident-wrong answer. Positive knowledge is unaffected — `bank-only`, `matched` and
   * `looks-same` all rest on a bank that DID report the account.
   */
  bankIncomplete: boolean
}

/**
 * Build the matrix. Rows come out in the order an admin should read them: problems first
 * (`bank-only`, then `looks-same`, then `crm-only`), working pairs last — a screen that leads with
 * everything being fine buries the one line that explains why nothing works.
 */
export function buildAccountMatrix(input: MatrixInput): MatrixRow[] {
  const connected = new Set(input.connectedKeys.map(normalizeForCompare))
  const isConnected = (n: string) => connected.has(normalizeForCompare(n))

  const bankByNorm = new Map<string, BankSideAccount>()
  for (const b of input.bank) bankByNorm.set(normalizeForCompare(b.number), b)

  const rows: MatrixRow[] = []
  const usedBank = new Set<string>()

  for (const c of input.crm) {
    const norm = normalizeForCompare(c.number)
    const bank = bankByNorm.get(norm)
    if (!bank) {
      // ⚠ «Банк его не отдаёт» is a claim about the bank's answer. With a provider in error there
      // is no answer to make a claim about, so the row says so instead of guessing.
      rows.push({
        state: input.bankIncomplete ? 'unchecked' : 'crm-only',
        crm: c,
        connected: isConnected(c.number)
      })
      continue
    }
    usedBank.add(norm)
    // Byte-identical is the ONLY thing the CRM search will match. Anything else is a trap.
    //
    // ⚠ NO `.trim()` HERE, and that is the whole point. A requisite pasted as ` BY00BANK0001`
    // (leading space — the same class of slip as the internal ones) is stored with that space, and
    // `crm.requisite.bankdetail.list` will not find it. Trimming before comparing would paint the
    // row green while the import stayed broken — the exact false answer this state exists to
    // prevent, just reached from the other end. `findMyCompanyAccounts` keeps the raw value for the
    // same reason; the bank side is edge-trimmed because a bank's padding is transport noise, not
    // something stored in anyone's CRM.
    const exact = c.number === bank.number
    rows.push({ state: exact ? 'matched' : 'looks-same', crm: c, bank, connected: isConnected(bank.number) })
  }

  for (const b of input.bank) {
    const norm = normalizeForCompare(b.number)
    if (usedBank.has(norm)) continue
    rows.push({ state: 'bank-only', bank: b, connected: isConnected(b.number) })
  }

  // Problems first, then what we could not check, then what works: the admin reads top-down and
  // must not have to scroll past healthy rows to reach the line that explains the breakage.
  const order: Record<MatrixRowState, number> = {
    'bank-only': 0, 'looks-same': 1, 'crm-only': 2, 'unchecked': 3, 'matched': 4
  }
  return rows.sort((a, b) => order[a.state] - order[b.state])
}

/** Per-state copy for the UI. `matched` carries no hint — a row that works needs no instructions. */
export const MATRIX_STATE_LABEL: Record<MatrixRowState, { title: string, hint: string }> = {
  'matched': {
    title: 'сопоставлено',
    hint: ''
  },
  'looks-same': {
    title: 'записан иначе',
    hint: 'В CRM и в банке это один счёт для человека, но РАЗНЫЙ для программы: поиск сравнивает '
      + 'номер посимвольно. Приведите реквизит к тому виду, в каком номер приходит из банка — '
      + 'без пробелов и в том же регистре, — иначе операции по нему не привяжутся.'
  },
  'crm-only': {
    title: 'банк его не отдаёт',
    hint: 'Счёт есть в реквизитах, но банк о нём не сообщил: он либо не подключён, либо относится '
      + 'к другому банку. Если по нему ждёте операции — подключите соответствующий банк.'
  },
  'bank-only': {
    title: 'нет в реквизитах',
    hint: 'Банк отдаёт этот счёт, а в реквизитах его нет. Операции по нему приедут и не найдут '
      + 'вашу компанию — то есть не приземлятся никуда. Добавьте номер в реквизиты своей компании.'
  },
  'unchecked': {
    title: 'проверить не удалось',
    hint: 'Банк сейчас не ответил, какие счета покрывает согласие, поэтому есть у него этот счёт '
      + 'или нет — неизвестно. Это НЕ проблема реквизита и обычно проходит само: повторите сверку '
      + 'через несколько секунд.'
  }
}

/**
 * True when nothing on the screen needs attention — used to decide whether to show the block at
 * all in the compact view.
 *
 * ⚠ `unchecked` is NOT clean, even though it is not actionable either. «Всё сходится» is a claim
 * about every row, and a row we could not check is not one we may vouch for. The screen stays open
 * next to the provider-error alert instead of closing over an unanswered question.
 */
export function matrixIsClean(rows: readonly MatrixRow[]): boolean {
  return rows.every(r => r.state === 'matched')
}
