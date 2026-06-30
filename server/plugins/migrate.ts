// Nitro startup plugin: ensure the token-store schema exists. Idempotent
// (`CREATE TABLE IF NOT EXISTS`), so it's safe to run on every server boot —
// when the backend comes up against a fresh Postgres (e.g. docker compose), the
// table is created automatically. No-op without `DATABASE_URL` (the static
// landing / dev runs that don't need the DB).

import { SCHEMA_SQL, dbQuery } from '../db/client'

export default defineNitroPlugin(async () => {
  if (!process.env.DATABASE_URL) return
  try {
    await dbQuery(SCHEMA_SQL)
  } catch (err) {
    // Don't crash the server on a transient DB hiccup at boot — the events route
    // will surface a clear error if the table is genuinely missing.
    console.error('[migrate] schema init failed:', (err as Error)?.message)
  }
})
