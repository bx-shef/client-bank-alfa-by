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
  // ⚠ ПОВТОРНАЯ ЗАГРУЗКА СБРАСЫВАЕТ СТРОКУ В «ПРИНЯТО» — и раньше не сбрасывала (#498).
  // Прежняя логика опиралась на то, что второго прогона не будет: задача дедуплицировалась по тому
  // же хешу файла, поэтому сброс оставил бы строку висеть в «принято» навсегда. Рассуждение было
  // верным для своей посылки и неверным по сути: повторная загрузка — это не дубль, а ПОЧИНКА
  // (оператор увидел «117 обработано, 0 создано», настроил портал и загрузил файл заново). Дедуп
  // человеческого действия снят в `enqueueParse`/`enqueueCrmSync`, прогон теперь действительно
  // происходит — и оставить на экране прошлое «всё разобрано» значит отчитаться об успехе за
  // работу, которая ещё не началась.
  //
  // Счётчики обнуляются вместе с состоянием: иначе строка показывала бы «принято» и рядом цифры
  // прошлого прогона, а какие из них переживут новый — заранее не знает никто.
  //
  // ⚠ СТРОКУ ЗАБИРАЕТ ТОТ, КТО ЗАГРУЗИЛ ПОСЛЕДНИМ (`user_id = EXCLUDED.user_id`), и это не
  // небрежность, а следствие того, что прогон стал настоящим.
  //
  // Раньше здесь стоял `WHERE import_batch.user_id = EXCLUDED.user_id` — «чужую подпись не трогаем».
  // Он защищал от того, что коллега с тем же файлом (ключ — хеш ФАЙЛА, у них он совпадёт) подменит
  // имя в чужой карточке. Пока повтор ничего не запускал, это было безобидно. Теперь запускает — и
  // защита стала вредной ровно наоборот: отметка коллеги не проходила, а его прогон всё равно шёл и
  // по завершении перезаписывал счётчики (`saveBatchResult` пишет по `(member_id, batch_id)`, без
  // пользователя). Строка оставалась подписана первым, счётчики принадлежали второму, и второй
  // не видел СВОЕГО результата вовсе — `getBatchResults` фильтрует по владельцу.
  //
  // Правильная семантика формулируется одной фразой: строка — это ПОСЛЕДНИЙ прогон этого файла на
  // этом портале и тот, кто его запустил. Первый при этом ничего не теряет: его результат всё равно
  // был бы перезаписан тем же прогоном того же файла.
  await query(
    `INSERT INTO import_batch (member_id, batch_id, user_id, state, file_name, updated_at)
     VALUES ($1, $2, $4, 'queued', $3, now())
     ON CONFLICT (member_id, batch_id) DO UPDATE SET
       user_id    = EXCLUDED.user_id,
       file_name  = EXCLUDED.file_name,
       state      = 'queued',
       operations = 0,
       created    = 0,
       notified   = 0,
       unmatched  = 0,
       error      = '',
       updated_at = now()`,
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
