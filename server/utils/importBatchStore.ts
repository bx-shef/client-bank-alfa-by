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

/** Кап длины имени файла: имя приходит из multipart, его никто не ограничивал, а мы его храним
 *  и отдаём обратно. */
export const MAX_FILE_NAME = 200

/** Отметить загрузку принятой (пишется на постановке в очередь, до всякой обработки). */
export async function markBatchQueued(
  query: QueryFn,
  memberId: string,
  batchId: string,
  fileName: string,
  userId: string
): Promise<void> {
  // Повторная загрузка того же файла НЕ сбрасывает уже полученный итог в «принято»: обработка
  // дедуплицируется по тому же хешу, второго прогона не будет, и сброс оставил бы строку висеть
  // в «принято» навсегда.
  // Подпись обновляем ТОЛЬКО своей же строке: иначе коллега с тем же файлом подменял бы имя в
  // чужой карточке (ключ — хеш файла, он у них совпадёт).
  await query(
    `INSERT INTO import_batch (member_id, batch_id, user_id, state, file_name, updated_at)
     VALUES ($1, $2, $4, 'queued', $3, now())
     ON CONFLICT (member_id, batch_id) DO UPDATE SET file_name = EXCLUDED.file_name
     WHERE import_batch.user_id = EXCLUDED.user_id OR import_batch.user_id = ''`,
    [memberId, batchId, fileName.slice(0, MAX_FILE_NAME), userId]
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
 * Прочитать итоги по списку ключей. **Скоуп — в самом WHERE, и по порталу, И по сотруднику**:
 * ключ загрузки это sha256 файла, то есть его знает всякий, у кого есть такой же файл (типовой
 * банковский шаблон, пересланная выписка). Без member-скоупа чужой портал читал бы наши счётчики
 * по угаданному хешу; без user-скоупа — коллега по порталу читал бы имя файла и счётчики чужой
 * загрузки. Строки без владельца (`user_id = ''` — их пишет воркер, если отметка «принято» не
 * успела) видны всем в портале: у них некому принадлежать, а иначе итог просто пропал бы.
 */
export async function getBatchResults(
  query: QueryFn,
  memberId: string,
  batchIds: string[],
  userId: string
): Promise<ImportBatchResult[]> {
  const ids = batchIds.filter(id => typeof id === 'string' && id !== '').slice(0, MAX_BATCH_IDS)
  if (!ids.length) return []
  const rows = await query(
    `SELECT batch_id, state, file_name, operations, created, notified, unmatched, error, updated_at
     FROM import_batch
     WHERE member_id = $1 AND batch_id = ANY($2::text[]) AND (user_id = $3 OR user_id = '')`,
    [memberId, ids, userId]
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
