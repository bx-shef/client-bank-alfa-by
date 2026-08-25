// Ручное отключение НЕРАБОЧЕГО банк-подключения оператором (#599) — чистое ядро.
//
// ЗАЧЕМ. Уборщик (#599 A) сносит мёртвые строки сам, но по порогу в недели. Оператор, увидев на
// `/queues` кривое подключение, может убрать его сразу — и тогда клиенту в чат ошибок уходит
// пометка «отключено из-за проблемы такой-то, переподключите» (решение владельца), БЕЗ упоминания,
// что это сделал оператор вручную.
//
// ⚠ ГЕЙТ: отключить можно ТОЛЬКО подключение, которое приложение уже считает нерабочим
// (`bankDisconnectReason` вернул причину). Рабочее подключение клиента из операторской не трогаем
// никогда — иначе это способ тихо оборвать импорт живого клиента.
//
// ⚠ ПОРЯДОК: сперва УДАЛЯЕМ, и лишь на успехе шлём пометку. Иначе (уведомить → удаление не прошло)
// клиент получил бы сообщение «отключено» о том, что мы не отключили. Пометка — best-effort и НЕ
// влияет на исход удаления: чат ошибок может быть не настроен или недоступен.

import type { BankAccountInfo } from './bankTokenStore'
import { bankDisconnectReason, type BankDisconnectReason } from '../../app/utils/bankDisconnectNotice'

export interface BankDisconnectOpsDeps {
  now: () => number
  /** Строка по opaque id, или null. */
  getRow: (id: number) => Promise<BankAccountInfo | null>
  /** Удалить строку по id со сверкой ключа (`deleteBankTokenById`). */
  remove: (memberId: string, id: number, expectedAccountKey: string) => Promise<'removed' | 'gone' | 'stale'>
  /** Пометка в чат ошибок портала. Best-effort: НЕ бросает и не влияет на исход. */
  notify: (row: BankAccountInfo, reason: BankDisconnectReason) => Promise<void>
  /**
   * Когда подписка портала на REST ПЕРВЫЙ раз отказала (#614); `0` — не отказывала.
   *
   * ⚠ Нужна, потому что гейт «только нерабочее» здесь НЕДОСТАТОЧЕН. У портала с мёртвой подпиской
   * банковское подключение может быть совершенно ЖИВЫМ — сломана оплата Битрикса, а не доступ к
   * счёту. Без этой ветки оператор не смог бы отключить ровно тот случай, ради которого раздел и
   * заведён: клиент до приложения не доберётся (оно открывается внутри Битрикса) и сам не отключит.
   */
  subscriptionEndedAt?: (memberId: string) => Promise<number>
}

export interface BankDisconnectOpsResult {
  status: number
  body: Record<string, unknown>
}

export async function handleOpsBankDisconnect(deps: BankDisconnectOpsDeps, rawId: unknown): Promise<BankDisconnectOpsResult> {
  const id = Number(rawId)
  if (!Number.isInteger(id) || id <= 0) {
    return { status: 400, body: { error: 'id required' } }
  }
  const row = await deps.getRow(id)
  if (!row) return { status: 404, body: { error: 'подключение не найдено — обновите список' } }

  // ⚠ Только НЕРАБОЧЕЕ — ЛИБО портал с мёртвой подпиской. Живое подключение живого клиента из
  // операторской не отключаем никогда: это был бы способ тихо оборвать импорт.
  const bankReason = bankDisconnectReason(row, deps.now())
  const subEnded = bankReason ? 0 : ((await deps.subscriptionEndedAt?.(row.memberId)) ?? 0)
  const reason: BankDisconnectReason | null = bankReason ?? (subEnded > 0 ? 'subscription-ended' : null)
  if (!reason) {
    return { status: 409, body: { error: 'подключение сейчас рабочее — из операторской его не отключаем' } }
  }

  const res = await deps.remove(row.memberId, row.id, row.accountKey)
  if (res !== 'removed') {
    // `gone`/`stale`: строку уже отключили или переразметили. Пометку НЕ шлём — мы ничего не делали.
    return { status: 409, body: { error: 'список устарел — обновите и повторите' } }
  }

  // Удалили — теперь пометка клиенту (best-effort). Отказ чата не отменяет удаления.
  await deps.notify(row, reason)
  return { status: 200, body: { ok: true } }
}
