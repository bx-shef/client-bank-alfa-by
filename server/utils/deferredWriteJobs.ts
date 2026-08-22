// Долговременная дозапись в CRM: элемент реестра платежей (#578) и привязки дела (#585).
//
// ЗАЧЕМ ОБЕ ЗДЕСЬ. Болезнь у них одна, и она названа в обоих issue: запись идёт ПОСЛЕ маркера
// дедупа (реестр — раньше дела, но его отказ проглатывается; привязки — прямо после маркера),
// поэтому повтор джобы `crm-sync` до них уже не дойдёт: операция отсеется на дедуп-гейте. Значит
// проглоченный отказ терял результат НАВСЕГДА, и единственный, кто об этом знал, — счётчик в строке
// итога. Лекарство одно на двоих: durable-очередь с backoff, как у триггера (#79).
//
// ⚠ Очереди при этом ДВЕ (см. `topology.ts`), а модуль один: общее здесь — правила, а не payload.
//
// ⚠ Оба обработчика БРОСАЮТ на неуспехе — это их способ сказать BullMQ «повтори». Проглатывание
// здесь означало бы очередь, которая всегда «успешна» и ничего не чинит.

import type { ActivityBindJob, RegistryWriteJob } from '../queue/topology'
import type { BindingOutcome } from './activityBindingsWrite'
import type { CrmEntityRef } from '../../app/utils/activityBindings'
import type { RestBatch, RestCall } from './companyLookup'
import type { StatementItem, BankProviderId } from '../../app/types/statement'
import type { SpRef } from '../../app/config/distributionSp'
import { useServerLogger } from './serverLogger'
import { logSafe } from './logSafe'

const log = useServerLogger('crm-sync')

export interface RegistryWriteJobDeps {
  /** Пер-портальный `RestCall`; `null` ⇒ токена нет ⇒ бросаем (ограниченный ретрай). */
  resolvePortalCall: (memberId: string) => Promise<RestCall | null>
  writePaymentRegistry: (
    item: StatementItem,
    companyId: string | null,
    provider: BankProviderId,
    paymentSp: SpRef,
    call: RestCall
  ) => Promise<string>
}

/**
 * Дозаписать элемент реестра платежей.
 *
 * ⚠ Сам писатель идемпотентен по маркеру операции И дописывает колонки элементу, который нашёл
 * (#578). Второе — несущее: к моменту повтора элемент мог быть создан ГОЛЫМ (разнесением или
 * прежним упавшим прогоном), и без дописывания задача «успешно» не делала бы ничего, а колонки не
 * появились бы уже никогда. Ровно та же ловушка, что описана в шапке `paymentRegistryWrite.ts`.
 *
 * ⚠ Портал без токена — это `throw`, а не тихий выход: приложение могли удалить, и тогда попытки
 * честно закончатся (их число ограничено), а не превратятся в вечный «успех».
 */
export async function handleRegistryWriteJob(job: RegistryWriteJob, deps: RegistryWriteJobDeps): Promise<void> {
  const call = await deps.resolvePortalCall(job.memberId)
  if (!call) throw new Error(`registry retry: no portal token for ${job.memberId} — retry (pending)`)
  const id = await deps.writePaymentRegistry(job.item, job.companyId, job.providerId, job.paymentSp, call)
  log.info(`portal ${job.memberId}: элемент реестра дозаписан (${id})`)
}

export interface ActivityBindJobDeps {
  resolvePortalCall: (memberId: string) => Promise<RestCall | null>
  /** Батч того же портала. Необязателен: при повторе он скорее вреден, см. ниже. */
  resolvePortalBatch?: (memberId: string) => Promise<RestBatch | null>
  bindActivity: (activityId: string, refs: CrmEntityRef[], call: RestCall, batch?: RestBatch) => Promise<BindingOutcome>
}

/**
 * Доставить привязки дела.
 *
 * ⚠ БЕЗ батча намеренно, хотя он у портала есть. Батч halt-on-error, а сюда мы приходим ровно
 * тогда, когда часть пар уже могла встать: первая же «уже привязано» (`ACTIVITY_IS_ALREADY_BOUND`,
 * замерено) уронила бы весь батч, и транспорт всё равно свалился бы на поштучный путь — то есть
 * лишний вызов на каждой попытке. Поштучный путь начинается с чтения `binding.list` и ставит
 * только недостающее, что здесь и требуется.
 *
 * ⚠ Пустой список — не повод бросать: это не сбой, а задача, которой нечего делать (например,
 * ссылки перестали быть валидными). Тихо завершаемся, иначе очередь копила бы вечные падения.
 */
export async function handleActivityBindJob(job: ActivityBindJob, deps: ActivityBindJobDeps): Promise<void> {
  if (job.refs.length === 0) return
  const call = await deps.resolvePortalCall(job.memberId)
  if (!call) throw new Error(`bindings retry: no portal token for ${job.memberId} — retry (pending)`)
  const outcome = await deps.bindActivity(job.activityId, job.refs, call)
  if (outcome.failed > 0) {
    throw new Error(`bindings retry: ${outcome.failed} of ${job.refs.length} not bound for activity ${logSafe(job.activityId)} — retry`)
  }
  log.info(`portal ${job.memberId}: привязки дела ${job.activityId} доставлены (${outcome.bound})`)
}
