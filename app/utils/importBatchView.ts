// Чистое ядро отображения итогов ручной загрузки (#417).
//
// Раньше `/import` отвечал «принято в обработку» и замолкал навсегда: запись в CRM идёт в фоне,
// и узнать её исход было нельзя. Здесь — решения, на которых держится опрос итога: когда его
// прекращать и что показывать сотруднику. Вынесено из компонента, потому что ошибиться легко в
// обе стороны: не остановить опрос — бесконечные запросы к порталу; остановить рано — сотрудник
// снова не узнает результата.

import type { ImportBatchResult } from '~/types/importBatch'
import { pluralRu } from '~/utils/importStatus'

/** Пауза между опросами. Обработка занимает секунды; чаще — бессмысленно, каждый запрос тянет
 *  за собой исходящий `profile` к порталу. */
export const POLL_INTERVAL_MS = 3000

/** Потолок ожидания. Дольше сотрудник всё равно не смотрит, а бесконечный опрос открытой вкладки
 *  превращается в фоновую нагрузку на портал. */
export const POLL_TIMEOUT_MS = 3 * 60 * 1000

/** Есть ли ещё чего ждать: известен НЕ каждый ключ, либо какой-то из них ещё в очереди. */
export function hasPending(ids: string[], results: ImportBatchResult[]): boolean {
  if (!ids.length) return false
  const byId = new Map(results.map(r => [r.batchId, r]))
  return ids.some((id) => {
    const r = byId.get(id)
    // Ключ, о котором сервер ещё ничего не знает, — тоже «ждём»: строка «принято» пишется
    // best-effort и могла не успеть до первого опроса.
    return !r || r.state === 'queued'
  })
}

/** Продолжать ли опрос: есть незавершённые И не вышел срок. */
export function shouldKeepPolling(ids: string[], results: ImportBatchResult[], elapsedMs: number): boolean {
  return hasPending(ids, results) && elapsedMs < POLL_TIMEOUT_MS
}

export interface BatchTotals {
  operations: number
  created: number
  notified: number
  unmatched: number
  failed: number
}

/** Свод по завершённым загрузкам (незавершённые в счётчики не идут — иначе итог «рос» бы на
 *  глазах и был бы неотличим от окончательного). */
export function totalsOf(results: ImportBatchResult[]): BatchTotals {
  const done = results.filter(r => r.state !== 'queued')
  return {
    operations: sum(done, r => r.operations),
    created: sum(done, r => r.created),
    notified: sum(done, r => r.notified),
    unmatched: sum(done, r => r.unmatched),
    failed: done.filter(r => r.state === 'error').length
  }
}

function sum(rows: ImportBatchResult[], pick: (r: ImportBatchResult) => number): number {
  return rows.reduce((acc, r) => acc + (Number.isFinite(pick(r)) ? pick(r) : 0), 0)
}

/**
 * Итоговая фраза для сотрудника. Отдельно называем `unmatched`: «записано 3 из 5» без объяснения
 * выглядит как потеря данных, хотя на деле у двух операций просто не нашлась компания.
 */
export function summaryMessage(results: ImportBatchResult[]): string {
  const t = totalsOf(results)
  if (!results.length) return ''
  const parts: string[] = []
  parts.push(`Разобрано операций: ${t.operations}`)
  parts.push(`записано в CRM: ${t.created}`)
  if (t.notified) parts.push(`отправлено в чат: ${t.notified}`)
  if (t.unmatched) {
    const w = pluralRu(t.unmatched, ['операции', 'операций', 'операций'])
    parts.push(`без компании-плательщика: ${t.unmatched} ${w}`)
  }
  return `${parts.join(', ')}.`
}

/** Подпись состояния одной загрузки. */
export function batchStateLabel(r: ImportBatchResult): string {
  if (r.state === 'queued') return 'обрабатывается…'
  if (r.state === 'error') return r.error || 'ошибка обработки'
  const w = pluralRu(r.operations, ['операция', 'операции', 'операций'])
  return `${r.operations} ${w}, записано ${r.created}`
}
