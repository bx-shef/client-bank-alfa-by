// Lazy Postgres client for the portal token store. A single pooled connection
// per process, created on first use from `DATABASE_URL`. `dbQuery` adapts pg's
// result to the `QueryFn` shape the token store expects (rows array). Server-only
// (never imported by client/SSG code), so `pg` stays out of the browser bundle.

import { Pool } from 'pg'
import type { QueryFn } from '../utils/tokenStore'
import { useServerLogger } from '../utils/serverLogger'

const log = useServerLogger('pg')

/** Schema for the backend tables. `CREATE TABLE IF NOT EXISTS` — safe to run on
 * every boot (see server/plugins/migrate.ts). `application_token` defaults to ''
 * so the write-once `COALESCE(NULLIF(...))` upsert works on a fresh row.
 *
 * Activity dedup is NOT a table anymore (#259): crm-sync writes a CONFIGURABLE activity
 * carrying an ORIGINATOR_ID/ORIGIN_ID marker and searches that marker before writing, so
 * Bitrix24 itself is the dedup record (no {dedupKey → activityId} map to keep).
 *
 * `allocation_fact` was the persistent «платёж → сущность» allocation record (#109) —
 * RETIRED (§9.3 #6): idempotency/audit/сторно now live entirely on the distributions
 * smart-process (marker + `status` on the dist-СП row). The table is dropped on boot
 * (`DROP TABLE IF EXISTS` below) so a previously-provisioned DB is cleaned up.
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

-- Ordering-guard tombstone (#77): deleted_ts = B24 event ts in SECONDS. Only needs to outlive a
-- late/retried install for the SAME uninstall (hours), so rows older than TOMBSTONE_TTL_DAYS (~30d,
-- a months-old tombstone can no longer be raced) are swept — see server/utils/tombstoneSweep.ts.
CREATE TABLE IF NOT EXISTS portal_tombstone (
  member_id   TEXT PRIMARY KEY,
  deleted_ts  BIGINT NOT NULL
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

CREATE TABLE IF NOT EXISTS import_batch (
  member_id   TEXT NOT NULL,
  batch_id    TEXT NOT NULL,
  -- Кто загрузил. Ключ загрузки — sha256 ФАЙЛА, то есть не секрет: тот же файл даёт тот же ключ
  -- у любого сотрудника портала. Без владельца коллега, имеющий такую же выписку, читал бы имя
  -- файла и счётчики чужой загрузки (и перетирал бы подпись в её карточке).
  user_id     TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'queued',
  file_name   TEXT NOT NULL DEFAULT '',
  operations  INTEGER NOT NULL DEFAULT 0,
  created     INTEGER NOT NULL DEFAULT 0,
  notified    INTEGER NOT NULL DEFAULT 0,
  unmatched   INTEGER NOT NULL DEFAULT 0,
  error       TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, batch_id)
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

CREATE TABLE IF NOT EXISTS portal_app_rating (
  member_id   TEXT PRIMARY KEY,
  prompted_at TIMESTAMPTZ,
  opened_at   TIMESTAMPTZ,
  reviewed    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Consent expiry for banks that grant one (Prior, #503). ADDED SEPARATELY on purpose: the table
-- above is CREATE TABLE IF NOT EXISTS, so on an existing installation it is a no-op and a new
-- column written inside it would never appear. ADD COLUMN IF NOT EXISTS is idempotent, so this
-- stays safe on every boot — the same posture as the rest of this script.
-- (⚠ No backticks anywhere in this string: it is a JS template literal, and one would end it.)
--
-- ⚠ 0 means «unknown», NOT «expired»: Alfa grants no consent at all, and Prior connections made
-- before this change have no stored date. Reading 0 as expiry would declare every one of them dead
-- and send people into their internet bank for something that works.
ALTER TABLE bank_tokens ADD COLUMN IF NOT EXISTS consent_expires_at BIGINT NOT NULL DEFAULT 0;

-- Неизменяемый адрес строки подключения (#517). Первичный ключ таблицы — (member_id, provider,
-- account_key), но сам account_key МЕНЯЕТСЯ: выбор счёта переименовывает временный ~pending:-ключ
-- в настоящий номер. Значит браузер, отрисовавший список минуту назад, держит адрес, которого уже
-- нет, и его «Отключить» тихо не находит строку — отвечая ровно тем же 200 {removed:false}, что и
-- честная идемпотентность двойного клика. Различить их по ключу невозможно в принципе.
--
-- (⚠ Обратных кавычек здесь нет НИ ОДНОЙ: это JS-шаблонная строка, и любая из них её оборвёт.
-- Ровно на этом уже спотыкались дважды, и SQL при этом ломается не в базе, а в парсере TS.)
--
-- ⚠ id НЕ становится первичным ключом и не заменяет тройку как идентичность: она используется
-- примерно в двадцати файлах, и переезд на суррогат — отдельная работа. Здесь id решает ровно одну
-- задачу: дать удалению адрес, который не может протухнуть.
--
-- BIGSERIAL на существующей таблице заполняет значения сразу; уникальность держит индекс ниже.
ALTER TABLE bank_tokens ADD COLUMN IF NOT EXISTS id BIGSERIAL;
  -- Когда мы последний раз ПЫТАЛИСЬ обновить токен, независимо от исхода (#489).
  -- ⚠ Это не то же, что updated_at: тот означает «когда мы последний раз ДЕРЖАЛИ свежую пару» и
  -- штампуется только успехом. Без отдельной метки неудачная попытка неотличима от отсутствия
  -- попытки, и подключение, которое мы объявили мёртвым по своим часам, пришлось бы либо не
  -- пробовать никогда (так и было — оно умирало окончательно), либо долбить каждый тик.
  ALTER TABLE bank_tokens ADD COLUMN IF NOT EXISTS last_attempt_at BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS bank_tokens_id_key ON bank_tokens (id);

-- Retired table (§9.3 #6): allocation idempotency/audit moved to the distributions
-- smart-process (marker + status). Idempotent DROP cleans up a previously-provisioned DB.
DROP TABLE IF EXISTS allocation_fact;
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
    pool.on('error', err => log.error(`idle client error: ${err.message}`))
  }
  return pool
}

/** `QueryFn` over the pool — returns the rows array. */
export const dbQuery: QueryFn = async (sql, params) => {
  const res = await getPool().query(sql, params as unknown[])
  return res.rows as Record<string, unknown>[]
}
