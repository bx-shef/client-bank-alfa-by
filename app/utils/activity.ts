import type { StatementItem } from '~/types/statement'
import { dedupKey } from '~/utils/statement'

// Builds the payload for the universal CRM activity (`crm.activity.todo.add`),
// replacing the legacy `crm.activity.add` (provider) approach. Pure: takes a
// normalized statement item + the resolved CRM company, returns the params
// object. The actual REST call lives in the engine layer.

/** CRM owner type id for a Company. Standard Bitrix24 entityTypeId: Lead=1,
 * Deal=2, Contact=3, Company=4. */
export const CRM_OWNER_TYPE_COMPANY = 4

/** Marker prefix embedded in the activity for traceability and our own dedup. */
export const ACTIVITY_ORIGIN = 'ShefClientBankAlfaBy'

const moneyFormat = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Format an amount as a human-readable money string, e.g. `1 840,00`. */
export function formatMoney(amount: number): string {
  return moneyFormat.format(amount)
}

/**
 * Strip BB-code brackets from externally-sourced text so it can't inject markup into
 * the CRM record. Replaces `[`/`]` with lookalike full-width brackets so the literal
 * content stays readable. Idempotent (a second pass is a no-op).
 *
 * SECURITY: the payment purpose and counterparty name/account come from the bank
 * statement — controlled by whoever SENDS the payment, not by us. The Bitrix CRM
 * timeline can render BB-code, so a payer could inject `[url=…]`/`[user=…]`/buttons via
 * a crafted purpose. Every external field is neutralized before it reaches the activity
 * title/description (same guard the chat path in chatMessage.ts uses — this is its home,
 * shared to avoid a chatMessage↔activity import cycle).
 */
export function neutralizeBb(s: string): string {
  return s.replace(/\[/g, '［').replace(/\]/g, '］')
}

/** Format the date part of an ISO 8601 string as `DD.MM.YYYY` (deterministic,
 * TZ-free — operates on the date prefix, not a Date object). */
export function formatIsoDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
}

/** Bitrix24 portal timezone offset — Belarus is UTC+3 (no DST). */
export const PORTAL_TZ_OFFSET = '+03:00'

/**
 * Re-stamp an operation's `acceptDate` as a TZ-aware `deadline` in the portal's
 * timezone (UTC+3), so `crm.activity.todo.add` renders the correct calendar day.
 *
 * Bank operations are day-granular and their source dates are Belarus wall-clock
 * (client-bank/1C emit naive `YYYY-MM-DD[THH:MM:SS]`; Alfa a naive `…THH:MM:SS.mmm`;
 * Prior a `…+03:00`; demo/mock a bare UTC midnight). We take the wall-clock date (and
 * time, if present) from the prefix and attach `+03:00` — deterministic, no Date
 * object. A bare UTC value like `…T00:00:00.000Z` would otherwise be interpreted as
 * an instant that can render on a different day in the portal. Unknown formats pass
 * through unchanged.
 *
 * NB: any offset the source already carries is intentionally DISCARDED and replaced
 * with `+03:00` — correct only because every current normalizer emits Belarus-local
 * wall-clock (Prior's `bookingDateTime` is already `+03:00` in observed data). If a
 * source ever emits a non-`+03:00`/non-midnight-`Z` offset, normalize it to a true
 * instant at the source instead, or this could shift the rendered day (see #10/#90).
 */
export function toPortalDeadline(acceptDate: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?/.exec(acceptDate)
  if (!m) return acceptDate
  const time = m[2] ? (m[2].length === 5 ? `${m[2]}:00` : m[2]) : '00:00:00'
  return `${m[1]}T${time}${PORTAL_TZ_OFFSET}`
}

/** The minimal CRM company shape the builder needs. */
export interface CrmCompanyRef {
  id: number
  /** Responsible user id, used as the activity's responsible. */
  assignedById?: number
}

/** Params accepted by `crm.activity.todo.add` (the fields we set). */
export interface TodoActivityParams {
  ownerTypeId: number
  ownerId: number
  /** Required by the API — ISO 8601 datetime. */
  deadline: string
  title: string
  description: string
  responsibleId?: number
}

/**
 * Stable marker for one operation, e.g. `[ShefClientBankAlfaBy:BY..|123]`.
 * Embedded in the description so duplicate activities can be detected by a
 * plain substring search (the todo API has no native ORIGINATOR_ID/ORIGIN_ID
 * dedup fields). The `|` separator is intentional; search is `includes`, not regex.
 */
export function activityOriginToken(item: Pick<StatementItem, 'account' | 'docId'>): string {
  return `[${ACTIVITY_ORIGIN}:${dedupKey(item)}]`
}

/** One-line activity title, e.g. "Приход 1 840,00 BYN от ООО Ромашка". */
export function buildActivityTitle(item: StatementItem): string {
  const verb = item.direction === 'credit' ? 'Приход' : 'Расход'
  const prep = item.direction === 'credit' ? 'от' : 'на'
  return `${verb} ${formatMoney(item.amount)} ${item.currency} ${prep} ${item.counterparty.name}`.trim()
}

/** Readable multi-line activity description (plain text) with the dedup marker.
 * `null` entries are omitted; `''` entries are kept as blank separator lines. */
export function buildActivityDescription(item: StatementItem): string {
  const cp = item.counterparty
  const kind = item.direction === 'credit' ? 'Приход' : 'Расход'
  // Every externally-sourced field (payer-controlled) is BB-neutralized before it
  // enters the CRM timeline description — see `neutralizeBb`. Our own labels/amounts/
  // dates and the origin token are trusted and left as-is.
  const doc = item.docNum
    ? `Документ: #${neutralizeBb(item.docNum)} от ${formatIsoDate(item.acceptDate)}`
    : `Документ от ${formatIsoDate(item.acceptDate)}`

  const lines: Array<string | null> = [
    neutralizeBb(item.purpose),
    '',
    `${kind}: ${formatMoney(item.amount)} ${item.currency}`,
    doc,
    '',
    `Контрагент: ${neutralizeBb(cp.name)}`,
    `УНП: ${neutralizeBb(cp.unp)}`,
    `р/сч: ${neutralizeBb(cp.account)}`,
    cp.bank ? `Банк: ${neutralizeBb(cp.bank)}` : null,
    '',
    activityOriginToken(item)
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

/**
 * Build the `crm.activity.todo.add` params for a statement item bound to a CRM
 * company. `deadline` is the operation's acceptance date.
 *
 * `deadline` is re-stamped into the portal's timezone (UTC+3) via `toPortalDeadline`
 * so the activity renders on the operation's correct calendar day (a bare UTC value
 * could otherwise shift a day). Still TO BE VERIFIED on a live portal (#90).
 */
export function buildTodoActivity(item: StatementItem, company: CrmCompanyRef): TodoActivityParams {
  return {
    ownerTypeId: CRM_OWNER_TYPE_COMPANY,
    ownerId: company.id,
    deadline: toPortalDeadline(item.acceptDate),
    // Title carries the counterparty name (payer-controlled) — neutralize it too
    // (same guard the chat headline uses via buildChatHeadline).
    title: neutralizeBb(buildActivityTitle(item)),
    description: buildActivityDescription(item),
    ...(company.assignedById ? { responsibleId: company.assignedById } : {})
  }
}
