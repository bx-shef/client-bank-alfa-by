// Builds a UNIVERSAL timeline activity (`crm.activity.todo.add`) for one statement operation —
// the carrier replacing the configurable activity (#495).
//
// WHY THE CARRIER CHANGED. The configurable activity was chosen (#259) because it accepts the
// ORIGINATOR_ID/ORIGIN_ID marker in the SAME call that creates it, which made dedup atomic. It
// broke the company card on a live portal, and it also cannot express the three things a person
// actually reads at a glance: colour, deadline, and «not done». The neighbouring product walked
// exactly this path in reverse (`ai-price-import` #328) and lives on `todo.add` in production.
//
// ⚠ THE PRICE IS NAMED, NOT HIDDEN. `crm.activity.todo.add` does NOT accept the marker — it goes
// in a follow-up `crm.activity.update` (live-verified in the neighbouring product; the same is
// true of `DESCRIPTION_TYPE`, so both ride one update). That opens a window the configurable path
// did not have: activity created → process dies → no marker → the retry writes a SECOND activity
// and the first is invisible to dedup forever. The transport closes the common case by deleting
// the orphan when the update fails (see `todoActivityWrite.ts`); a hard crash between the two
// calls remains, and is the accepted cost of a card that works.
//
// SECURITY: purpose / counterparty name / account / document number are written by whoever SENT
// the payment. The description is BB-MARKUP here (unlike the configurable body, which was plain
// text blocks), so neutralisation is not defensive any more — it is load-bearing: an un-escaped
// `[URL=…]` in a payment purpose would become a real link inside the client's CRM card.

import type { StatementItem } from '~/types/statement'
import { dedupKey } from '~/utils/statement'
import {
  ACTIVITY_ORIGIN, CRM_OWNER_TYPE_COMPANY, buildActivityTitle,
  formatIsoDate, formatMoney, neutralizeBb, toPortalDeadline, type CrmCompanyRef
} from '~/utils/activity'

/** REST method that creates a universal timeline activity. */
export const TODO_ACTIVITY_ADD_METHOD = 'crm.activity.todo.add'
/** REST method that writes the marker + description type onto it afterwards. */
export const ACTIVITY_UPDATE_METHOD = 'crm.activity.update'
/** REST method used to remove an activity whose marker could not be written. */
export const ACTIVITY_DELETE_METHOD = 'crm.activity.delete'

/** ORIGINATOR_ID stamped on every activity — our app namespace. Unchanged from the configurable
 *  path on purpose: activities already written on live portals carry it, and the dedup search
 *  finds them by it. Renaming it would make every existing record foreign — a re-poll would
 *  write a second activity for every operation already imported. */
export const ACTIVITY_ORIGINATOR_ID = ACTIVITY_ORIGIN

/** ORIGIN_ID = the operation key (`account|docId`), same value the configurable path used. */
export function activityOriginId(item: Pick<StatementItem, 'account' | 'docId'>): string {
  return dedupKey(item)
}

/**
 * Activity colours (`colorId` — STRINGS, not numbers).
 *
 * ⚠ Taken from the neighbouring product, where the pair was confirmed by a human looking at a
 * portal (`4` = #8FB035 green, `7` = #DA7790 pink): REST echoes back whatever it stored, so no
 * amount of code can verify a shade.
 *
 * ⚠ Yellow has NO id — it is what you get by NOT sending `colorId`. So «colour not set» and
 * «colour is yellow» are indistinguishable on the portal, and a forgotten parameter would read as
 * a deliberate choice. Hence the colour is ALWAYS sent.
 *
 * Our mapping is by DIRECTION, not by «clean/with issues» as in the neighbour: money in is green,
 * money out is red. That is the one distinction a person scanning a timeline actually wants.
 */
export const TODO_COLOR_CREDIT = '4'
export const TODO_COLOR_DEBIT = '7'

/** `DESCRIPTION_TYPE = 3` — BB code.
 *  ⚠ `todo.add` has no parameter for it and the default is `2` (HTML), which renders BB markup as
 *  LITERAL TEXT — the reader would see `[B]Контрагент:[/B]` in every activity. It can only be set
 *  by `crm.activity.update`, which is the same call that carries the marker. */
