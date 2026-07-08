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

/**
 * Run `fn` while holding a transaction-scoped advisory lock for `key`. The `QueryFn`
 * passed to `fn` runs on the SAME locked connection/transaction, so reads+writes
 * inside are serialized with other holders of the same key. Commits on success,
 * rolls back on throw; always releases the connection (destroying it on error so a
 * possibly-poisoned connection isn't reused).
 */
export async function withAdvisoryLock<T>(key: string, fn: (q: QueryFn) => Promise<T>): Promise<T> {
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
    // lock (and drain the small pool): waiters error after 10s and release their
    // connection; any single statement is capped at 20s. On timeout the query throws
    // → ROLLBACK → the caller's job retries, by when the holder has usually finished.
    // set_config(..., true) = SET LOCAL, parameterized (no inline SQL string literals).
    await client.query('SELECT set_config($1, $2, true)', ['lock_timeout', '10s'])
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
