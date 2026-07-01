// Normalize a Priorbank Open Banking (СПР) transaction into our provider-agnostic
// StatementItem. Pure — no I/O — so it is shared by the frontend and the future
// backend, and unit-tested against a real sandbox sample (tests/priorStatement.test.ts).
//
// Source shape: an item of `data.transaction[]` from
// GET /accounts/{accountId}/transactions/{transactionListId} (see docs/PRIOR_API.md).
// The counterparty is the OTHER side of the operation: the payer (`debtor`) on an
// incoming credit (приход), the payee (`creditor`) on an outgoing debit (расход).

import type { NormalizeContext, OperationDirection, StatementItem, StatementNormalizer, StatementParty } from '~/types/statement'

/** A party (debtor/creditor) as Priorbank returns it. */
export interface PriorTxParty {
  name?: string
  organisationIdentification?: Array<{ code?: string, identification?: string }>
  privateIdentification?: Array<{ identification?: string }>
}

/** A party's account (`schemeName` e.g. BY.NBRB.IBAN / BY.NBRB.OTHER). */
export interface PriorTxAccount { schemeName?: string, identification?: string }

/** A party's bank (`identification` = BIC). */
export interface PriorTxAgent { identification?: string, name?: string }

/** One Priorbank transaction (the fields we map). */
export interface PriorTransaction {
  transactionId?: string
  number?: string
  /** 'Credit' (приход) | 'Debit' (расход). */
  creditDebitIndicator?: string
  status?: string
  bookingDateTime?: string
  valueDate?: string
  transactionDetails?: string
  /** Open Banking JSON may deliver the amount as a number or a string. */
  amount?: number | string
  currency?: string
  debtor?: PriorTxParty
  debtorAccount?: PriorTxAccount
  debtorAgent?: PriorTxAgent
  creditor?: PriorTxParty
  creditorAccount?: PriorTxAccount
  creditorAgent?: PriorTxAgent
}

/** Our own account the transactions belong to — the shared `NormalizeContext`.
 * `currency` fills in when a transaction omits it (Priorbank drops it when equal
 * to the account currency). */
export type PriorAccountContext = NormalizeContext

/** Пull the УНП/tax id out of a party's org/private identification. Priorbank
 * prefixes it (`INN191167894`); we keep the digits (BY УНП is 9 digits — length
 * is not validated here, a foreign counterparty may differ). Falls back to the
 * raw string if there are no digits. Reads `organisationIdentification` first,
 * then `privateIdentification` (physical-person counterparty). */
function extractUnp(party?: PriorTxParty): string {
  const raw = party?.organisationIdentification?.[0]?.identification
    ?? party?.privateIdentification?.[0]?.identification
    ?? ''
  const digits = raw.replace(/\D/g, '')
  return digits || raw
}

/**
 * Map one Priorbank transaction to a StatementItem. `ctx` carries our own
 * account number/currency. Direction: `Debit` → расход, anything else → приход.
 */
export function normalizePriorTransaction(tx: PriorTransaction, ctx: PriorAccountContext): StatementItem {
  const direction: OperationDirection = tx.creditDebitIndicator === 'Debit' ? 'debit' : 'credit'
  // Counterparty = payer on a credit, payee on a debit.
  const party = direction === 'credit' ? tx.debtor : tx.creditor
  const account = direction === 'credit' ? tx.debtorAccount : tx.creditorAccount
  const agent = direction === 'credit' ? tx.debtorAgent : tx.creditorAgent

  const counterparty: StatementParty = {
    name: party?.name ?? '',
    unp: extractUnp(party),
    account: account?.identification ?? '',
    ...(agent?.name ? { bank: agent.name } : {}),
    ...(agent?.identification ? { bic: agent.identification } : {})
  }

  // Coerce amount defensively: an Open Banking JSON may deliver it as a string;
  // never let NaN leak into downstream arithmetic (same guard as alfaStatement).
  const rawAmount = typeof tx.amount === 'number' ? tx.amount : Number(tx.amount ?? 0)

  return {
    account: ctx.account,
    docId: tx.transactionId ?? '',
    ...(tx.number ? { docNum: tx.number } : {}),
    direction,
    amount: Number.isFinite(rawAmount) ? rawAmount : 0,
    currency: tx.currency ?? ctx.currency ?? '',
    purpose: tx.transactionDetails ?? '',
    counterparty,
    acceptDate: tx.bookingDateTime ?? '',
    ...(tx.valueDate ? { operDate: tx.valueDate } : {})
  }
}

/** Minimal shape of the transaction-list response we read. */
export interface PriorTransactionListResponse {
  data?: {
    accountId?: string
    transaction?: PriorTransaction[]
  }
}

/**
 * Normalize the whole transaction-list response for one account. `ctx.account`
 * is our account number (e.g. the IBAN from GET /accounts); if omitted it falls
 * back to the response's `accountId`.
 */
export function normalizePriorTransactionList(
  response: PriorTransactionListResponse,
  ctx: PriorAccountContext
): StatementItem[] {
  const txs = response?.data?.transaction ?? []
  const account = ctx.account || response?.data?.accountId || ''
  return txs.map(tx => normalizePriorTransaction(tx, { ...ctx, account }))
}

/** Prior's implementation of the unified `StatementNormalizer` contract
 * (`raw, ctx → StatementItem[]`). See app/types/statement.ts. */
export const normalizePrior: StatementNormalizer<PriorTransactionListResponse> = normalizePriorTransactionList
