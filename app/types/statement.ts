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

// --- Unified statement interface -------------------------------------------
// The whole point of the domain core: every bank (Alfa online, Prior СПР, manual
// upload) is fetched differently but produces the SAME output — a StatementItem[].
// So the app is provider-agnostic. The interface is:
//
//   вход  (StatementQuery):  банк + счёт + диапазон дат
//   процесс:                 получить выписку у провайдера и разобрать её
//   выход (StatementItem[]): по операции — приход/расход, счёт+имя+УНП контрагента,
//                            сумма, валюта, дата операции, назначение платежа, docId (дедуп)
//
// A test feeds a provider's raw response (a fixture) into the provider's
// `StatementNormalizer` and asserts the resulting StatementItem[] — the exact
// data the app consumes. The fetch (I/O, per-provider) is verified separately.

/** Input of a statement request: which provider, which account, which date range.
 * Credentials/tokens are resolved separately (config + token store), not here. */
export interface StatementQuery {
  providerId: BankProviderId
  /** Our account number (or the provider's account id). */
  account: string
  /** Inclusive date range, ISO `YYYY-MM-DD`. */
  dateFrom: string
  dateTo: string
  /** Opaque pagination cursor from a previous `Statement.nextCursor`. */
  cursor?: string
}

/** Context a normalizer needs beyond the raw response: our own account and its
 * currency, for providers whose rows don't repeat them (e.g. Prior). Alfa rows
 * carry both, so it ignores this. */
export interface NormalizeContext {
  account: string
  currency?: string
}

/**
 * The unified contract every provider satisfies: a pure function from a
 * provider's raw statement response to normalized `StatementItem[]`. The INPUT
 * type differs per provider; the OUTPUT is identical — that identity is what
 * makes the app provider-agnostic and lets one test shape cover every bank.
 */
export type StatementNormalizer<TRaw = unknown> = (raw: TRaw, ctx: NormalizeContext) => StatementItem[]
