// Builds the ERROR-chat message for an allocation decision that needs a human
// (#109, PROCESSING.md §5): an `ambiguous` allocation (auto-allocated to the
// smallest-id target, but other targets also matched — heads-up) or a `manual`
// one (amount candidates exist but none matches exactly → manual queue). Pure:
// takes the normalized item + the pure `AllocationDecision`, returns the message
// string, or null when the decision needs no error notice (a clean `allocate` or
// `none`). Sent to the portal's error chat by server/utils/allocationErrorNotify.
//
// SECURITY: same guard as chatMessage.ts — the operation's counterparty name and
// purpose come from the bank statement (payer-controlled), and im.message.add
// renders BB-code, so every interpolated external field is passed through
// `neutralizeBb` before it reaches the message; our own `[b]` tags are added after.
// Target kind/id are CRM-internal (from our lookup, not payer text) — safe as-is.

import type { StatementItem } from '~/types/statement'
import type { AllocationCandidate, AllocationDecision } from '~/utils/allocation'
import { buildActivityTitle, neutralizeBb } from '~/utils/activity'

/** Human label per target kind (§2 taxonomy). Exhaustive over AllocationTargetKind. */
const KIND_RU: Record<AllocationCandidate['kind'], string> = {
  'invoice': 'смарт-счёт',
  'deal-payment': 'оплата сделки',
  'deal': 'сделка',
  'smart-process': 'смарт-процесс'
}

/** `смарт-счёт #123` — CRM-internal kind + id (not payer-controlled). */
function targetLabel(c: Pick<AllocationCandidate, 'kind' | 'id'>): string {
  return `${KIND_RU[c.kind] ?? c.kind} #${c.id}`
}

/**
 * Error-chat message for a decision that needs attention, or null for one that
 * doesn't (clean `allocate` / `none`):
 *
 *   [b]⚠️ Неоднозначное разнесение[/b]        (ambiguous)
 *   Приход 1 840,00 BYN от ООО Ромашка
 *   Разнесли на смарт-счёт #12 (минимальный id), но подошли и другие цели:
 *   • оплата сделки #34
 *   Проверьте вручную.
 *
 *   [b]⚠️ Не удалось разнести автоматически[/b]  (manual)
 *   …headline…
 *   Нет точного совпадения по сумме — в очередь ручного разбора. Кандидаты:
 *   • смарт-счёт #7
 */
export function buildAllocationErrorMessage(item: StatementItem, decision: AllocationDecision): string | null {
  const headline = neutralizeBb(buildActivityTitle(item))

  if (decision.action === 'allocate' && decision.ambiguous) {
    return [
      '[b]⚠️ Неоднозначное разнесение[/b]',
      headline,
      `Разнесли на ${targetLabel(decision.target)} (минимальный id), но подошли и другие цели:`,
      ...decision.alternatives.map(a => `• ${targetLabel(a)}`),
      'Проверьте вручную.'
    ].join('\n')
  }

  if (decision.action === 'manual') {
    return [
      '[b]⚠️ Не удалось разнести автоматически[/b]',
      headline,
      'Нет точного совпадения по сумме — в очередь ручного разбора. Кандидаты:',
      ...decision.candidates.map(c => `• ${targetLabel(c)}`)
    ].join('\n')
  }

  // A clean single-target `allocate` (no ambiguity) or `none` needs no error notice.
  return null
}
