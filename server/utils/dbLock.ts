// Per-key Postgres advisory lock, held for a transaction on ONE pooled connection.
// Used to serialize the B24 token refresh per portal across ALL workers/replicas
// (scale-out): without it, two workers refreshing the same portal race on B24's
// refresh-token ROTATION — the loser's refresh token is invalidated and every later
// refresh for that portal fails. `pg_advisory_xact_lock` auto-releases on COMMIT/
// ROLLBACK, so a crashed worker can't leave a stuck lock.
//
// The critical section (`fn`) runs a network call (the OAuth POST) while holding the
// lock + a pooled connection — inherent to the design (only one worker may refresh).
// It is BOUNDED so a hung call can't pin resources forever: `lock_timeout` makes
// waiters fail fast instead of piling up on connections, `statement_timeout` bounds
// any single query, and the caller gives the HTTP POST its own timeout.

import { getPool } from '../db/client'
import type { QueryFn } from './tokenStore'

/** Default wait for the lock. Right for MACHINE callers (a job retried by BullMQ). */
export const DEFAULT_LOCK_WAIT = '10s'

/**
 * Shortest wait we allow. Guards the footgun in Postgres' own semantics: `lock_timeout = 0`
 * **disables** the timeout — it means WAIT FOREVER, not "don't wait".
 *
 * ⚠ That is the exact opposite of what a caller writing `lockWait: '0'` intends, and the failure is
 * silent and severe: instead of failing fast, the waiter camps on a pooled connection (pool = 10)
 * until the holder finishes, which for a long critical section can be minutes. The readiness probe,
 * install events and every other portal draw from that same pool.
 *
 * ⚠ There is no way to say "try once, don't wait" through `lock_timeout` at all — that would need
 * `pg_try_advisory_xact_lock`. Callers who want fail-fast get the shortest real wait instead, which
 * is behaviourally the same when the holder's critical section is long (the common case here).
 */
export const MIN_LOCK_WAIT = '100ms'

/**
 * Ожидание для операций «одна за раз на портал», которые ДОЛГИЕ по своей природе — провижининг
 * смарт-процессов и пересчёт распределения (#516).
 *
 * ⚠ Это НЕ копия `RENAME_LOCK_WAIT` (#509), а другой вывод из тех же посылок. Там держатель
 * работает доли секунды и подождать пару секунд осмысленно: он вот-вот закончит. Здесь держатель
 * делает десятки REST-вызовов в Bitrix24 и работает десятки секунд — ждать его почти наверняка
 * бессмысленно, а ожидающий всё это время занимает СОЕДИНЕНИЕ ИЗ ПУЛА (пул — 10), из которого
 * берут readiness-проба, события установки и все остальные порталы.
 *
 * ⚠ И по смыслу очереди тут не нужно: если операция уже идёт, второму вызову делать нечего —
 * первый сделает ту же работу. Правильный ответ «уже выполняется», а не «встань в очередь».
 */
export const SINGLE_FLIGHT_LOCK_WAIT = '1s'

/** Normalize `lockWait`: `0`/empty/garbage would mean «wait forever» (or a Postgres error), which
 *  is never what a caller means. Pure — exported for the test. */
export function resolveLockWait(raw: string | undefined): string {
  const v = (raw ?? '').trim()
  if (!v) return DEFAULT_LOCK_WAIT
  // `0`, `0s`, `0ms`, `00` … — every spelling of «no timeout» in Postgres.
  if (/^0+\s*(ms|s|min|h)?$/i.test(v)) return MIN_LOCK_WAIT
  return v
}

export interface AdvisoryLockOpts {
  /**
   * How long to WAIT for the lock before giving up (`lock_timeout`). Does not affect the
   * uncontended path — an idle lock is taken instantly.
   *
   * ⚠ A waiter holds a POOLED CONNECTION the whole time it waits, and the pool is 10. So this is
   * not just latency: it is how long one caller can occupy a connection that everything else in
   * the process — the readiness probe, install events, other portals — also needs. A HUMAN-facing
   * route should wait briefly and answer «busy, retry» rather than camp on a connection, because
   * the retry is one click away; a background job should wait longer, because nobody is watching.
   */
  lockWait?: string
}

/**
 * Run `fn` while holding a transaction-scoped advisory lock for `key`. The `QueryFn`
 * passed to `fn` runs on the SAME locked connection/transaction, so reads+writes
 * inside are serialized with other holders of the same key. Commits on success,
 * rolls back on throw; always releases the connection (destroying it on error so a
 * possibly-poisoned connection isn't reused).
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: (q: QueryFn) => Promise<T>,
  opts: AdvisoryLockOpts = {}
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    // The in-lock re-read (see ensureAccessToken) must see the previous holder's
    // COMMITTED write — that holds under READ COMMITTED (fresh per-statement snapshot
    // AFTER the lock is acquired). Pin it (must be the first statement of the txn) so a
    // server/pooler default of REPEATABLE READ/SERIALIZABLE can't silently break the
    // double-check.
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    // Bound waiting/execution so a hung critical section can't pin the connection +
    // lock (and drain the small pool): waiters error after `lockWait` and release their
    // connection; any single statement is capped at 20s. On timeout the query throws
    // → ROLLBACK → the caller's job retries, by when the holder has usually finished.
    // set_config(..., true) = SET LOCAL, parameterized (no inline SQL string literals).
    await client.query('SELECT set_config($1, $2, true)', ['lock_timeout', resolveLockWait(opts.lockWait)])
    await client.query('SELECT set_config($1, $2, true)', ['statement_timeout', '20s'])
    // hashtextextended(text, seed)::int8 → the bigint key form of pg_advisory_xact_lock.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key])
    const q: QueryFn = async (sql, params) =>
      (await client.query(sql, params as unknown[])).rows as Record<string, unknown>[]
    const out = await fn(q)
    await client.query('COMMIT')
    client.release()
    return out
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // ignore rollback failure — surface the original error
    }
    // Pass the error so pg destroys a possibly-broken connection instead of pooling it.
    client.release(e as Error)
    throw e
  }
}
