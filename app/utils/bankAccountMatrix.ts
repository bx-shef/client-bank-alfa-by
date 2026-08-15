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
}

/** One account as CRM stores it, with its owning company. */
export interface CrmSideAccount {
  companyId: string
  /** VERBATIM from the requisite — see the note at the top of this file. */
  number: string
}

/** State of one row of the matrix. */
export type MatrixRowState =
  /** Present on both sides, byte-identical — the import will find this company. */
  | 'matched'
  /** ⚠ Present on both sides but written differently (spaces, case). The import will NOT find it. */
  | 'looks-same'
  /** In CRM, the bank does not report it — not connected, or belongs to another bank. */
  | 'crm-only'
  /** The bank reports it, CRM has no such requisite — payments on it will land nowhere. */
  | 'bank-only'

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
      rows.push({ state: 'crm-only', crm: c, connected: isConnected(c.number) })
      continue
    }
    usedBank.add(norm)
    // Byte-identical is the ONLY thing the CRM search will match. Anything else is a trap.
    const exact = c.number.trim() === bank.number.trim()
    rows.push({ state: exact ? 'matched' : 'looks-same', crm: c, bank, connected: isConnected(bank.number) })
  }

  for (const b of input.bank) {
    const norm = normalizeForCompare(b.number)
    if (usedBank.has(norm)) continue
    rows.push({ state: 'bank-only', bank: b, connected: isConnected(b.number) })
  }

  const order: Record<MatrixRowState, number> = { 'bank-only': 0, 'looks-same': 1, 'crm-only': 2, 'matched': 3 }
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
  }
}

/** True when nothing on the screen needs attention — used to decide whether to show the block at
 *  all in the compact view. */
export function matrixIsClean(rows: readonly MatrixRow[]): boolean {
  return rows.every(r => r.state === 'matched')
}
