import type { StatementItem } from '~/types/statement'
import { dedupKey } from '~/utils/statement'

// Builds the payload for the universal CRM activity (`crm.activity.todo.add`),
// replacing the legacy `crm.activity.add` (provider) approach. Pure: takes a
// normalized statement item + the resolved CRM company, returns the params
// object. The actual REST call lives in the engine layer.

/** CRM owner type id for a Company (used as the activity owner). */
export const CRM_OWNER_TYPE_COMPANY = 4

/** Marker prefix embedded in the activity for traceability and our own dedup. */
export const ACTIVITY_ORIGIN = 'ShefClientBankAlfaBy'

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
 * Embedded in the description so duplicate activities can be detected by search
 * (the todo API has no native ORIGINATOR_ID/ORIGIN_ID dedup fields).
 */
export function activityOriginToken(item: Pick<StatementItem, 'account' | 'docId'>): string {
  return `[${ACTIVITY_ORIGIN}:${dedupKey(item)}]`
}

/** One-line activity title, e.g. "Приход 1 200.00 BYN от ООО Ромашка". */
export function buildActivityTitle(item: StatementItem): string {
  const verb = item.direction === 'credit' ? 'Приход' : 'Расход'
  const prep = item.direction === 'credit' ? 'от' : 'на'
  return `${verb} ${item.amount} ${item.currency} ${prep} ${item.counterparty.name}`.trim()
}

/** Readable multi-line activity description (plain text) with the dedup marker. */
export function buildActivityDescription(item: StatementItem): string {
  const cp = item.counterparty
  return [
    item.purpose,
    '',
    `${item.direction === 'credit' ? 'Приход' : 'Расход'}: ${item.amount} ${item.currency}`,
    item.docNum ? `Документ: #${item.docNum} от ${item.acceptDate}` : `Документ от ${item.acceptDate}`,
    '',
    `Контрагент: ${cp.name}`,
    `УНП: ${cp.unp}`,
    `р/сч: ${cp.account}`,
    cp.bank ? `Банк: ${cp.bank}` : '',
    '',
    activityOriginToken(item)
  ].filter(line => line !== '').join('\n')
}

/**
 * Build the `crm.activity.todo.add` params for a statement item bound to a CRM
 * company. `deadline` is the operation's acceptance date (the API requires it).
 */
export function buildTodoActivity(item: StatementItem, company: CrmCompanyRef): TodoActivityParams {
  return {
    ownerTypeId: CRM_OWNER_TYPE_COMPANY,
    ownerId: company.id,
    deadline: item.acceptDate,
    title: buildActivityTitle(item),
    description: buildActivityDescription(item),
    ...(company.assignedById ? { responsibleId: company.assignedById } : {})
  }
}
