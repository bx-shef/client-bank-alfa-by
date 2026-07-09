import type { StatementItem } from '~/types/statement'
import { buildActivityTitle, formatIsoDate, neutralizeBb } from '~/utils/activity'

// Builds the chat announcement text for one statement operation (posted to a B24
// chat via im.message.add). Pure: takes a normalized item, returns the message
// string. Whether an operation is announced at all is decided separately by
// `shouldNotifyChat` (app/utils/statement.ts); this only formats the text.
//
// Bitrix24 chat messages support BB-code formatting; we keep it minimal — a bold
// headline (direction + amount + counterparty) plus purpose and document date.
//
// SECURITY: the payment purpose and counterparty name/account come from the bank
// statement — i.e. they are controlled by whoever SENDS the payment, not by us.
// im.message.add renders BB-code (and previews URLs), so an external payer could
// inject `[url=…]`, `[user=…]` mentions, action buttons or break our `[b]` via a
// crafted purpose. `neutralizeBb` (shared from activity.ts — same guard the CRM
// activity uses) strips BB-code brackets from every interpolated external field before
// it reaches the message; the wrapper also sends URL_PREVIEW=N. Our own structural tags
// (`[b]…[/b]`) are added AFTER sanitizing.

/** One-line bold headline reused from the activity title, e.g.
 *  "Приход 1 840,00 BYN от ООО Ромашка". BB-neutralized (carries counterparty name). */
export function buildChatHeadline(item: StatementItem): string {
  return neutralizeBb(buildActivityTitle(item))
}

/**
 * The full chat message for an operation. Plain lines with a bold first line:
 *
 *   [b]Приход 1 840,00 BYN от ООО Ромашка[/b]
 *   Назначение: оплата по счёту №541
 *   Документ №541 от 26.06.2026
 *
 * `purpose`/`docNum` lines are omitted when empty. Deterministic, TZ-free.
 */
export function buildChatMessage(item: StatementItem): string {
  // `buildChatHeadline` is already BB-neutralized; wrap in our own bold tag after.
  const lines: string[] = [`[b]${buildChatHeadline(item)}[/b]`]

  const purpose = item.purpose.trim()
  if (purpose) lines.push(`Назначение: ${neutralizeBb(purpose)}`)

  const doc = item.docNum
    ? `Документ №${neutralizeBb(item.docNum)} от ${formatIsoDate(item.acceptDate)}`
    : `Документ от ${formatIsoDate(item.acceptDate)}`
  lines.push(doc)

  // Counterparty settlement account, for reconciliation:
  const account = item.counterparty.account.trim()
  if (account) lines.push(`Счёт: ${neutralizeBb(account)}`)

  return lines.join('\n')
}
