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
  /**
   * Epoch ms when the BANK'S CONSENT lapses (#503; Prior grants one, Alfa does not). `0`/absent —
   * unknown, which is NOT the same as expired: see the schema comment in `db/client.ts`.
   *
   * ⚠ Written by the OAuth callback only. A token refresh must leave it alone — refreshing a token
   * says nothing about the consent behind it, and overwriting it with a default would quietly erase
   * the only date the bank ever gave us.
   */
  consentExpiresAt?: number
}

/**
 * Upsert a connected bank account's tokens (refresh encrypted before storage). Keyed by
 * `(member_id, provider, account_key)` — a re-connect simply overwrites the row (bank OAuth
 * rotates the refresh token every refresh, so no write-once). Atomic at the row level via the
 * single upsert.
 *
 * ⚠ THIS CREATES A CONNECTION. A token refresh must use `updateBankTokenSecrets` (UPDATE-only) —
 * see its docblock: the INSERT semantics here carry the power to resurrect a disconnected account,
 * and that power belongs only to the OAuth callback, where a human just authorised us at the bank.
 */
export async function saveBankToken(query: QueryFn, token: BankToken): Promise<void> {
  await query(
    `INSERT INTO bank_tokens
       (member_id, provider, account_key, access_token, refresh_token_enc, expires_at,
      consent_expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (member_id, provider, account_key) DO UPDATE SET
       access_token       = EXCLUDED.access_token,
       refresh_token_enc  = EXCLUDED.refresh_token_enc,
       expires_at         = EXCLUDED.expires_at,
       -- НЕИЗВЕСТНОЕ НЕ ЗАТИРАЕТ ИЗВЕСТНОЕ. 0 значит «даты нет», и при переподключении счёта
       -- (ответ банка без expirationDate — транзиентная аномалия) прямое присваивание стёрло бы
       -- реальный срок, который мы уже знали: подключение осталось бы живым, но предупреждение
       -- «согласие истекает через неделю» пропало бы до следующего удачного цикла.
       consent_expires_at = CASE WHEN EXCLUDED.consent_expires_at > 0
                                 THEN EXCLUDED.consent_expires_at
                                 ELSE bank_tokens.consent_expires_at END,
       updated_at         = now()`,
    // ⚠ An EMPTY refresh token is stored as a LITERAL empty string — NOT encrypted, and NOT SQL
    // NULL. Encrypting '' yields a perfectly non-empty blob (`iv:tag:` with an empty ciphertext
    // part), which made the `has_refresh` probe below answer TRUE for an account that has no refresh
    // token at all. That is precisely the Prior case — the bank may return no refresh_token and the
    // callback stores '' on purpose — so the UI showed «подключено» while the account could never be
    // refreshed, and the truth surfaced an hour later as a stalled import.
    //
    // ⚠ NULL would be the tidier spelling and is WRONG here on two counts: the column is
    // `TEXT NOT NULL DEFAULT ''` (server/db/client.ts) so the INSERT would raise 23502 and the
    // callback — which has no try/catch — would 500 AFTER the bank's single-use code was already
    // spent; and `rowToBankToken` would then decrypt `String(null)` = 'null' and throw «failed to
    // decrypt refresh» on every poll, a message that reads like a compromised key. Empty string
    // keeps both paths honest without touching the column type. (The schema script does support
    // idempotent `ALTER … ADD COLUMN IF NOT EXISTS` — see `consent_expires_at` — but changing an
    // EXISTING column's nullability on a live table is a different and far riskier operation.)
    [token.memberId, token.provider, token.accountKey, token.accessToken,
      token.refreshToken ? encryptSecret(token.refreshToken) : '', token.expiresAt,
      token.consentExpiresAt ?? 0]
  )
}

