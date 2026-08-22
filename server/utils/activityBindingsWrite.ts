// Транспорт привязок дела о платеже (#579). Чистый отбор — в `app/utils/activityBindings.ts`.
//
// ⚠ ЛУЧШИЕ УСИЛИЯ, а не обязательство, и это осознанный размен. Привязки ставятся ПОСЛЕ того, как
// дело создано и промаркировано, поэтому проброс отказа означал бы падение всей джобы уже с
// записанным делом: повтор упрётся в маркер, пройдёт операцию мимо — и привязки всё равно не
// поставит, зато отменит обработку ВСЕХ операций пачки после этой. Дело важнее связи (согласованный
// процесс, PROCESSING.md Этап D: «дело — всегда»), поэтому отказ считается и печатается в итоге
// прогона, а не рушит импорт.
//
// ⚠ Цена названа честно: непоставленная привязка теряется НАВСЕГДА — следующий опрос увидит маркер
// дела и до этого места не дойдёт. Тот же класс, что у реестра платежей (#575/#578), и лечится он
// тем же — долговременной очередью, а не ретраем на месте: заведено отдельной задачей #585.
//
// ЗАМЕРЕНО НА ЖИВОМ ПОРТАЛЕ (2026-08-22, `pnpm verify:bindings --oauth`) — оба факта несущие:
//
//   1. **Повторная привязка той же пары — ОШИБКА** (`ACTIVITY_IS_ALREADY_BOUND`, «Дело уже
//      привязано к этой сущности»). То есть «поставить ещё раз на всякий случай» нельзя: это
//      неотличимо от настоящего отказа, а через SDK до нас доезжает только локализованный ТЕКСТ
//      (`getErrorMessages()`), без кода. Поэтому повтор идёт не вслепую: сперва читаем
//      `binding.list` и ставим только недостающие. Один лишний вызов вместо разбора чужой строки,
//      которая завтра придёт на другом языке.
//   2. **Привязка к НЕСУЩЕСТВУЮЩЕЙ сущности отвечает `{result:true}`.** Портал молча принимает
//      `entityId`, которого нет. Значит «вызов не упал» не доказывает ничего, и единственная защита
//      — правильность самих ссылок: их собирает и валидирует чистый планировщик, а живая проверка
//      читает привязки обратно.
//
// ⚠ Тексты ошибок идут в лог через `logSafe`: они приходят ОТ ПОРТАЛА, а правило PRIVACY.md §Логи
// требует этого от любого внешнего текста (перевод строки внутри подделал бы соседнюю строку лога,
// а многокилобайтный текст съел бы измеренный бюджет объёма).
//
// ⚠ Батч берётся, когда он есть, и падает ЦЕЛИКОМ: `RestBatch` здесь halt-on-error, то есть одна
// плохая привязка уронит всю пачку. Отсюда и путь отступления выше: одна неадресуемая сущность не
// уносит остальные, а в НОРМАЛЬНОМ случае вызов остаётся один, а не четыре.

import { ACTIVITY_BINDING_LIST_METHOD, bindingKey, buildBindingCall, type CrmEntityRef } from '../../app/utils/activityBindings'
import type { RestBatch, RestCall } from './companyLookup'
import { logSafe } from './logSafe'
import { useServerLogger } from './serverLogger'

const log = useServerLogger('activity')

/** Сколько привязок поставлено и сколько не удалось. */
export interface BindingOutcome {
  bound: number
  failed: number
}

/** Ключ пары — ТОТ ЖЕ `bindingKey`, что у планировщика: своя копия формата разошлась бы молча. */
function key(entityTypeId: unknown, entityId: unknown): string {
  return bindingKey({ entityTypeId: Number(entityTypeId), entityId: Number(entityId) })
}

/**
 * Какие пары уже висят на деле.
 *
 * ⚠ Регистр ключей у портала ВЕРХНИЙ (`ENTITY_TYPE_ID`/`ENTITY_ID` — замерено), но читаем оба
 * написания: метод старый, а расхождение регистра между поколениями REST в этом проекте уже
 * встречалось (`placement.options`). Ошибка чтения = пустой набор, то есть попробуем поставить
 * всё — худшее, что случится, это «уже привязано» на части пар.
 */
async function existingBindings(activityId: number, call: RestCall): Promise<Set<string>> {
  const resp = await call(ACTIVITY_BINDING_LIST_METHOD, { activityId })
  const rows = (resp?.result as Array<Record<string, unknown>> | undefined) ?? []
  const out = new Set<string>()
  for (const row of rows) {
    out.add(key(row.ENTITY_TYPE_ID ?? row.entityTypeId, row.ENTITY_ID ?? row.entityId))
  }
  return out
}

/**
 * Привязать дело `activityId` к сущностям `refs`.
 *
 * Пустой список — ноль вызовов и ноль отказов: «нечего привязывать» это штатный исход (клиент не
 * опознан, реестра нет, цель не найдена), а не сбой.
 */
export async function bindActivityViaRest(
  activityId: string,
  refs: CrmEntityRef[],
  call: RestCall,
  batch?: RestBatch
): Promise<BindingOutcome> {
  const commands = refs.map(ref => buildBindingCall(activityId, ref)).filter(c => c !== null)
  if (commands.length === 0) return { bound: 0, failed: 0 }

  if (batch) {
    try {
      await batch(commands.map(c => ({ method: c.method, params: c.params })))
      return { bound: commands.length, failed: 0 }
    } catch (batchError) {
      // Halt-on-error: часть команд могла примениться, часть нет, и портал не говорит какая именно.
      log.warning(`привязки дела ${activityId}: батч отказал, повторяю поштучно — ${logSafe(String((batchError as Error)?.message ?? batchError))}`)
    }
  }

  // Уже стоящие пары пропускаем: повторная привязка — ошибка (замер выше), и без этого шага
  // успешно применённая половина батча вернулась бы сюда как «отказ».
  let already = new Set<string>()
  try {
    already = await existingBindings(Number(activityId), call)
  } catch (listError) {
    log.warning(`привязки дела ${activityId}: не удалось прочитать текущие — ${logSafe(String((listError as Error)?.message ?? listError))}`)
  }

  let bound = 0
  let failed = 0
  for (const command of commands) {
    if (already.has(key(command.params.entityTypeId, command.params.entityId))) {
      bound++
      continue
    }
    try {
      await call(command.method, command.params as unknown as Record<string, unknown>)
      bound++
    } catch (error) {
      failed++
      log.warning(`привязка дела ${activityId} к ${command.params.entityTypeId}:${command.params.entityId} не поставлена — ${logSafe(String((error as Error)?.message ?? error))}`)
    }
  }
  return { bound, failed }
}
