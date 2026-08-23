// Post an ALLOCATION-error notice for one operation to the portal's error chat over a portal-bound
// RestCall (#109, PROCESSING.md §5). Pure over the injected `call` — unit-testable with a fake. The
// message text is built by the shared, tested builder in app/utils/allocationErrorMessage.ts; this
// module only hands it to `postChatMessage`, which picks the route (bot first, token owner as
// fallback — #496). Whether a decision warrants a notice is decided by the builder (it returns null
// for a clean allocate / none — then nothing is sent).

import type { StatementItem } from '../../app/types/statement'
import type { AllocationDecision } from '../../app/utils/allocation'
import { buildAllocationErrorMessage, buildSettingsErrorMessage, buildUnresolvedMessage } from '../../app/utils/allocationErrorMessage'
import { postChatMessage } from './chatNotifyWrite'
import type { RestCall } from './companyLookup'

/**
 * Send the error notice for `decision` about `item` to the error chat `dialogId`
 * and return the new message id, or null when there was nothing to send (the
 * builder returned null) or the API returned no id. The caller guarantees a
 * non-empty `dialogId`. A transport error from `call` propagates to the caller
 * (the worker swallows+logs it — a chat failure must never fail the job).
 */
export async function notifyAllocationErrorViaRest(
  item: StatementItem,
  decision: AllocationDecision,
  dialogId: string,
  call: RestCall,
  memberId?: string
): Promise<string | null> {
  const message = buildAllocationErrorMessage(item, decision)
  if (!message) return null
  return postChatMessage(dialogId, message, call, memberId)
}

/**
 * Сообщение «номер распознан, а цель не найдена» (#421) в чат ошибок. Тот же транспорт и тот же
 * контракт, что у `notifyAllocationErrorViaRest`: пустой список идентификаторов ⇒ ничего не шлём.
 */
export async function notifyUnresolvedViaRest(
  item: StatementItem,
  identifiers: readonly string[],
  dialogId: string,
  call: RestCall,
  truncated = false,
  memberId?: string
): Promise<string | null> {
  const message = buildUnresolvedMessage(item, identifiers, truncated)
  if (!message) return null
  return postChatMessage(dialogId, message, call, memberId)
}

/**
 * Сообщение «карта распознавания настроена неверно» (#572) в чат ошибок. Тот же транспорт и тот же
 * контракт: пустая причина ⇒ ничего не шлём.
 *
 * ⚠ Платёж сюда НЕ передаётся намеренно — это состояние настройки, одинаковое для всех операций
 * прогона, и вызывающий шлёт его ОДИН раз за прогон, а не на каждую операцию.
 */
export async function notifySettingsErrorViaRest(
  reason: string,
  dialogId: string,
  call: RestCall,
  memberId?: string
): Promise<string | null> {
  const message = buildSettingsErrorMessage(reason)
  if (!message) return null
  return postChatMessage(dialogId, message, call, memberId)
}
