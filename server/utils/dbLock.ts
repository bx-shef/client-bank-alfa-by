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
 * Wait for the «one at a time per portal» operations that are LONG by nature — smart-process
 * provisioning and distribution recompute (#516).
 *
 * ⚠ This is the SAME reasoning as `RENAME_LOCK_WAIT` (#509), not a different one — both holders are
 * slow and neither can be outwaited, so both wait briefly and answer «busy» instead of camping on a
 * POOLED CONNECTION (the pool is 10, shared with the readiness probe, install events and every
 * other portal). The real difference is BOUNDEDNESS, not speed: #509's holder is ONE network POST
 * capped at 15s (`bankAccountRename.ts`), while this one is unbounded — provisioning issues ~18
 * sequential REST calls, and recompute walks up to `MAX_LEDGER_PAYMENTS` payments at 2 calls each,
 * i.e. hundreds. An unbounded holder deserves the shorter wait of the two.
 *
 * ⚠ Queueing makes no sense here either: if the operation is already running, the second caller has
 * nothing to do — the first is doing the very same work. The right answer is «already running», not
 * «take a number».
 */
export const SINGLE_FLIGHT_LOCK_WAIT = '1s'

/** Postgres duration units accepted for `lock_timeout`. `d` is in the list because Postgres takes
 *  it too — omitting it made `0d` read as «not a zero» and sail through as «wait forever». */
const LOCK_WAIT_UNIT = /\s*(us|ms|s|min|h|d)$/i

/**
 * Normalize `lockWait`: zero means «wait FOREVER» in Postgres, which is never what a caller means.
 *
 * ⚠ Zero is detected by PARSING, not by matching spellings. The previous denylist
 * (`/^0+\s*(ms|s|min|h)?$/`) was measured against a live Postgres 16 and lost to every spelling it
 * had not enumerated: `+0`, `-0`, `0.0s`, `.0s`, `0e0`, `0x0`, `0d` all set `lock_timeout = 0` and
 * all slipped past it. A denylist here can only ever be as good as the list, so the unit is stripped
 * and the rest handed to `Number()` — the same parser that understands every one of those forms.
 *
 * ⚠ Anything that does NOT parse as a number is passed through UNCHANGED, on purpose: Postgres
 * rejects it loudly at `SET lock_timeout` and the operator sees the typo. Silently substituting a
 * default would turn `10sec` into a working route with a 100 ms wait — wrong, and invisible.
 *
 * Pure — exported for the test.
 */
export function resolveLockWait(raw: string | undefined): string {
  const v = (raw ?? '').trim()
  if (!v) return DEFAULT_LOCK_WAIT
  const n = Number(v.replace(LOCK_WAIT_UNIT, '').trim())
  // `<= 0` also catches a negative wait, which is nonsense; the fail-safe direction is a SHORT
  // wait, never an unbounded one.
  if (Number.isFinite(n) && n <= 0) return MIN_LOCK_WAIT
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