/**
 * Persist REFRESHED tokens of an existing connection. UPDATE-only: with no such row it writes
 * nothing and answers `false` (#505).
 *
 * ⚠ WHY THIS IS SEPARATE FROM `saveBankToken`. The refresh takes a per-account advisory lock and
 * re-reads the row inside it — but an advisory lock does not hold back unrelated DML, and a
 * `DELETE` is exactly that. The order that actually happens: the refresh re-reads the row → goes
 * to the bank (POST up to 15 s) → the admin hits «Отключить», the `DELETE` runs and commits → the
 * refresh returns and saves through `INSERT … ON CONFLICT`, **recreating the row**. A connection
 * the person had just deliberately removed went on living and being polled. For a bank connection
 * «disconnect» means «stop reaching into my bank», so a silent resurrection breaks precisely what
 * the button was pressed for.
 *
 * ⚠ WHY THIS RATHER THAN A LOCK ON THE DELETE. A lock in the disconnect route would cover that
 * route only, while the same INSERT also resurrects a row during app removal
 * (`deleteBankTokensForPortal` on `ONAPPUNINSTALL`) — i.e. we would keep the bank credentials of a
 * portal that removed us, and there is nowhere to put the lock there (one DELETE wipes every
 * account of the portal at once). UPDATE-only closes both with a single rule, needing neither a
 * second lock nor a tombstone table with its sweep. It also avoids the lock's own cost:
 * `lock_timeout` is 10 s while the bank POST runs up to 15 s, so «Отключить» could have failed
 * outright just for landing behind someone else's refresh. Operation order does not matter here:
 * deleted before our UPDATE — it finds no row; after — the delete takes the row away. Same ending.
 *
 * ⚠ The power to create a connection stays with `saveBankToken`, i.e. with the OAuth callback,
 * where a human has just authenticated at the bank. The rotated refresh is therefore lost for a
 * disconnected account only — nobody will use it, and reconnecting issues a fresh grant.
 *
 * `updated_at` is re-stamped: keep-alive picks renewal candidates by it (#489).
 */
export async function updateBankTokenSecrets(query: QueryFn, token: BankToken): Promise<boolean> {
  const rows = await query(
    `UPDATE bank_tokens
        SET access_token      = $4,
            refresh_token_enc = $5,
            expires_at        = $6,
            updated_at        = now()
      WHERE member_id = $1 AND provider = $2 AND account_key = $3
      RETURNING member_id`,
    // An empty refresh is a LITERAL empty string — not NULL, not ciphertext — for exactly the
    // reasons spelled out in `saveBankToken` (encrypting '' yields a non-empty blob, which makes
    // the `has_refresh` probe answer true for an account that cannot be refreshed at all).
    [token.memberId, token.provider, token.accountKey, token.accessToken,
      token.refreshToken ? encryptSecret(token.refreshToken) : '', token.expiresAt]
  )
  return rows.length > 0
}

/** Map a DB row to a `BankToken`, decrypting the refresh blob. Throws if it can't be
 *  decrypted (wrong key / tampering) — a corrupt row must fail loud, not silently. */
function rowToBankToken(row: Record<string, unknown>): BankToken {
  // ⚠ «No refresh token» is a VALID state, not a corrupt row: Prior may not issue one, and we then
  // store a literal '' (see saveBankToken). Decrypting that would throw — turning a bank that simply
  // withheld a refresh token into a permanent per-poll failure whose message («failed to decrypt»)
  // points at the encryption key instead. Absent/empty is passed through as ''; `ensureBankToken`
  // already handles it (warns, returns the token as-is, lets the caller fail honestly on an expired
  // access token) and `has_refresh` shows the admin that reconnecting is needed.
  const enc = row.refresh_token_enc
  let refreshToken = ''
  if (enc !== null && enc !== undefined && enc !== '') {
    try {
      refreshToken = decryptSecret(String(enc))
    } catch {
      throw new Error(`bankTokenStore: failed to decrypt refresh for memberId=${String(row.member_id)} provider=${String(row.provider)}`)
    }
  }
  return {
    memberId: String(row.member_id),
    provider: String(row.provider) as BankProviderId,
    accountKey: String(row.account_key),
    accessToken: String(row.access_token),
    refreshToken,
    expiresAt: Number(row.expires_at),
    // ⚠ Читать ОБЯЗАТЕЛЬНО, хотя SELECT колонку и так тянет: без этой строки `getBankToken` молча
    // отдавал бы токен без срока согласия, а `saveBankToken` при переподключении получил бы
    // `undefined` → 0 → «дата неизвестна». То есть знание о сроке терялось бы на каждом
    // round-trip, и предупреждение «согласие истекает» просто не появлялось бы (#503).
    consentExpiresAt: Number(row.consent_expires_at ?? 0)
  }
}

