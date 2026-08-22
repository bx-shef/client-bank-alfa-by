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
import type { RestCall } from './companyLookup'
import type { StatementItem, BankProviderId } from '../../app/types/statement'
import type { SpRef } from '../../app/config/distributionSp'
import { ACTIVITY_ORIGINATOR_ID, activityOriginId } from '../../app/utils/todoActivity'
import { itemRef } from '../../app/utils/activityBindings'
import { useServerLogger } from './serverLogger'
import { logSafe } from './logSafe'

// ⚠ СВОИ каналы, а не `[crm-sync]`. Тот канал по конвенции проекта означает ИТОГ ПРОГОНА, и его
// строки читает рантбук (`make poll-check` показывает последние восемь). Построчные сообщения
// дозаписи вытеснили бы оттуда сводку ровно в тот момент, когда оператор пришёл её читать: на
// портале со сломанным смарт-процессом их будет по одной на операцию.
const registryLog = useServerLogger('registry-write')
const bindLog = useServerLogger('activity-bind')

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
  /** Найти дело операции по маркеру — то же чтение, что и дедуп-гейт `crm-sync`. */
  findActivityId: (originatorId: string, originId: string, call: RestCall) => Promise<string | null>
  /** Привязать элемент к делу (тот же транспорт, что и синхронный путь). */
  bindActivity: (activityId: string, refs: CrmEntityRef[], call: RestCall) => Promise<BindingOutcome>
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
  let id: string
  try {
    id = await deps.writePaymentRegistry(job.item, job.companyId, job.providerId, job.paymentSp, call)
  } catch (e) {
    // Текст приходит ОТ ПОРТАЛА — в лог только через `logSafe` (PRIVACY.md §Логи). Синхронный
    // близнец в `worker.ts` делает ровно это; без обёртки сырая строка ушла бы в лог падений
    // джобы на КАЖДОЙ из восьми попыток.
    registryLog.error(`portal ${job.memberId}: дозапись реестра не удалась — ${logSafe(String((e as Error)?.message ?? e))}`)
    throw e
  }
  registryLog.info(`portal ${job.memberId}: элемент реестра дозаписан (${id})`)

  // ⚠ Привязка дела к дозаписанному элементу — здесь, и без неё починка была бы половинчатой.
  // Синхронный путь привязывал дело к элементу, которого в тот момент НЕ БЫЛО (запись упала), и
  // второй попытки у привязки не будет: она отсеется на маркере. То есть элемент появился бы, а
  // дойти до него из карточки платежа стало бы нельзя — навсегда и молча.
  //
  // ⚠ Дело ищем по маркеру, а не носим его id в задаче: на момент постановки его ещё не
  // существовало (реестр пишется ДО дела). Нет дела — выходим тихо: следующий прогон запишет его
  // сам и там же привяжет элемент, который уже создан.
  const activityId = await deps.findActivityId(ACTIVITY_ORIGINATOR_ID, activityOriginId(job.item), call)
  if (!activityId) return
  const ref = itemRef(job.paymentSp.entityTypeId, id)
  if (!ref) return
  const outcome = await deps.bindActivity(activityId, [ref], call)
  if (outcome.failed > 0) {
    throw new Error(`registry retry: element ${id} written but not bound to activity ${activityId} — retry`)
  }
}

export interface ActivityBindJobDeps {
  resolvePortalCall: (memberId: string) => Promise<RestCall | null>
  /** ⚠ БЕЗ батча: порт намеренно не принимает его вовсе (см. `handleActivityBindJob`). Поле
   *  «необязательный батч» здесь читалось бы как поддерживаемая возможность, и следующий читатель
   *  однажды её включил бы, вернув halt-on-error ровно туда, где он вреден. */
  bindActivity: (activityId: string, refs: CrmEntityRef[], call: RestCall) => Promise<BindingOutcome>
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
  bindLog.info(`portal ${job.memberId}: привязки дела ${logSafe(job.activityId)} доставлены (${outcome.bound})`)
}
