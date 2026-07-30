// Стор результата ОДНОЙ ручной загрузки (#417). Чистый над инъектируемым `QueryFn` — тестируется
// без БД (как `importResultStore`). Схема — `import_batch` в `server/db/client.ts`.
//
// Ключ — `(member_id, batch_id)`, где `batch_id` = sha256 файла. Тот же хеш служит id джобы, то
// есть повторная загрузка того же файла попадает в ту же строку — и это правильно: обработка тоже
// дедуплицируется, и показывать две «разные» загрузки одного файла было бы ложью.
//
// ⚠ Строка НЕ хранит ни операций, ни назначений — только счётчики и имя файла. Сама выписка у нас
// транзитна (docs/PRIVACY.md), и заводить её долговременную копию ради отображения итога нельзя.

import type { ImportBatchResult, ImportBatchState } from '../../app/types/importBatch'
import type { QueryFn } from './tokenStore'

const VALID_STATES: readonly ImportBatchState[] = ['queued', 'ok', 'error']

function coerceState(v: unknown): ImportBatchState {
  return typeof v === 'string' && (VALID_STATES as readonly string[]).includes(v)
    ? v as ImportBatchState
    : 'queued'
}

/** Сколько ключей примем в одном запросе итогов. Больше одной загрузки за раз сотрудник всё равно
 *  не делает; кап нужен, чтобы подделанный список id не превращался в тяжёлый запрос. */
export const MAX_BATCH_IDS = 20

/** Отметить загрузку принятой (пишется на постановке в очередь, до всякой обработки). */
export async function markBatchQueued(
  query: QueryFn,
  memberId: string,
  batchId: string,
  fileName: string
): Promise<void> {
  // Повторная загрузка того же файла НЕ сбрасывает уже полученный итог в «принято»: обработка
  // дедуплицируется по тому же хешу, второго прогона не будет, и сброс оставил бы строку висеть
  // в «принято» навсегда.
  await query(
    `INSERT INTO import_batch (member_id, batch_id, state, file_name, updated_at)
     VALUES ($1, $2, 'queued', $3, now())
     ON CONFLICT (member_id, batch_id) DO UPDATE SET file_name = EXCLUDED.file_name`,
    [memberId, batchId, fileName]
  )
}

export interface BatchOutcome {
  operations: number
  created: number
  notified: number
  unmatched: number
}

/** Записать успешный итог обработки загрузки. */
export async function saveBatchResult(
  query: QueryFn,
  memberId: string,
  batchId: string,
  outcome: BatchOutcome
): Promise<void> {
  await query(
    `INSERT INTO import_batch
       (member_id, batch_id, state, operations, created, notified, unmatched, error, updated_at)
     VALUES ($1, $2, 'ok', $3, $4, $5, $6, '', now())
     ON CONFLICT (member_id, batch_id) DO UPDATE SET
       state = 'ok',
       operations = EXCLUDED.operations,
       created = EXCLUDED.created,
       notified = EXCLUDED.notified,
       unmatched = EXCLUDED.unmatched,
       error = '',
       updated_at = now()`,
    [memberId, batchId, outcome.operations, outcome.created, outcome.notified, outcome.unmatched]
  )
}

/** Записать провал загрузки (файл не разобрался / обработка упала). */
export async function saveBatchError(
  query: QueryFn,
  memberId: string,
  batchId: string,
  error: string
): Promise<void> {
  await query(
    `INSERT INTO import_batch (member_id, batch_id, state, error, updated_at)
     VALUES ($1, $2, 'error', $3, now())
     ON CONFLICT (member_id, batch_id) DO UPDATE SET
       state = 'error', error = EXCLUDED.error, updated_at = now()`,
    [memberId, batchId, error]
  )
}

/**
 * Прочитать итоги по списку ключей. **Скоуп по порталу — в самом WHERE**: ключ загрузки это
 * sha256 файла, то есть его знает всякий, у кого есть такой же файл; без member-скоупа чужой
 * портал читал бы наши счётчики по угаданному хешу.
 */
export async function getBatchResults(
  query: QueryFn,
  memberId: string,
  batchIds: string[]
): Promise<ImportBatchResult[]> {
  const ids = batchIds.filter(id => typeof id === 'string' && id !== '').slice(0, MAX_BATCH_IDS)
  if (!ids.length) return []
  const rows = await query(
    `SELECT batch_id, state, file_name, operations, created, notified, unmatched, error, updated_at
     FROM import_batch WHERE member_id = $1 AND batch_id = ANY($2::text[])`,
    [memberId, ids]
  )
  return rows.map(row => ({
    batchId: String(row.batch_id ?? ''),
    state: coerceState(row.state),
    fileName: String(row.file_name ?? ''),
    operations: Number(row.operations) || 0,
    created: Number(row.created) || 0,
    notified: Number(row.notified) || 0,
    unmatched: Number(row.unmatched) || 0,
    error: String(row.error ?? ''),
    updatedAt: row.updated_at == null ? null : new Date(row.updated_at as string | number | Date).toISOString()
  }))
}

/** Удалить записи старше N дней (суточный свип). Итог загрузки нужен ровно на время, пока
 *  сотрудник смотрит на экран, — держать его месяцами незачем. */
export async function sweepOldBatches(query: QueryFn, days: number): Promise<void> {
  await query(`DELETE FROM import_batch WHERE updated_at < now() - ($1 || ' days')::interval`, [String(days)])
}

/** Чистка на ONAPPUNINSTALL — удаление приложения стирает всё по порталу. */
export async function deleteBatchesForPortal(query: QueryFn, memberId: string): Promise<void> {
  await query(`DELETE FROM import_batch WHERE member_id = $1`, [memberId])
}
