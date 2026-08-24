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
       updated_at        = now(),
       grant_revoked_at  = 0`,
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
 * UPDATE an existing portal registration's tokens. `false` = the row is already gone.
 *
 * ⚠ TWO WRITERS, WITH DIFFERENT RIGHTS (#510; the same move the bank store made in #505).
 * `saveToken` is an upsert — it CREATES the registration, and only the `ONAPPINSTALL` handlers
 * call it (the event route and the worker's register branch), where the portal has just installed
 * the app. Token refreshes come here instead.
 *
 * Refreshes used to go through that same upsert and could RESURRECT the row of an uninstalled
 * portal. The tombstone (#77) did not cover it — there were TWO windows, and the second was wider
 * than the module's own comment described:
 *   1. the refresh read the tombstone (none yet) → the uninstall completed → the refresh inserted;
 *   2. `deleteToken` wrote the tombstone AFTER deleting the row, so a refresh that started INSIDE
 *      the uninstall saw no ban either.
 * Reordering `deleteToken` would only close the second. UPDATE-only closes both at once and needs
 * no extra lock: once the `DELETE` has run there is nothing to update, whatever the ordering and
 * however long the network took. ⚠ And it takes long: a POST to Bitrix's OAuth server with a 15s
 * ceiling sits between the re-read and the write, which is why even the in-lock re-read in
 * `ensureAccessToken` narrowed the window without closing it.
 *
 * ⚠ No legitimate case exists where a refresh must CREATE the row: to renew a pair you must first
 * have read it from that very row.
 *
 * ⚠ `application_token` is not touched at all here — it is write-once and arrives only with the
 * install; a refresh knows nothing about it and must not.
 *
 * ⚠ `updated_at` IS stamped, which is the opposite of `renameBankTokenAccount` where stamping it
 * is forbidden. Here the column means "when we last held a fresh pair", and
 * `selectTokensNearExpiry` (#175) picks portals for proactive keep-alive by it. Skip the stamp and
 * an already-refreshed portal stays in the band and gets refreshed again on every tick.
 */
export async function updatePortalTokenSecrets(query: QueryFn, token: PortalToken): Promise<boolean> {
  const rows = await query(
    `UPDATE portal_tokens
        SET domain            = $2,
            access_token      = $3,
            refresh_token_enc = $4,
            expires_at        = $5,
            updated_at        = now(),
            -- ⚠ Снятие отметки мёртвого гранта (#574) — ЗДЕСЬ, в том же UPDATE, а не отдельным
            -- запросом. Успешное обновление токена и снятая отметка обязаны быть одной записью
            -- строки: отдельный запрос на залоченном соединении мог упасть, перевести транзакцию в
            -- aborted, и следующий COMMIT молча стал бы ROLLBACK — токен у Б24 уже ротирован, а у
            -- нас не сохранён. Вшитое условие забыть нельзя и рассинхронизировать нечем.
            grant_revoked_at  = 0
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
  // ⚠ ONE statement, not two (#510). The delete and the tombstone used to be separate `query()`
  // calls, and then the only question was which order was less bad — either the row outlives the
  // ban (live OAuth creds on disk for a portal that just revoked consent) or the ban outlives the
  // row (a concurrent writer sees neither and treats the portal as alive). Postgres runs a single
  // statement — data-modifying CTE included — in one implicit transaction, so both land or
  // neither does, and the question stops existing. No `BEGIN` needed.
  //
  // ⚠ The tombstone still matters even though `updatePortalTokenSecrets` is UPDATE-only: it is
  // what stops a STALE `register` (an install job retried after this uninstall) from re-creating
  // the portal through `saveToken` (#77). Atomicity here protects that guarantee, it does not
  // replace it.
  await query(
    `WITH deleted AS (
       DELETE FROM portal_tokens WHERE member_id = $1 RETURNING member_id
     )
     INSERT INTO portal_tombstone (member_id, deleted_ts) VALUES ($1, $2)
     ON CONFLICT (member_id) DO UPDATE SET deleted_ts = GREATEST(portal_tombstone.deleted_ts, EXCLUDED.deleted_ts)`,
    [memberId, eventTs]
  )
}

