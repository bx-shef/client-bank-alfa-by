// Lazy Postgres client for the portal token store. A single pooled connection
// per process, created on first use from `DATABASE_URL`. `dbQuery` adapts pg's
// result to the `QueryFn` shape the token store expects (rows array). Server-only
// (never imported by client/SSG code), so `pg` stays out of the browser bundle.

import { Pool } from 'pg'
import type { QueryFn } from '../utils/tokenStore'

/** Schema for the token store. `CREATE TABLE IF NOT EXISTS` — safe to run on
 * every boot (see server/plugins/migrate.ts). `application_token` defaults to ''
 * so the write-once `COALESCE(NULLIF(...))` upsert works on a fresh row. */
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
`

let pool: Pool | undefined

/** The shared pg pool. Throws if `DATABASE_URL` is unset — the backend needs a DB. */
export function getPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
  return pool
}

/** `QueryFn` over the pool — returns the rows array. */
export const dbQuery: QueryFn = async (sql, params) => {
  const res = await getPool().query(sql, params as unknown[])
  return res.rows as Record<string, unknown>[]
}
