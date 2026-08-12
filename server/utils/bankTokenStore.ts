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
    // ⚠ An EMPTY refresh token is stored as SQL NULL, not as an encrypted empty string. Encrypting
    // '' yields a perfectly non-empty blob (`iv:tag:` with an empty ciphertext part), which made the
    // `has_refresh` probe below answer TRUE for an account that has no refresh token at all. That is
    // precisely the Prior case — the bank may return no refresh_token and the callback stores '' on
    // purpose — so the UI showed «подключено» while the account could never be refreshed, and the
    // truth surfaced an hour later as a stalled import. Nothing to protect in an empty secret anyway.
    [token.memberId, token.provider, token.accountKey, token.accessToken,
      token.refreshToken ? encryptSecret(token.refreshToken) : null, token.expiresAt]
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
 *  provider+account for a stable result. RESILIENT: a single undecryptable/corrupt row is
 *  skipped+logged (not thrown), so one tampered account can't deny polling of the healthy
 *  ones — unlike `getBankToken` (a specific requested account fails loud). */
export async function listBankTokensForPortal(query: QueryFn, memberId: string): Promise<BankToken[]> {
  const rows = await query(
    `SELECT member_id, provider, account_key, access_token, refresh_token_enc, expires_at
       FROM bank_tokens WHERE member_id = $1 ORDER BY provider, account_key`,
    [memberId]
  )
  const out: BankToken[] = []
  for (const row of rows) {
    try {
      out.push(rowToBankToken(row))
    } catch (e) {
      console.warn(`[bankTokenStore] skip corrupt row member=${memberId} provider=${String(row.provider)} account=${String(row.account_key)}: ${(e as Error)?.message}`)
    }
  }
  return out
}

/** Identity of one connected bank account — NO secrets. The real poll planner (A6) only
 *  needs which (portal, provider, account) to fetch; the worker loads+decrypts the token
 *  itself per job (`getBankToken`/`ensureBankToken`). */
export interface BankAccountRef {
  memberId: string
  provider: BankProviderId
  accountKey: string
}

/** Enumerate EVERY connected bank account across ALL portals (A6 registry) for the real
 *  poll planner. Identity only — no decryption, so a corrupt/undecryptable refresh_token
 *  can't hide a healthy account from polling (the worker fails loud per-job if the token is
 *  bad). Ordered for a stable plan. */
export async function listAllBankAccounts(query: QueryFn): Promise<BankAccountRef[]> {
  const rows = await query(
    `SELECT member_id, provider, account_key FROM bank_tokens ORDER BY member_id, provider, account_key`,
    []
  )
  return rows.map(r => ({
    memberId: String(r.member_id),
    provider: r.provider as BankProviderId,
    accountKey: String(r.account_key)
  }))
}

/** One portal's connected bank accounts — identity only (no refresh decryption; the manual
 *  poll (#54) only needs which accounts to fetch, not their tokens). Member-scoped. */
export async function listBankAccountsForPortal(query: QueryFn, memberId: string): Promise<BankAccountRef[]> {
  const rows = await query(
    `SELECT member_id, provider, account_key FROM bank_tokens WHERE member_id = $1 ORDER BY provider, account_key`,
    [memberId]
  )
  return rows.map(r => ({
    memberId: String(r.member_id),
    provider: r.provider as BankProviderId,
    accountKey: String(r.account_key)
  }))
}

/** One connected account as the UI sees it — identity + freshness, NEVER a secret (#404).
 *  `connectedAt` is the row's `updated_at` (set on connect AND on every refresh, so it reads
 *  as "last known good"), `expiresAt` lets the UI say whether the access token is still fresh. */
export interface BankAccountInfo extends BankAccountRef {
  /** Epoch ms of the last successful connect/refresh. */
  connectedAt: number
  /** Epoch ms the access token expires at. */
  expiresAt: number
  /** Whether a refresh token is stored at all — empty means «reconnect required» (Prior may
   *  return no refresh_token, and we store it empty rather than failing the connect). */
  hasRefresh: boolean
}

