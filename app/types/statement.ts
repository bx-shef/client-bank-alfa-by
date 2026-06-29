// Domain model for bank statements. Provider-agnostic: Alfa (and later Prior /
// manual import) map their raw responses onto these shapes. Pure types only —
// no runtime, safe to share between the Nuxt frontend and the future backend.

/** Known bank-statement providers. `manual` = hand-uploaded statement files. */
export type BankProviderId = 'alfa-by' | 'prior-by' | 'manual'

/** Operation direction from the account owner's perspective. */
export type OperationDirection = 'credit' | 'debit' // credit = приход, debit = расход

/** A counterparty (плательщик/получатель) on a statement line. */
export interface StatementParty {
  /** Display name (corrName). */
  name: string
  /** Tax id (УНП / corrUnp). */
  unp: string
  /** Settlement account (р/счёт, corrNumber) — the CRM company lookup key. */
  account: string
  bank?: string
  bic?: string
}

/** A single statement operation, normalized across providers. */
export interface StatementItem {
  /** Our own account number the operation belongs to (used in the dedup key). */
  account: string
  /** Provider document id — together with `account` forms the idempotency key. */
  docId: string
  /** Human-facing document number, if any. */
  docNum?: string
  direction: OperationDirection
  /** Positive amount; `direction` carries the sign meaning. */
  amount: number
  /** ISO currency code, e.g. `BYN`. */
  currency: string
  /** Payment purpose (назначение платежа). */
  purpose: string
  counterparty: StatementParty
  /** Bank acceptance date, ISO 8601. */
  acceptDate: string
  /** Operation date, ISO 8601, if distinct from acceptDate. */
  operDate?: string
  /** Operation code label (operCodeName), if provided. */
  operCodeName?: string
}

/** A statement for one account from one provider. */
export interface Statement {
  providerId: BankProviderId
  account: string
  items: StatementItem[]
  /** Opaque cursor to fetch the next page, if the provider paginates. Absent =
   * no more pages. Pass back via `StatementQuery.cursor`. */
  nextCursor?: string
}