export const DESCRIPTION_TYPE_BB = 3

/** Hard cap for the activity subject (portal field limit). */
export const MAX_TITLE_CHARS = 255

/** One `label: value` line of the description. Labels are ours (trusted); values are neutralised
 *  by the caller before they get here. */
function line(label: string, value: string): string {
  return `[B]${label}:[/B] ${value}`
}

/**
 * The BB description of one operation.
 *
 * Empty payer-controlled fields are DROPPED rather than rendered as an empty label — a физлицо
 * credit carries no УНП, a bank-fee row no purpose, and «УНП:» with nothing after it reads as a
 * bug in the app rather than as missing data at the bank.
 *
 * `note` (the unmatched-client reason, #91) leads the text: it explains why the operation is
 * sitting on THIS card, which is the first question its reader will have.
 */
export function buildActivityDescription(item: StatementItem, note?: string): string {
  const cp = item.counterparty
  const kind = item.direction === 'credit' ? 'Приход' : 'Расход'
  const parts: string[] = []
  if (note && note.trim()) parts.push(neutralizeBb(note.trim()), '')
  parts.push(line(kind, `${formatMoney(item.amount)} ${item.currency}`))
  parts.push(line('Документ', item.docNum
    ? `#${neutralizeBb(item.docNum)} от ${formatIsoDate(item.acceptDate)}`
    : `от ${formatIsoDate(item.acceptDate)}`))
  const name = neutralizeBb(cp.name)
  if (name) parts.push(line('Контрагент', name))
  const unp = neutralizeBb(cp.unp)
  if (unp) parts.push(line('УНП', unp))
  const account = neutralizeBb(cp.account)
  if (account) parts.push(line('Счёт', account))
  const bank = cp.bank ? neutralizeBb(cp.bank) : ''
  if (bank) parts.push(line('Банк', bank))
  const purpose = neutralizeBb(item.purpose)
  if (purpose) parts.push('', line('Назначение', purpose))
  return parts.join('\n')
}

/** Params accepted by `crm.activity.todo.add` (the subset we send). */
export interface TodoActivityParams {
  ownerTypeId: number
  ownerId: number
  deadline: string
  title: string
  description: string
  colorId: string
  responsibleId?: number
}

/**
 * Build the `crm.activity.todo.add` params for a statement item bound to a CRM company.
 *
 * ⚠ The activity is NEVER completed. The neighbouring product closes its clean imports; a payment
 * is different — it is something a person still has to act on (attach it, allocate it, check it),
 * and a closed activity reads as «done, nothing to see». An open one stays in the current-tasks
 * list and catches the eye without anyone reading it, which is the only signal that works
 * on a busy portal. `todo.add` creates an open activity by default, so this is a decision NOT to
 * add a completion flag — recorded here because its absence is otherwise invisible.
 */
export function buildTodoActivity(item: StatementItem, company: CrmCompanyRef, note?: string): TodoActivityParams {
  return {
    ownerTypeId: CRM_OWNER_TYPE_COMPANY,
    ownerId: company.id,
    deadline: toPortalDeadline(item.acceptDate),
    title: neutralizeBb(buildActivityTitle(item)).slice(0, MAX_TITLE_CHARS),
    description: buildActivityDescription(item, note),
    colorId: item.direction === 'credit' ? TODO_COLOR_CREDIT : TODO_COLOR_DEBIT,
    ...(company.assignedById ? { responsibleId: company.assignedById } : {})
  }
}

/**
 * Fields written by the ONE follow-up `crm.activity.update`: the dedup marker AND the description
 * type. Combined deliberately — two separate updates would double the portal round-trips per
 * operation, and at a hundred payments a day that is a hundred avoidable calls.
 */
export function buildActivityMarkerUpdate(item: Pick<StatementItem, 'account' | 'docId'>): Record<string, unknown> {
  return {
    DESCRIPTION_TYPE: DESCRIPTION_TYPE_BB,
    ORIGINATOR_ID: ACTIVITY_ORIGINATOR_ID,
    ORIGIN_ID: activityOriginId(item)
  }
}