/**
 * Отметить, что грант портала ответил «мёртв» (#574) — ТОЛЬКО если отметки ещё не было.
 *
 * ⚠ `WHERE grant_revoked_at = 0` несущее: отсчёт идёт от ПЕРВОГО отказа. Перезаписывая метку на
 * каждом тике, мы отодвигали бы срок вечно, и портал не был бы стёрт никогда — уборщик выглядел бы
 * рабочим и не работал.
 *
 * ⚠ `updated_at` НЕ трогаем: по нему выбираются порталы для продления (#175), и сдвинув его, мы
 * выкинули бы мёртвый портал из выборки — то есть перестали бы получать отказы, по которым и
 * считается срок. Сам себе выключатель.
 *
 * ⚠ Как и все писатели после #510 — UPDATE-only: у удалённого портала обновлять нечего.
 */
export async function markGrantRevoked(query: QueryFn, memberId: string, atMs: number): Promise<void> {
  await query(
    `UPDATE portal_tokens SET grant_revoked_at = $2 WHERE member_id = $1 AND grant_revoked_at = 0`,
    [memberId, Math.floor(atMs)]
  )
}

/**
 * Порталы, у которых грант мёртв дольше порога — кандидаты на удаление (#574).
 *
 * ⚠ Порог считает ВЫЗЫВАЮЩИЙ и передаёт границу: SQL не должен знать про политику, а тест —
 * подсовывать часы в базу.
 *
 * ⚠ `LIMIT` обязателен и приходит снаружи: без него ошибка классификации однажды вернула бы всех
 * клиентов разом. Сортировка по метке — стираем самых давних, а не случайных: при упоре в потолок
 * очередь должна двигаться, а не топтаться на одних и тех же строках.
 */
export async function selectReapablePortals(
  query: QueryFn,
  beforeMs: number,
  limit: number
): Promise<{ memberId: string, revokedAtMs: number }[]> {
  const rows = await query(
    `SELECT member_id, grant_revoked_at FROM portal_tokens
      WHERE grant_revoked_at > 0 AND grant_revoked_at <= $1
      ORDER BY grant_revoked_at ASC
      LIMIT $2`,
    [Math.floor(beforeMs), Math.max(1, Math.floor(limit))]
  )
  return rows
    .map(r => ({
      memberId: String((r as { member_id?: unknown }).member_id ?? ''),
      revokedAtMs: Number((r as { grant_revoked_at?: unknown }).grant_revoked_at ?? 0)
    }))
    .filter(r => r.memberId !== '')
}

/** Сколько порталов сейчас помечены мёртвым грантом — для строки лога «кандидатов N». */
export async function countRevokedPortals(query: QueryFn, beforeMs: number): Promise<number> {
  const rows = await query(
    `SELECT count(*)::int AS n FROM portal_tokens WHERE grant_revoked_at > 0 AND grant_revoked_at <= $1`,
    [Math.floor(beforeMs)]
  )
  return Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0)
}

/**
 * Сколько порталов у нас всего — знаменатель предохранителя по доле флота (#574).
 *
 * ⚠ Считаем ВСЕ строки, а не только живые: предохранитель отвечает на вопрос «не выглядит ли
 * мёртвым слишком многое из того, что у нас есть», и знаменатель, из которого уже вычли
 * помеченных, сам бы полз вверх по доле с каждой пометкой — то есть предохранитель ослабевал бы
 * ровно по мере развития аварии, от которой заведён.
 */
export async function countPortals(query: QueryFn): Promise<number> {
  const rows = await query(`SELECT count(*)::int AS n FROM portal_tokens`, [])
  return Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0)
}
