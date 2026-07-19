// Pure presentational core for the «Распределение» UI tab (#109, PROCESSING.md §9.3 #4). Turns a
// payment carrier's amount + its distribution rows into a view-model the card-grid renders (formatted
// money, distributed/remaining, over-limit flag, per-row target labels). No I/O, no DOM — unit-tested;
// the backend read of the SP-ledger + the b24ui component are separate slices. Mirrors the
// sync-payments payment card (opportunity / needDistributionsSum / distributionsSum + over-limit).

import type { AllocationTargetKind } from '~/utils/allocation'
import type { AllocationSource, DistributionEntry, DistributionStatus } from '~/utils/manualAllocation'
import { distributionSummary } from '~/utils/manualAllocation'
import { formatMoney } from '~/utils/activity'

/** RU label per allocation target kind (CRM-internal — not payer text). Exhaustive over the kinds. */
const KIND_RU: Record<AllocationTargetKind, string> = {
  'invoice': 'смарт-счёт',
  'deal-payment': 'оплата сделки',
  'deal': 'сделка',
  'smart-process': 'смарт-процесс'
}

/** `смарт-счёт #123` — the target kind label + its CRM id. */
export function targetLabel(kind: AllocationTargetKind, id: string): string {
  return `${KIND_RU[kind] ?? kind} #${id}`
}

/** One distribution row as rendered in a payment card. */
export interface LedgerRowView {
  targetKind: AllocationTargetKind
  targetId: string
  /** `смарт-счёт #123`. */
  label: string
  amount: number
  /** Formatted amount + currency, e.g. `100,00 BYN`. */
  amountText: string
  source: AllocationSource
  status: DistributionStatus
  /** `status === 'active'` — a reverted row is shown struck-through / dimmed. */
  active: boolean
}

/** One payment carrier card: its total, how much is distributed / remains, and its rows. */
export interface PaymentLedgerView {
  total: number
  currency: string
  distributed: number
  remaining: number
  /** Active distributions exceed the total (over-allocated — a data/edit error to flag). */
  overLimit: boolean
  totalText: string
  distributedText: string
  remainingText: string
  rows: LedgerRowView[]
}

/** Append the currency code to a formatted amount (`100,00` → `100,00 BYN`). */
function money(amount: number, currency: string): string {
  const c = currency.trim()
  return c ? `${formatMoney(amount)} ${c}` : formatMoney(amount)
}

/**
 * Build the view-model for one payment carrier from its total + currency + distribution rows.
 * `distributed`/`remaining`/`overLimit` come from the shared `distributionSummary` (single source of
 * the money math), so the card agrees with what the ledger recompute wrote. Rows are presented in the
 * given order; a reverted row is kept (history) but marked inactive.
 */
export function presentPaymentLedger(total: number, currency: string, entries: readonly DistributionEntry[]): PaymentLedgerView {
  const summary = distributionSummary(total, currency, entries)
  const rows: LedgerRowView[] = entries.map(e => ({
    targetKind: e.targetKind,
    targetId: e.targetId,
    label: targetLabel(e.targetKind, e.targetId),
    amount: e.amount,
    amountText: money(e.amount, e.currency || currency),
    source: e.source,
    status: e.status,
    active: e.status === 'active'
  }))
  return {
    total: summary.total,
    currency,
    distributed: summary.distributed,
    remaining: summary.remaining,
    overLimit: summary.overLimit,
    totalText: money(summary.total, currency),
    distributedText: money(summary.distributed, currency),
    remainingText: money(summary.remaining, currency),
    rows
  }
}
