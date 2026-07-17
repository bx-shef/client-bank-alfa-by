// Lazy Postgres client for the portal token store. A single pooled connection
// per process, created on first use from `DATABASE_URL`. `dbQuery` adapts pg's
// result to the `QueryFn` shape the token store expects (rows array). Server-only
// (never imported by client/SSG code), so `pg` stays out of the browser bundle.

import { Pool } from 'pg'
import type { QueryFn } from '../utils/tokenStore'

/** Schema for the backend tables. `CREATE TABLE IF NOT EXISTS` — safe to run on
 * every boot (see server/plugins/migrate.ts). `application_token` defaults to ''
 * so the write-once `COALESCE(NULLIF(...))` upsert works on a fresh row.
 *
 * Activity dedup is NOT a table anymore (#259): crm-sync writes a CONFIGURABLE activity
 * carrying an ORIGINATOR_ID/ORIGIN_ID marker and searches that marker before writing, so
 * Bitrix24 itself is the dedup record (no {dedupKey → activityId} map to keep).
 *
 * `allocation_fact` is the persistent «платёж → сущность» allocation record (#109):
 * a payment is recorded as `allocated` against a target and can be flipped to
 * `reverted` on сторно — idempotent (write-once per key), survives reimport, scoped
 * per portal — see server/utils/allocationFactStore.ts.
 *
 * `bank_tokens` holds a portal's connected BANK OAuth tokens (Alfa/Prior online fetch,
 * stage 5): many per portal, keyed `(member_id, provider, account_key)`, refresh
 * encrypted at rest — see server/utils/bankTokenStore.ts. Purged on ONAPPUNINSTALL. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS portal_tokens (
  member_id          TEXT PRIMARY KEY,
  domain             TEXT NOT NULL,
  access_token       TEXT NOT NULL,
  refresh_token_enc  TEXT NOT NULL,
  expires_at         BIGINT NOT NULL,
  application_token  TEXT NOT NULL DEFAULT '',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal_tombstone (
  member_id   TEXT PRIMARY KEY,
  deleted_ts  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS allocation_fact (
  member_id    TEXT NOT NULL,
  fact_key     TEXT NOT NULL,
  target_kind  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'allocated',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, fact_key)
);

CREATE TABLE IF NOT EXISTS import_result (
  member_id          TEXT PRIMARY KEY,
  state              TEXT NOT NULL DEFAULT 'never',
  last_sync_at       TIMESTAMPTZ,
  operations         INTEGER NOT NULL DEFAULT 0,
  activities_created INTEGER NOT NULL DEFAULT 0,
  chat_notified      INTEGER NOT NULL DEFAULT 0,
  errors             JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS metrics_counter (
  member_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  value        BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, name)
);

CREATE TABLE IF NOT EXISTS bank_tokens (
  member_id          TEXT NOT NULL,
  provider           TEXT NOT NULL,
  account_key        TEXT NOT NULL,
  access_token       TEXT NOT NULL DEFAULT '',
  refresh_token_enc  TEXT NOT NULL DEFAULT '',
  expires_at         BIGINT NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, provider, account_key)
);
`

let pool: Pool | undefined

/** The shared pg pool. Throws if `DATABASE_URL` is unset — the backend needs a DB. */
export function getPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')
  if (!pool) {
    // `max` gives headroom now that a token refresh holds a connection across the B24
    // OAuth POST (see server/utils/dbLock.ts). `connectionTimeoutMillis` makes callers
    // fail fast (retryable) instead of blocking forever if the pool is momentarily
    // drained by concurrent refreshes — so one slow portal can't silently stall all DB work.
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 10_000
    })
    // Without an `error` listener, an error on an idle client (e.g. the DB drops
    // the connection) crashes the whole Node process. Log and keep serving.
    pool.on('error', err => console.error('[pg] idle client error:', err.message))
  }
  return pool
}

/** `QueryFn` over the pool — returns the rows array. */
export const dbQuery: QueryFn = async (sql, params) => {
  const res = await getPool().query(sql, params as unknown[])
  return res.rows as Record<string, unknown>[]
}
