// Nitro startup plugin: ensure the token-store schema exists. Idempotent
// (`CREATE TABLE IF NOT EXISTS`), so it's safe to run on every server boot —
// when the backend comes up against a fresh Postgres (e.g. docker compose), the
// table is created automatically. No-op without `DATABASE_URL` (the static
// landing / dev runs that don't need the DB).

import { SCHEMA_SQL, dbQuery } from '../db/client'
import { envFlag } from '../queue/runtime'

export default defineNitroPlugin(async () => {
  if (!process.env.DATABASE_URL) return
  // Worker replicas skip migration (RUN_MIGRATION=0) — the schema is owned by the
  // primary/HTTP instance, so N workers booting together don't race on CREATE TABLE.
  if (!envFlag(process.env.RUN_MIGRATION, true)) {
    console.info('[migrate] skipped (RUN_MIGRATION=0) — schema owned by another instance')
    return
  }
  try {
    await dbQuery(SCHEMA_SQL)
  } catch (err) {
    // Don't crash the server on a transient DB hiccup at boot — the events route
    // will surface a clear error if the table is genuinely missing.
    console.error('[migrate] schema init failed:', (err as Error)?.message)
  }
})
