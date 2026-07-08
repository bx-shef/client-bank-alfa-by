// Per-key Postgres advisory lock, held for a transaction on ONE pooled connection.
// Used to serialize the B24 token refresh per portal across ALL workers/replicas
// (scale-out): without it, two workers refreshing the same portal race on B24's
// refresh-token ROTATION — the loser's refresh token is invalidated and every later
// refresh for that portal fails. `pg_advisory_xact_lock` auto-releases on COMMIT/
// ROLLBACK, so a crashed worker can't leave a stuck lock.

import { getPool } from '../db/client'
import type { QueryFn } from './tokenStore'

/**
 * Run `fn` while holding a transaction-scoped advisory lock for `key`. The `QueryFn`
 * passed to `fn` runs on the SAME locked connection/transaction, so reads+writes
 * inside are serialized with other holders of the same key. Commits on success,
 * rolls back on throw; always releases the connection.
 */
export async function withAdvisoryLock<T>(key: string, fn: (q: QueryFn) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    // hashtextextended(text, seed)::int8 → the bigint key form of pg_advisory_xact_lock.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key])
    const q: QueryFn = async (sql, params) =>
      (await client.query(sql, params as unknown[])).rows as Record<string, unknown>[]
    const out = await fn(q)
    await client.query('COMMIT')
    return out
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // ignore rollback failure — surface the original error
    }
    throw e
  } finally {
    client.release()
  }
}
