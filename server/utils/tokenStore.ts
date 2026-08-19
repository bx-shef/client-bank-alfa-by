// Per-portal token store for Bitrix24 OAuth. Pure over an injected `QueryFn`
// (the pg call), so it is unit-testable without a database. The refresh token is
// encrypted at rest (AES-256-GCM); the application_token is stored in clear (it
// only authenticates webhooks) and write-once — the first install sets it, later
// events must not overwrite it. Mirrors the bx-synapse token store; see
// docs/B24_EVENTS.md. SQL schema: `SCHEMA_SQL` in server/db/client.ts (applied
// idempotently on boot by server/plugins/migrate.ts).

import { decryptSecret, encryptSecret } from './secretCrypto'

/** A thin DB query function (e.g. pg `pool.query`) returning the rows. */
export type QueryFn = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

/** A portal's persisted OAuth state (refresh in clear here; encrypted in the DB). */
export interface PortalToken {
  memberId: string
  domain: string
  accessToken: string
  refreshToken: string
  /** Absolute epoch ms when the access token expires. */
  expiresAt: number
  /** Webhook-authenticating secret; write-once. */
  applicationToken: string
}

/**
 * Upsert a portal's tokens. The refresh token is encrypted before storage. The
 * `application_token` is write-once: `COALESCE(NULLIF(existing, ''), new)` keeps
 * the first legitimate value, so a later (possibly forged) install can't replace
 * it. Atomic at the row level via the single upsert.
 *
 * Ordering guard (#77): `eventTs` is the B24 event timestamp (monotonic — an install
 * fires before an uninstall). If a tombstone exists for this portal with a
 * `deleted_ts >= eventTs`, a NEWER (or equal) uninstall already removed the portal, so
 * this (stale) register is a no-op — it must NOT resurrect the portal with obsolete
 * creds. A genuine reinstall (`eventTs` strictly newer than the tombstone) proceeds and
 * clears the stale tombstone. Returns whether the token was actually written.
 *
 * The tombstone SELECT + upsert are two statements (not one transaction). This is
 * TOCTOU-free for the bug it fixes: the `b24-events` worker is single-instance,
 * concurrency-1 (see worker.ts), so a portal's register/unregister never overlap.
 *
 * ⚠ This function is now the INSTALL path only (#510). The residual it used to document — a
 * token-REFRESH interleaving with a concurrent uninstall and re-inserting a dead row — is gone,
 * because refreshes no longer come here: they call `updatePortalTokenSecrets`, which is
 * UPDATE-only and simply finds nothing to update once the row is deleted. That also retires the
 * "close it fully with a guarded `INSERT … WHERE NOT EXISTS(tombstone) … RETURNING`" follow-up
 * this comment used to anticipate: the guarded INSERT solved the same race atomically, whereas
 * UPDATE-only removes the possibility of creating the row at all on that path.
 */
export async function saveToken(query: QueryFn, token: PortalToken, eventTs = 0): Promise<boolean> {
  const blocked = await query(
    `SELECT 1 FROM portal_tombstone WHERE member_id = $1 AND deleted_ts >= $2`,
    [token.memberId, eventTs]
  )
  if (blocked[0]) return false // a same-or-newer uninstall already removed this portal
  await query(
    `INSERT INTO portal_tokens
       (member_id, domain, access_token, refresh_token_enc, expires_at, application_token, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (member_id) DO UPDATE SET
       domain            = EXCLUDED.domain,
       access_token      = EXCLUDED.access_token,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       expires_at        = EXCLUDED.expires_at,
       application_token = COALESCE(NULLIF(portal_tokens.application_token, ''), EXCLUDED.application_token),
       updated_at        = now()`,
    [
      token.memberId,
      token.domain,
      token.accessToken,
      encryptSecret(token.refreshToken),
      token.expiresAt,
      token.applicationToken || ''
    ]
  )
  // A genuine reinstall (newer ts) clears the obsolete tombstone so a later stale
  // uninstall can't re-block it. (Older tombstones already short-circuited above.)
  await query(`DELETE FROM portal_tombstone WHERE member_id = $1 AND deleted_ts < $2`, [token.memberId, eventTs])
  return true
}

/** Load a portal's tokens (decrypting refresh), or `null` if unknown. Throws if
 * the stored refresh blob can't be decrypted (wrong key / tampering). */
export async function getToken(query: QueryFn, memberId: string): Promise<PortalToken | null> {
  const rows = await query(
    `SELECT member_id, domain, access_token, refresh_token_enc, expires_at, application_token
       FROM portal_tokens WHERE member_id = $1`,
    [memberId]
  )
  const row = rows[0]
  if (!row) return null
  let refreshToken: string
  try {
    refreshToken = decryptSecret(String(row.refresh_token_enc))
  } catch {
    throw new Error(`tokenStore: failed to decrypt refresh for memberId=${memberId}`)
  }
  return {
    memberId: String(row.member_id),
    domain: String(row.domain),
    accessToken: String(row.access_token),
    refreshToken,
    expiresAt: Number(row.expires_at),
    applicationToken: String(row.application_token || '')
  }
}

