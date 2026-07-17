// Per-portal, per-account BANK OAuth token store (Alfa/Prior online fetch, stage 5).
// Pure over an injected `QueryFn` (the pg call), so it is unit-testable without a
// database — same shape as the Bitrix24 portal token store (`tokenStore.ts`). The
// refresh token is encrypted at rest (AES-256-GCM, reusing `secretCrypto`); the access
// token is short-lived and stored in clear.
//
// Unlike the B24 portal token (one per portal, write-once application_token, tombstone
// ordering guard) a bank token is:
//   - MANY per portal — a portal connects one or more bank accounts, keyed by
//     `(member_id, provider, account_key)`. `account_key` is the "my company" scope the
//     legacy app used (`MC_CL_BNK_API_<myCompanyId>`) or the account number the consent
//     covers — the caller decides; the store treats it as an opaque key.
//   - fully UPDATE-able — bank OAuth rotates the refresh token on every refresh, so there
//     is no write-once field and no tombstone (a re-connect simply overwrites).
// The bank apiKey/secret is NEVER stored in app.option (readable in any app-admin
// context) — it lives here, encrypted. SQL schema: `SCHEMA_SQL` in server/db/client.ts
// (applied idempotently on boot by server/plugins/migrate.ts).

import { decryptSecret, encryptSecret } from './secretCrypto'
import type { QueryFn } from './tokenStore'
import type { BankProviderId } from '../../app/types/statement'

/** A connected bank account's persisted OAuth state (refresh in clear here; encrypted
 *  in the DB). One row per `(memberId, provider, accountKey)`. */
export interface BankToken {
  memberId: string
  /** Bank provider id (`alfa-by` / `prior-by`). */
  provider: BankProviderId
  /** The scope key the token covers — the "my company" id or account number. Opaque. */
  accountKey: string
  accessToken: string
  refreshToken: string
  /** Absolute epoch ms when the access token expires. */
  expiresAt: number
}

/**
 * Upsert a connected bank account's tokens (refresh encrypted before storage). Keyed by
 * `(member_id, provider, account_key)` — a re-connect or a refresh simply overwrites the
 * row (bank OAuth rotates the refresh token every refresh, so no write-once). Atomic at
 * the row level via the single upsert.
 */
export async function saveBankToken(query: QueryFn, token: BankToken): Promise<void> {
  await query(
    `INSERT INTO bank_tokens
       (member_id, provider, account_key, access_token, refresh_token_enc, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (member_id, provider, account_key) DO UPDATE SET
       access_token      = EXCLUDED.access_token,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       expires_at        = EXCLUDED.expires_at,
       updated_at        = now()`,
    [token.memberId, token.provider, token.accountKey, token.accessToken, encryptSecret(token.refreshToken), token.expiresAt]
  )
}

/** Map a DB row to a `BankToken`, decrypting the refresh blob. Throws if it can't be
 *  decrypted (wrong key / tampering) — a corrupt row must fail loud, not silently. */
function rowToBankToken(row: Record<string, unknown>): BankToken {
  let refreshToken: string
  try {
    refreshToken = decryptSecret(String(row.refresh_token_enc))
  } catch {
    throw new Error(`bankTokenStore: failed to decrypt refresh for memberId=${String(row.member_id)} provider=${String(row.provider)}`)
  }
  return {
    memberId: String(row.member_id),
    provider: String(row.provider) as BankProviderId,
    accountKey: String(row.account_key),
    accessToken: String(row.access_token),
    refreshToken,
    expiresAt: Number(row.expires_at)
  }
}

/** Load one connected account's tokens (decrypting refresh), or `null` if not connected. */
export async function getBankToken(query: QueryFn, memberId: string, provider: BankProviderId, accountKey: string): Promise<BankToken | null> {
  const rows = await query(
    `SELECT member_id, provider, account_key, access_token, refresh_token_enc, expires_at
       FROM bank_tokens WHERE member_id = $1 AND provider = $2 AND account_key = $3`,
    [memberId, provider, accountKey]
  )
  return rows[0] ? rowToBankToken(rows[0]) : null
}

/** List every connected bank account of a portal (decrypting each refresh). Feeds the
 *  poll planner (which accounts to fetch) once the account registry lands. Ordered by
 *  provider+account for a stable result. */
export async function listBankTokensForPortal(query: QueryFn, memberId: string): Promise<BankToken[]> {
  const rows = await query(
    `SELECT member_id, provider, account_key, access_token, refresh_token_enc, expires_at
       FROM bank_tokens WHERE member_id = $1 ORDER BY provider, account_key`,
    [memberId]
  )
  return rows.map(rowToBankToken)
}

/** Delete ALL of a portal's bank tokens on ONAPPUNINSTALL (a removed app keeps no data).
 *  Idempotent. Returns the number of rows removed (for logging). */
export async function deleteBankTokensForPortal(query: QueryFn, memberId: string): Promise<number> {
  const rows = await query(`DELETE FROM bank_tokens WHERE member_id = $1 RETURNING member_id`, [memberId])
  return rows.length
}
