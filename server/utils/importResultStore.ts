// Persistent «last import run» per portal (#5), so the in-portal UI can show a real
// result (operations / activities created / chat notified) instead of a mock. ONE row
// per portal (member_id PK): each crm-sync job UPSERTS it with that run's summary, so
// the stored value is always the MOST RECENT run. Pure over an injected `QueryFn` —
// unit-testable without a DB. Schema: `import_result` in server/db/client.ts. Uninstall
// purges it (like the other per-portal stores). The stored shape mirrors the client
// contract `ImportRunSummary` (app/types/importStatus.ts), minus the reserved
// `nextSyncAt` (the cron plan, not a stored fact).

import type { ImportRunSummary, ImportState } from '../../app/types/importStatus'
import type { QueryFn } from './tokenStore'

const VALID_STATES: readonly ImportState[] = ['never', 'running', 'ok', 'error']

/** Coerce a stored `state` string to a valid `ImportState` (defensive — the column is
 *  written only by us, but never trust a DB value blindly). Unknown → 'never'. */
function coerceState(v: unknown): ImportState {
  return typeof v === 'string' && (VALID_STATES as readonly string[]).includes(v) ? v as ImportState : 'never'
}

/** Coerce the stored `errors` (jsonb) to a string[] — drops non-strings, empty on junk. */
function coerceErrors(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : []
}

/**
 * Отметить обращение к банку: когда спросили и сколько операций он отдал.
 *
 * ⚠ Пишет ТОЛЬКО свои две колонки и НИКОГДА не трогает сводку прогона. Забор, не принёсший
 * операций, иначе затирал бы результат соседнего счёта того же портала — у портала один ряд, а
 * счетов несколько, и «0 операций» показывалось бы о прогоне, который записал десятки дел.
 * Ровно так первая редакция и делала (найдено ревью до выката).
 *
 * ⚠ `INSERT … ON CONFLICT` нужен потому, что у портала может ещё не быть ряда вовсе: первый в
 * жизни забор пустой — обычное начало.
 */
export async function markBankFetch(query: QueryFn, memberId: string, ops: number): Promise<void> {
  const n = Number.isFinite(ops) && ops > 0 ? Math.floor(ops) : 0
  // ⚠ Запись создаётся ТОЛЬКО для установленного портала. Задача забора может доехать до воркера
  // уже ПОСЛЕ `ONAPPUNINSTALL` (очередь живёт своей жизнью), и обычный upsert воскресил бы строку
  // удалённого портала — тот же класс, что закрыли UPDATE-only писателями в #505/#510, только
  // здесь `import_result` никто не подметает, и строка осталась бы навсегда.
  await query(
    `INSERT INTO import_result (member_id, last_fetch_at, last_fetch_ops, updated_at)
     SELECT $1, now(), $2, now()
      WHERE EXISTS (SELECT 1 FROM portal_tokens WHERE member_id = $1)
     ON CONFLICT (member_id) DO UPDATE SET
       last_fetch_at = now(),
       last_fetch_ops = EXCLUDED.last_fetch_ops,
       updated_at = now()`,
    [memberId, n]
  )
}

/**
 * Отметить/сбросить «последний прогон упёрся в неверную карту распознавания» (#595).
 *
 * `reason` — структурированная строка `what|param|detail` из `intentResolver` (не сырой ответ
 * портала). Непустая ⇒ пишем метку времени наблюдения; `null`/пусто ⇒ ЧИСТЫЙ прогон, сбрасываем
 * (0/NULL), и экран готовности снова зеленеет. Пишется на КАЖДОМ прогоне — это состояние
 * наблюдения, а не настройка, и починенная карта обязана гаснуть сама.
 *
 * ⚠ `INSERT … ON CONFLICT` — у портала может ещё не быть ряда (первый прогон). Как и `markBankFetch`,
 * НЕ трогает сводку прогона (свои две колонки) и создаётся только для установленного портала.
 */