/** Load one connected account's tokens (decrypting refresh), or `null` if not connected. */
export async function getBankToken(query: QueryFn, memberId: string, provider: BankProviderId, accountKey: string): Promise<BankToken | null> {
  const rows = await query(
    `SELECT member_id, provider, account_key, access_token, refresh_token_enc, expires_at, consent_expires_at
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
    `SELECT member_id, provider, account_key, access_token, refresh_token_enc, expires_at, consent_expires_at
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
  /** Epoch ms the BANK'S CONSENT lapses (#503). `0` — unknown (Alfa grants none), not expired. */
  consentExpiresAt: number
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
    `SELECT member_id, provider, account_key, expires_at, updated_at, consent_expires_at,
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
    hasRefresh: r.has_refresh === true,
    consentExpiresAt: Number(r.consent_expires_at ?? 0)
  }))
}

/** EVERY connected account across ALL portals, with freshness — the keep-alive scan (#489).
 *  Same projection as `listBankAccountInfoForPortal` (identity + `updated_at` + `expires_at` +
 *  `has_refresh`), just without the member filter, and deliberately WITHOUT decryption: the scan
 *  decides *whom* to refresh, and only the chosen rows are loaded with their secrets.
 *
 *  ⚠ `bank_tokens` holds one row per connected account, not per operation — this is tens of rows
 *  on a busy install, not thousands. Selecting all of them and filtering in a pure function is
 *  cheaper to reason about (and to test) than a per-provider `CASE` cutoff in SQL, because the
 *  refresh lifetime differs by bank and is the thing most likely to be corrected later. */
export async function listAllBankAccountInfo(query: QueryFn): Promise<BankAccountInfo[]> {
  const rows = await query(
    `SELECT member_id, provider, account_key, expires_at, updated_at, consent_expires_at,
            (refresh_token_enc IS NOT NULL AND refresh_token_enc <> ''
             AND refresh_token_enc NOT LIKE '%:') AS has_refresh
       FROM bank_tokens ORDER BY updated_at ASC`,
    []
  )
  return rows.map(r => ({
    memberId: String(r.member_id),
    provider: r.provider as BankProviderId,
    accountKey: String(r.account_key),
    connectedAt: r.updated_at instanceof Date ? r.updated_at.getTime() : Date.parse(String(r.updated_at)),
    expiresAt: Number(r.expires_at),
    hasRefresh: r.has_refresh === true,
    consentExpiresAt: Number(r.consent_expires_at ?? 0)
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
    // ⚠ ЭТОТ UPDATE ОБЯЗАН ИДТИ ПОД ЛОКОМ ОБНОВЛЕНИЯ ТОКЕНА (#509) — его берёт `makeLockedRename`,
    // и `QueryFn` сюда приходит уже из-под лока. Сама функция лок не берёт намеренно: она чистая
    // над инъектируемым `QueryFn` и тестируется без БД. Позвать её напрямую с `dbQuery` — значит
    // сменить `account_key`, пока обновляющая сторона ищет строку по старому: она не найдёт её,
    // ничего не создаст (правильно, #505), и ротированный банком refresh пропадёт. Роут стережёт
    // `tests/bankRefreshLock.test.ts`.
    // ⚠ `updated_at` НЕ трогаем, хотя раньше трогали. Это переименование метки, а не получение
    // новой пары токенов: сам токен здесь не меняется ни на байт. С тех пор как `updated_at` стал
    // часами СВЕЖЕСТИ ТОКЕНА (keep-alive #489 и бейдж состояния решают по нему), его сброс здесь
    // означал бы вот что: админ авторизовался утром, вернулся к вкладке через семь часов и вписал
    // номер — и десятичасовой токен, которому осталось три часа, начинает считаться
    // свежесозданным. Обновление придёт на восьмом часу от ПЕРЕИМЕНОВАНИЯ, то есть на пятнадцатом
    // от выдачи, когда банк давно его забыл. Ровно та ночная смерть, от которой keep-alive и
    // написан, только заходящая с другой стороны.
    rows = await query(
      `UPDATE bank_tokens SET account_key = $4
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
