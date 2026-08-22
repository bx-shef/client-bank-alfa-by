// Привязки дела о платеже к сущностям CRM (#579, шаг 3 согласованного процесса).
//
// ЗАЧЕМ. Дело несёт РОВНО ОДНУ пару владельца (`ownerTypeId`/`ownerId`) — компанию клиента либо
// «мою компанию» как фолбэк. Значит из карточки платежа некуда дойти до того, что он закрыл, а из
// сущности списания — до платежа. Ровно ради этой связи дело и заводится.
//
// ⚠ Поле `BINDINGS` помечено `isReadOnly` — через `crm.activity.update` его НЕ поставить (замерено,
// #579). Единственный путь — отдельные вызовы `crm.activity.binding.add`, то есть плата за связь
// это дополнительные REST-вызовы. Поэтому здесь же живёт и отбор: что привязывать НЕ надо.
//
// ⚠ Владелец в список не попадает никогда. Портал уже держит эту пару на самом деле, и повторная
// привязка в лучшем случае бесполезна, а в худшем — ошибка, которую пришлось бы отличать от
// настоящей. Правило записано ОДИН раз, здесь, а не у каждого вызывающего.

import { CRM_OWNER_TYPE_COMPANY } from '~/utils/activity'
import { SMART_INVOICE_ENTITY_TYPE_ID } from '~/config/b24'
import type { AllocationCandidate } from '~/utils/allocation'

/** REST-метод привязки дела к сущности. Современное поколение (не устаревшее `crm.activity.*`). */
export const ACTIVITY_BINDING_ADD_METHOD = 'crm.activity.binding.add'
/** Чтение привязок — нужно живой проверке: запись сама по себе ничего не доказывает. */
export const ACTIVITY_BINDING_LIST_METHOD = 'crm.activity.binding.list'

/** `crm.enum.ownertype` сделки. Тот же литерал, что у триггера разнесения (`allocationMutation`). */
export const CRM_ENTITY_TYPE_DEAL = 2

/** Пара «тип сущности + id», которой адресуется привязка. */
export interface CrmEntityRef {
  entityTypeId: number
  entityId: number
}

/**
 * Потолок числа привязок на одно дело.
 *
 * ⚠ Это не защита от «слишком красиво»: каждая привязка — отдельный REST-вызов, а целей разнесения
 * у одной операции может быть много (неоднозначный платёж собирает всех кандидатов). Без потолка
 * одна операция с двумя десятками совпадений съедала бы бюджет портала за всю пачку.
 */
export const MAX_ACTIVITY_BINDINGS = 6

/** Положительное целое? (id из REST приходит строкой, и «12abc» обязано отвалиться.) */
function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Ссылка на компанию CRM — или `null`, если id непригоден. */
export function companyRef(id: string | number | null | undefined): CrmEntityRef | null {
  const entityId = positiveInt(id)
  return entityId === null ? null : { entityTypeId: CRM_OWNER_TYPE_COMPANY, entityId }
}

/** Ссылка на элемент смарт-процесса (реестр платежей, разнесение). */
export function itemRef(entityTypeId: number | null | undefined, id: string | number | null | undefined): CrmEntityRef | null {
  const etid = positiveInt(entityTypeId)
  const entityId = positiveInt(id)
  return etid === null || entityId === null ? null : { entityTypeId: etid, entityId }
}

/**
 * Сущность СПИСАНИЯ для цели разнесения — то, к чему платёж привязывают в карточке.
 *
 * ⚠ У `deal-payment` собственной сущности с лентой НЕТ: оплата сделки — это запись внутри сделки,
 * привязывать дело к ней некуда. Поэтому берём САМУ СДЕЛКУ (`dealId`), и это не подмена: человек,
 * открывший сделку, увидит платёж, который её закрыл, — а именно за этим он туда и идёт. Нет
 * `dealId` ⇒ `null`: выдумывать сделку по id записи оплаты нельзя, id-пространства разные.
 *
 * ⚠ `smart-process` несёт СВОЙ `entityTypeId` (портало-специфичный динамический тип), и без него
 * привязка неадресуема — угадать его нечем.
 */
export function allocationTargetRef(
  target: Pick<AllocationCandidate, 'kind' | 'id'> & { dealId?: string, entityTypeId?: number }
): CrmEntityRef | null {
  switch (target.kind) {
    case 'invoice':
      return itemRef(SMART_INVOICE_ENTITY_TYPE_ID, target.id)
    case 'deal':
      return itemRef(CRM_ENTITY_TYPE_DEAL, target.id)
    case 'deal-payment':
      return itemRef(CRM_ENTITY_TYPE_DEAL, target.dealId)
    case 'smart-process':
      return itemRef(target.entityTypeId, target.id)
  }
}

/** Ключ тождества привязки — по нему снимаются дубли (одна сущность, один вызов). */
function refKey(ref: CrmEntityRef): string {
  return `${ref.entityTypeId}:${ref.entityId}`
}

/**
 * Что реально надо привязать к делу: непустые ссылки, без владельца, без дублей, с потолком.
 *
 * Порядок ВХОДА значим — он же порядок записи, а потолок отсекает хвост. Вызывающий подаёт сперва
 * то, без чего связь бессмысленна (реестр платежей, сущность списания), и лишь затем компании:
 * компания клиента чаще всего и есть владелец, то есть отсеется здесь же.
 */
export function planActivityBindings(opts: {
  /** Пара, которую дело уже несёт само (владелец). */
  owner?: CrmEntityRef | null
  /** Кандидаты в порядке важности; `null`/`undefined` просто пропускаются. */
  refs: Array<CrmEntityRef | null | undefined>
  limit?: number
}): CrmEntityRef[] {
  const seen = new Set<string>()
  if (opts.owner) seen.add(refKey(opts.owner))
  const out: CrmEntityRef[] = []
  const limit = opts.limit ?? MAX_ACTIVITY_BINDINGS
  for (const ref of opts.refs) {
    if (!ref) continue
    const key = refKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
    if (out.length >= limit) break
  }
  return out
}

/** Описание одного вызова привязки — метод и параметры, без ввода-вывода. */
export function buildBindingCall(activityId: string | number, ref: CrmEntityRef): {
  method: string
  params: { activityId: number, entityTypeId: number, entityId: number }
} | null {
  const id = positiveInt(activityId)
  if (id === null) return null
  return {
    method: ACTIVITY_BINDING_ADD_METHOD,
    params: { activityId: id, entityTypeId: ref.entityTypeId, entityId: ref.entityId }
  }
}