export async function markRecognitionMisconfig(
  query: QueryFn,
  memberId: string,
  reason: string | null
): Promise<void> {
  const r = typeof reason === 'string' && reason.trim() !== '' ? reason : null
  await query(
    `INSERT INTO import_result (member_id, recog_misconfig_at, recog_misconfig_reason, updated_at)
     SELECT $1, CASE WHEN $2::text IS NULL THEN 0 ELSE (EXTRACT(EPOCH FROM now()) * 1000)::bigint END, $2, now()
      WHERE EXISTS (SELECT 1 FROM portal_tokens WHERE member_id = $1)
     ON CONFLICT (member_id) DO UPDATE SET
       recog_misconfig_at = CASE WHEN $2::text IS NULL THEN 0
         ELSE (EXTRACT(EPOCH FROM now()) * 1000)::bigint END,
       recog_misconfig_reason = $2,
       updated_at = now()`,
    [memberId, r]
  )
}

/** Прочитать persistent-признак misconfig карты распознавания (#595), или null если чисто. */
export async function getRecognitionMisconfig(
  query: QueryFn,
  memberId: string
): Promise<{ at: number, reason: string } | null> {
  const rows = await query(
    `SELECT recog_misconfig_at, recog_misconfig_reason FROM import_result WHERE member_id = $1`,
    [memberId]
  )
  const row = rows[0]
  if (!row) return null
  const at = Number(row.recog_misconfig_at) || 0
  const reason = typeof row.recog_misconfig_reason === 'string' ? row.recog_misconfig_reason : ''
  if (at <= 0 || reason === '') return null
  return { at, reason }
}

/** Read the last import run for a portal, or null if none has been recorded yet. */
export async function getImportResult(query: QueryFn, memberId: string): Promise<ImportRunSummary | null> {
  const rows = await query(
    `SELECT state, last_sync_at, operations, activities_created, chat_notified, errors,
            last_fetch_at, last_fetch_ops
     FROM import_result WHERE member_id = $1`,
    [memberId]
  )
  const row = rows[0]
  if (!row) return null
  const lastSyncAt = row.last_sync_at
  return {
    state: coerceState(row.state),
    lastSyncAt: lastSyncAt == null ? null : new Date(lastSyncAt as string | number | Date).toISOString(),
    operations: Number(row.operations) || 0,
    activitiesCreated: Number(row.activities_created) || 0,
    chatNotified: Number(row.chat_notified) || 0,
    errors: coerceErrors(row.errors),
    // Отметка обращения к банку — отдельно от сводки прогона (см. `markBankFetch`).
    lastFetchAt: row.last_fetch_at == null ? null : new Date(row.last_fetch_at as string | number | Date).toISOString(),
    lastFetchOps: Number(row.last_fetch_ops) || 0
  }
}

/**
 * Upsert the portal's last import run summary (write-latest, one row per member_id).
 * `lastSyncAt` is an ISO string (stamped by the caller/worker, not this pure store).
 * `errors` is serialized to jsonb. A later run overwrites the previous one.
 */
export async function saveImportResult(query: QueryFn, memberId: string, summary: ImportRunSummary): Promise<void> {
  await query(
    `INSERT INTO import_result
       (member_id, state, last_sync_at, operations, activities_created, chat_notified, errors, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
     ON CONFLICT (member_id) DO UPDATE SET
       state = EXCLUDED.state,
       last_sync_at = EXCLUDED.last_sync_at,
       operations = EXCLUDED.operations,
       activities_created = EXCLUDED.activities_created,
       chat_notified = EXCLUDED.chat_notified,
       errors = EXCLUDED.errors,
       updated_at = now()`,
    [
      memberId,
      summary.state,
      summary.lastSyncAt,
      summary.operations,
      summary.activitiesCreated,
      summary.chatNotified,
      JSON.stringify(summary.errors ?? [])
    ]
  )
}

/** Purge the portal's import result on ONAPPUNINSTALL (uninstall always erases
 *  everything for the portal). Idempotent. */
export async function deleteImportResultForPortal(query: QueryFn, memberId: string): Promise<void> {
  await query(`DELETE FROM import_result WHERE member_id = $1`, [memberId])
}