/** One portal's connected accounts WITH freshness, for the settings UI (#404). Deliberately does
 *  NOT decrypt: the UI must never receive token material, and a corrupt row still has to be
 *  listable (otherwise a bad row would be invisible and thus impossible to disconnect). */
export async function listBankAccountInfoForPortal(query: QueryFn, memberId: string): Promise<BankAccountInfo[]> {
  const rows = await query(
    // `NOT LIKE '%:'` catches rows written BEFORE the fix above: the blob is `iv:tag:ciphertext`,
    // so an encrypted empty secret ends with a bare colon. Without this clause every pre-existing
    // «no refresh token» row would keep claiming it has one until the account is reconnected — and
    // the badge exists exactly to tell the admin that reconnecting is needed.
    `SELECT member_id, provider, account_key, expires_at, updated_at,
            (refresh_token_enc IS NOT NULL AND refresh_token_enc <> ''
             AND refresh_token_enc NOT LIKE '%:') AS has_refresh
       FROM bank_tokens WHERE member_id = $1 ORDER BY provider, account_key`,
    [memberId]
  )
  return rows.map(r => ({
    memberId: String(r.member_id),
    provider: r.provider as BankProviderId,
    accountKey: String(r.account_key),
    // node-pg hands back a Date for TIMESTAMPTZ; String(Date) then re-parsing that human form is
    // implementation-defined and drops milliseconds — take the Date directly when we have one.
    connectedAt: r.updated_at instanceof Date ? r.updated_at.getTime() : Date.parse(String(r.updated_at)),
    expiresAt: Number(r.expires_at),
    hasRefresh: r.has_refresh === true
  }))
}

/** Disconnect ONE account (#404). Member-scoped in the WHERE clause — a portal can only ever
 *  delete its own row, even if the caller forges provider/account. Idempotent: deleting an
 *  already-gone row returns false rather than erroring. */
export async function deleteBankToken(query: QueryFn, memberId: string, provider: BankProviderId, accountKey: string): Promise<boolean> {
  const rows = await query(
    `DELETE FROM bank_tokens WHERE member_id = $1 AND provider = $2 AND account_key = $3 RETURNING member_id`,
    [memberId, provider, accountKey]
  )
  return rows.length > 0
}

/** Переименовать ключ счёта у подключения (#407): подключились без счёта → выбрали счёт.
 *  Member-scoped в обоих условиях, поэтому чужую строку не тронуть даже подделав provider/ключи.
 *  Занятый номер НЕ перезаписывается (иначе молча затёрли бы живой токен другого счёта): сперва
 *  проверка, а на случай гонки двух одновременных привязок — перехват нарушения первичного ключа
 *  `(member_id, provider, account_key)`. Без него проигравший получил бы 500 вместо честного 409
 *  (реальный сценарий — двойной клик по кнопке привязки). */
export async function renameBankTokenAccount(
  query: QueryFn, memberId: string, provider: BankProviderId, fromKey: string, toKey: string
): Promise<'renamed' | 'not-found' | 'conflict'> {
  const taken = await query(
    `SELECT 1 FROM bank_tokens WHERE member_id = $1 AND provider = $2 AND account_key = $3`,
    [memberId, provider, toKey]
  )
  if (taken.length > 0) return 'conflict'
  let rows: Record<string, unknown>[]
  try {
    rows = await query(
      `UPDATE bank_tokens SET account_key = $4, updated_at = now()
        WHERE member_id = $1 AND provider = $2 AND account_key = $3
        RETURNING member_id`,
      [memberId, provider, fromKey, toKey]
    )
  } catch (e) {
    // 23505 = unique_violation: между проверкой и UPDATE этот номер занял параллельный запрос.
    if ((e as { code?: string })?.code === '23505') return 'conflict'
    throw e
  }
  return rows.length > 0 ? 'renamed' : 'not-found'
}

/** Delete ALL of a portal's bank tokens on ONAPPUNINSTALL (a removed app keeps no data).
 *  Idempotent. Returns the number of rows removed (for logging). */
export async function deleteBankTokensForPortal(query: QueryFn, memberId: string): Promise<number> {
  const rows = await query(`DELETE FROM bank_tokens WHERE member_id = $1 RETURNING member_id`, [memberId])
  return rows.length
}
