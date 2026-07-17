// Builds the params for a CONFIGURABLE timeline activity (crm.activity.configurable.add) —
// the SOLE carrier crm-sync writes an operation as (#259), replacing the removed simple
// crm.activity.todo.add. Unlike the todo activity, a configurable activity accepts an
// external-source marker (ORIGINATOR_ID + ORIGIN_ID) that crm.activity.list can FILTER by — so
// idempotency/dedup lives in Bitrix24 (search the marker before writing), with no DB store.
// Pure: takes a normalized statement item + the resolved CRM company, returns the params
// object; the REST call + result extraction live in server/utils/configurableActivityWrite.ts.
//
// The marker is OURS on OUR record (a brand-new activity we create), never a stamp on a
// client-owned deal/invoice field — see docs/PROCESSING.md §1. It requires app (OAuth) context
// and only the creating app can update it (crm.activity.configurable.add errors
// ERROR_WRONG_CONTEXT / ERROR_WRONG_APPLICATION) → can't be webhook-tested; live-smoke it with
// `pnpm activity:test` on an installed portal.

import type { StatementItem } from '~/types/statement'
import { dedupKey } from '~/utils/statement'
import {
  ACTIVITY_ORIGIN, CRM_OWNER_TYPE_COMPANY, buildActivityTitle,
  formatIsoDate, formatMoney, neutralizeBb, toPortalDeadline, type CrmCompanyRef
} from '~/utils/activity'

/** ORIGINATOR_ID we stamp on every configurable activity — our app namespace. The dedup
 *  search (crm.activity.list filter[ORIGINATOR_ID][ORIGIN_ID]) MUST pair this with ORIGIN_ID:
 *  crm.activity.list returns any portal activity carrying a given ORIGIN_ID, so filtering by
 *  ORIGIN_ID alone could false-match a client's own imported activity → a silent dedup skip.
 *  Scoping by our distinctive ORIGINATOR_ID namespace prevents that (docs/PROCESSING.md §1). */
export const ACTIVITY_ORIGINATOR_ID = ACTIVITY_ORIGIN

/** ORIGIN_ID = the operation key (account|docId, the shared `dedupKey`). Paired with
 *  ACTIVITY_ORIGINATOR_ID for the B24-side dedup search. (Strengthening this to a composite
 *  hash is the separate §1 follow-up — it "feeds the marker".) */
export function activityOriginId(item: Pick<StatementItem, 'account' | 'docId'>): string {
  return dedupKey(item)
}

/** The `fields` block of crm.activity.configurable.add (the fields we set). */
export interface ConfigurableActivityFields {
  /** Configurable-activity type discriminator — always 'CONFIGURABLE'. */
  typeId: string
  /** Open task (false), matching the todo path's incomplete-todo semantics. */
  completed: boolean
  /** Required — ISO 8601 datetime, TZ-stamped to the portal (UTC+3). */
  deadline: string
  /** Our app namespace (external-source id). */
  originatorId: string
  /** The operation key (external-element id) — the dedup marker. */
  originId: string
  /** Responsible user, when the company carries one (parity with the todo path). */
  responsibleId?: number
}

/** Params accepted by `crm.activity.configurable.add` (the subset we send). */
export interface ConfigurableActivityParams {
  ownerTypeId: number
  ownerId: number
  fields: ConfigurableActivityFields
  /** Non-empty layout is REQUIRED by the API (ERROR_EMPTY_LAYOUT otherwise). */
  layout: Record<string, unknown>
}

/** A single `text` content block (ContentBlockDto `type: 'text'`). */
function textBlock(value: string, multiline = false): Record<string, unknown> {
  return { type: 'text', properties: { value, multiline } }
}

/** A label→value row (`type: 'withTitle'` wrapping a `text` block). `title` is our trusted
 *  label; `value` is the (BB-neutralized) field. `inline` renders label+value on one line. */
function fieldBlock(title: string, value: string, inline = true): Record<string, unknown> {
  return { type: 'withTitle', properties: { title, block: textBlock(value), inline } }
}

/**
/** A body `logo` code. BodyDto marks `logo` required, and the official configurable-activity
 *  examples use `notification` — a built-in system logo. If a live portal ever rejects it,
 *  swap for another system code from `crm.timeline.logo.list` (e.g. `arrow-down`/`call`). */
const BODY_LOGO_CODE = 'notification'

/**
 * Build the configurable-activity `layout` DTO — validated against the official ContentBlockDto
 * / BodyDto structure (apidocs …/timeline/activities/configurable/structure/): a header title,
 * a body `logo` (required by BodyDto), then blocks — the purpose as a multiline `text` block and
 * each operation field as a `withTitle` (label→value) row. No footer buttons yet — the actionable
 * §6 buttons (e.g. «повторно поискать клиента») register app actions and land in a follow-up; the
 * top-level `icon` is omitted (optional). Header + logo + non-empty blocks is a valid layout.
 *
 * SECURITY: purpose / counterparty name / account / document number come from the bank
 * statement — controlled by whoever SENDS the payment. They are BB-neutralized (same guard as
 * the chat path) before entering the card, defensively: even if a block renders markup, a
 * crafted value can't inject it. Our own labels/amounts/dates are trusted and left as-is.
 */
export function buildConfigurableLayout(item: StatementItem): Record<string, unknown> {
  const cp = item.counterparty
  const kind = item.direction === 'credit' ? 'Приход' : 'Расход'
  const doc = item.docNum
    ? `#${neutralizeBb(item.docNum)} от ${formatIsoDate(item.acceptDate)}`
    : `от ${formatIsoDate(item.acceptDate)}`
  const blocks: Record<string, unknown> = {
    purpose: textBlock(neutralizeBb(item.purpose), true),
    amount: fieldBlock(kind, `${formatMoney(item.amount)} ${item.currency}`),
    document: fieldBlock('Документ', doc),
    counterparty: fieldBlock('Контрагент', neutralizeBb(cp.name), false),
    unp: fieldBlock('УНП', neutralizeBb(cp.unp)),
    account: fieldBlock('Счёт', neutralizeBb(cp.account))
  }
  if (cp.bank) blocks.bank = fieldBlock('Банк', neutralizeBb(cp.bank))
  return {
    header: { title: neutralizeBb(buildActivityTitle(item)) },
    body: { logo: { code: BODY_LOGO_CODE }, blocks }
  }
}

/**
 * Build the `crm.activity.configurable.add` params for a statement item bound to a CRM
 * company. Carries the dedup marker (originatorId + originId) so the write is idempotent
 * against a B24-side search — and, because the marker is written ATOMICALLY with the
 * activity in a single call, there is no separate "remember" step and no write→remember gap.
 */
export function buildConfigurableActivity(item: StatementItem, company: CrmCompanyRef): ConfigurableActivityParams {
  return {
    ownerTypeId: CRM_OWNER_TYPE_COMPANY,
    ownerId: company.id,
    fields: {
      typeId: 'CONFIGURABLE',
      completed: false,
      deadline: toPortalDeadline(item.acceptDate),
      originatorId: ACTIVITY_ORIGINATOR_ID,
      originId: activityOriginId(item),
      ...(company.assignedById ? { responsibleId: company.assignedById } : {})
    },
    layout: buildConfigurableLayout(item)
  }
}
