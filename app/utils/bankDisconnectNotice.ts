// Сообщение КЛИЕНТУ в чат ошибок, когда его нерабочее банк-подключение отключили (#599).
//
// ⚠ Контекст решения владельца: оператор видит на `/queues` кривые подключения и отключает их
// руками; клиенту в чат ошибок приходит пометка «отключено из-за проблемы такой-то — переподключите»,
// но БЕЗ упоминания, что это сделал оператор вручную (не нервировать клиента). Поэтому текст говорит
// про СОСТОЯНИЕ подключения, а не про наше действие: с точки зрения клиента подключение и так уже не
// работало, мы лишь называем причину и что делать.
//
// Чистый билдер (без I/O): транспорт — `chatNotifyWrite.postChatMessage` на токене портала.

import type { BankProviderId } from '~/types/statement'
import { BANK_LABELS } from '~/utils/bankLabels'
import { consentExpired, BANK_REFRESH_TTL_SEC, BANK_REFRESH_TTL_MEASURED, type ConnectionLike } from '~/utils/bankTokenLifetime'

/**
 * Почему подключение больше не работает — ровно те причины, которые «чинит человек»:
 *   `consent-expired` — истёк срок согласия банка (его дата);
 *   `refresh-dead`    — измеренный срok обновления вышел, банк не примет наш токен (Альфа);
 *   `no-refresh`      — банк не выдал токен продления вовсе.
 */
export type BankDisconnectReason = 'consent-expired' | 'refresh-dead' | 'no-refresh'

/**
 * Классифицировать причину смерти подключения, или `null`, если оно ЖИВО.
 *
 * ⚠ Порядок веток тот же, что у `connectionHealth`: согласие банка перекрывает всё (его дата
 * строже наших оценок). Затем «нет токена продления». Затем измеренный TTL (только Альфа —
 * догадка Приора причиной НЕ становится, как и в уборщике).
 */
export function bankDisconnectReason(c: ConnectionLike, nowMs: number): BankDisconnectReason | null {
  if (consentExpired(c, nowMs)) return 'consent-expired'
  if (!c.hasRefresh) return 'no-refresh'
  const ttlMs = (BANK_REFRESH_TTL_SEC[c.provider] ?? 0) * 1000
  if (ttlMs > 0 && BANK_REFRESH_TTL_MEASURED[c.provider] && Number.isFinite(c.connectedAt) && nowMs >= c.connectedAt + ttlMs) {
    return 'refresh-dead'
  }
  return null
}

const REASON_TEXT: Record<BankDisconnectReason, string> = {
  'consent-expired': 'истёк срок разрешения на доступ к счёту',
  'refresh-dead': 'банк перестал принимать наш доступ',
  'no-refresh': 'банк не выдал токен для продления доступа'
}

/**
 * Собрать текст пометки в чат ошибок.
 *
 * ⚠ Называет банк и счёт (это данные самого клиента, в его же чате — не ПДн для него) и что делать.
 * ⚠ НЕ говорит «оператор отключил вручную»: с точки зрения клиента подключение уже не работало.
 * ⚠ Внешнего текста тут нет: `accountKey` — наш валидированный `[A-Za-z0-9]`, плательщик его не
 *   контролирует, поэтому `neutralizeBb` не нужен.
 */
export function buildBankDisconnectNotice(provider: BankProviderId, accountKey: string, reason: BankDisconnectReason): string {
  const bank = BANK_LABELS[provider] ?? 'банк'
  return `Подключение к счёту ${accountKey} (${bank}) отключено: ${REASON_TEXT[reason]}. `
    + 'Чтобы возобновить импорт выписки, переподключите банк в настройках приложения — '
    + 'потребуется вход владельца счёта в интернет-банк.'
}
