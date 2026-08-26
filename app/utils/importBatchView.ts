// Чистое ядро отображения итогов ручной загрузки (#417).
//
// Раньше `/import` отвечал «принято в обработку» и замолкал навсегда: запись в CRM идёт в фоне,
// и узнать её исход было нельзя. Здесь — решения, на которых держится опрос итога: когда его
// прекращать и что показывать сотруднику. Вынесено из компонента, потому что ошибиться легко в
// обе стороны: не остановить опрос — бесконечные запросы к порталу; остановить рано — сотрудник
// снова не узнает результата.

import type { ImportBatchResult } from '~/types/importBatch'
import { pluralRu } from '~/utils/importStatus'

/** Пауза между опросами. Каждый запрос тянет за собой исходящий `profile` к порталу и тратит
 *  общую nginx-зону `import` (20 запросов в минуту на IP, делится со всей загрузкой): при паузе в
 *  3 секунды одна открытая вкладка выбирала бы зону целиком, и два сотрудника за общим NAT
 *  получали бы 429 в том числе на саму отправку файла. */
export const POLL_INTERVAL_MS = 5000

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
  // Гейт по ЗАВЕРШЁННЫМ, а не по наличию строк: строка «принято» приходит сразу, а `totalsOf`
  // отбрасывает незавершённые — и сотрудник всю обработку читал бы финально звучащее
  // «Разобрано операций: 0, записано в CRM: 0», то есть «ничего не записалось».
  if (!results.some(r => r.state !== 'queued')) return ''
  const t = totalsOf(results)
  const parts: string[] = []
  parts.push(`Разобрано операций: ${t.operations}`)
  parts.push(`записано в CRM: ${t.created}`)
  if (t.notified) parts.push(`отправлено в чат: ${t.notified}`)
  if (t.failed) {
    const w = pluralRu(t.failed, ['файл', 'файла', 'файлов'])
    parts.push(`не удалось обработать: ${t.failed} ${w}`)
  }
  let text = `${parts.join(', ')}.`
  if (t.unmatched) {
    const w = pluralRu(t.unmatched, ['операции', 'операций', 'операций'])
    // Голое «без компании-плательщика: 2» называет причину, но не говорит, что делать, и читается
    // как потеря данных. На деле дела записаны в вашу компанию (каскад #91) — об этом и сообщаем.
    // ⚠ «Привяжите вручную» отсюда убрано (#43): перепривязать созданное дело НЕЛЬЗЯ — Bitrix24 не
    // даёт сменить владельца (#579). Рабочий путь называем коротко, подробности — в справке.
    text += ` По ${t.unmatched} ${w} не нашли компанию по счёту плательщика — дела записаны в вашу компанию. Чтобы платежи встали к контрагентам, заведите их в CRM со счётом в реквизитах и удалите эти дела (см. справку).`
  }
  return text
}

/** Подпись состояния одной загрузки. */
export function batchStateLabel(r: ImportBatchResult): string {
  if (r.state === 'queued') return 'обрабатывается…'
  if (r.state === 'error') return r.error || 'ошибка обработки'
  const w = pluralRu(r.operations, ['операция', 'операции', 'операций'])
  return `${r.operations} ${w}, записано ${r.created}`
}