/**
 * ОБНОВИТЬ токены существующей регистрации портала. `false` — строки уже нет, писать нечего.
 *
 * ⚠ ДВА ПИСАТЕЛЯ, И ЭТО РАЗНЫЕ ПРАВА (#510; тот же приём, что у банковского стора в #505).
 * `saveToken` — upsert, он СОЗДАЁТ регистрацию, и зовёт его только обработчик `ONAPPINSTALL`
 * (роут события и register-ветка воркера), где портал прямо сейчас установил приложение.
 * Обновление токена на рефреше ходит сюда.
 *
 * Раньше рефреш ходил тем же upsert'ом и мог ВОСКРЕСИТЬ строку удалённого портала. Тумбстоун
 * (#77) это не закрывал — окон было ДВА, и второе шире, чем описывал комментарий модуля:
 *   1. рефреш прочитал тумбстоун (его нет) → деинсталляция прошла целиком → рефреш вставил строку;
 *   2. `deleteToken` пишет тумбстоун ПОСЛЕ удаления строки, поэтому рефреш, стартовавший ВНУТРИ
 *      самой деинсталляции, тумбстоуна тоже не видит.
 * Перестановка операций в `deleteToken` убирает только второе. UPDATE-only убирает оба разом и
 * без второго локa: после `DELETE` обновлять нечего — неважно, в каком порядке всё легло и
 * сколько заняла сеть. ⚠ А занимает она много: между перечитом и записью стоит POST на
 * OAuth-сервер Bitrix с потолком 15 с, поэтому даже перечит под advisory-локом в
 * `ensureAccessToken` окно сужал, но не закрывал.
 *
 * ⚠ Легитимного случая, где рефреш обязан СОЗДАТЬ строку, не существует по построению: чтобы
 * обновить пару, её сперва надо прочитать из этой же строки.
 *
 * ⚠ `application_token` здесь не трогается вовсе — он write-once и приходит только с установкой;
 * рефреш о нём ничего не знает и знать не должен.
 *
 * ⚠ `updated_at` штампуется ОБЯЗАТЕЛЬНО, и это противоположно `renameBankTokenAccount`, где его
 * трогать нельзя. Здесь колонка означает «когда мы последний раз держали свежую пару», и по ней
 * `selectTokensNearExpiry` (#175) выбирает порталы для проактивного продления. Не обновив её,
 * мы бы гоняли рефреш по одному и тому же порталу на каждом тике.
 */
export async function updatePortalTokenSecrets(query: QueryFn, token: PortalToken): Promise<boolean> {
  const rows = await query(
    `UPDATE portal_tokens
        SET domain            = $2,
            access_token      = $3,
            refresh_token_enc = $4,
            expires_at        = $5,
            updated_at        = now()
      WHERE member_id = $1
      RETURNING member_id`,
    [token.memberId, token.domain, token.accessToken, encryptSecret(token.refreshToken), token.expiresAt]
  )
  return rows.length > 0
}

/** Load only the stored `application_token` for a portal (to verify a later
 * event), or `''` if the portal is unknown. Avoids decrypting the refresh token. */
export async function getApplicationToken(query: QueryFn, memberId: string): Promise<string> {
  const rows = await query(
    `SELECT application_token FROM portal_tokens WHERE member_id = $1`,
    [memberId]
  )
  return rows[0] ? String(rows[0].application_token || '') : ''
}

/** Resolve the portal's `member_id` by its domain (a portal has one domain ↔ one
 * member_id). Used by the manual-import ingest to map the frame's `X-B24-Domain` to
 * the portal we hold tokens for; `null` when the app isn't installed for that domain
 * (⇒ no key ⇒ reject the upload). Returns the most-recent row if duplicates ever
 * exist (domain isn't the PK). */
export async function getMemberIdByDomain(query: QueryFn, domain: string): Promise<string | null> {
  const d = (domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim()
  if (!d) return null
  const rows = await query(
    `SELECT member_id FROM portal_tokens WHERE domain = $1 ORDER BY updated_at DESC LIMIT 1`,
    [d]
  )
  return rows[0] ? String(rows[0].member_id) : null
}

/** Delete a portal's row on ONAPPUNINSTALL (uninstall always purges — a removed
 * app keeps no data; the CLEAN flag is not consulted). Idempotent.
 *
 * Ordering guard (#77): also record a TOMBSTONE `(member_id, deleted_ts)` so a stale
 * register (an install job that retries AFTER this uninstall) can't resurrect the
 * portal — `saveToken` refuses to write when a same-or-newer tombstone exists. The
 * tombstone keeps the NEWEST uninstall ts (`GREATEST`) and is cleared by a genuine
 * newer reinstall (in `saveToken`), so it's one small bounded row per uninstalled
 * portal. `eventTs` is the B24 event timestamp (0 when unknown). */
export async function deleteToken(query: QueryFn, memberId: string, eventTs = 0): Promise<void> {
  // ⚠ Тумбстоун пишется ПЕРВЫМ, до удаления строки (#510). Порядок был обратный, и это давало
  // отдельное окно: конкурент, стартовавший МЕЖДУ удалением и записью тумбстоуна, не видел ни
  // строки, ни запрета — то есть считал портал живым и просто ещё не сохранённым. Эшелонированная
  // защита ценой одной перестановки: основную работу делает UPDATE-only
  // (`updatePortalTokenSecrets`), закрывающий оба окна независимо от порядка, но сужать окно там,
  // где это бесплатно, всё равно правильно — тумбстоун читают и другие пути.
  await query(
    `INSERT INTO portal_tombstone (member_id, deleted_ts) VALUES ($1, $2)
     ON CONFLICT (member_id) DO UPDATE SET deleted_ts = GREATEST(portal_tombstone.deleted_ts, EXCLUDED.deleted_ts)`,
    [memberId, eventTs]
  )
  await query(`DELETE FROM portal_tokens WHERE member_id = $1`, [memberId])
}
