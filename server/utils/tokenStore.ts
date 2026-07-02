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
 */
export async function saveToken(query: QueryFn, token: PortalToken): Promise<void> {
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

/** Load only the stored `application_token` for a portal (to verify a later
 * event), or `''` if the portal is unknown. Avoids decrypting the refresh token. */
export async function getApplicationToken(query: QueryFn, memberId: string): Promise<string> {
  const rows = await query(
    `SELECT application_token FROM portal_tokens WHERE member_id = $1`,
    [memberId]
  )
  return rows[0] ? String(rows[0].application_token || '') : ''
}

/** Delete a portal's row on ONAPPUNINSTALL (uninstall always purges — a removed
 * app keeps no data; the CLEAN flag is not consulted). Idempotent. */
export async function deleteToken(query: QueryFn, memberId: string): Promise<void> {
  await query(`DELETE FROM portal_tokens WHERE member_id = $1`, [memberId])
}
