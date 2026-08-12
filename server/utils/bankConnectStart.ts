// Start the bank OAuth connect (stage 5, A7b-1) — pure logic over injected I/O (DI), so it is
// unit-testable without network/DB. The thin route (server/api/bank/connect.post.ts) wires the
// real transports and mints the nonce/now.
//
// Flow: the in-portal settings UI (admin) POSTs `{provider}` with the B24 frame token. We (1)
// resolve the portal we hold tokens for by its domain (absent ⇒ app not installed ⇒ reject),
// (2) validate the frame token against that domain (blocks X-B24-Domain spoofing; a token minted
// for another portal fails) AND require the initiating user be a portal ADMIN (connecting a bank
// binds credentials to the whole portal — gated here because the callback trusts the signed state
// blindly), then (3) build the bank authorize URL carrying a SIGNED connect state (bankConnectState)
// whose `memberId` is taken from OUR resolved portal — NOT from the client — so the eventual callback
// can trust it (A7b invariant 1). The A7c frontend will open the returned URL at the TOP level; the
// bank redirects to our callback (A7b-2) with `code` + `state`. Provider config
// comes from env (bankConnectConfigFromEnv); an unconfigured/unsupported provider is rejected here
// rather than producing a broken authorize URL.
//
// TWO PROVIDER SHAPES (A5b): Alfa's authorize URL is a pure string build, so the gates above are the
// whole flow. Prior needs a LIVE preamble first (token Б → /accountConsents → RS256-signed `request`
// JWT — see priorConnectStart.ts), injected here as `buildPriorUrl`; its failure is an upstream 502
// (the request was well-formed), while an unconfigured provider stays a 400. The gates, the signed
// state and the admin requirement are IDENTICAL for both — only the URL construction differs.

import { buildAuthorizeUrl, type AlfaOAuthConfig } from '../../app/utils/alfaOauth'
import { signConnectState, type BankConnectState } from './bankConnectState'
import { describeUpstreamError } from './logSanitize'
import type { PriorConnectConfig } from './priorConnectStart'
import type { BankProviderId } from '../../app/types/statement'

/** Non-secret authorize config for a provider, from env. `null` when the provider isn't configured
 *  (feature off) or has no plain code-flow config (Prior uses its own multi-step config —
 *  `priorConnectConfigFromEnv`). Pure. Alfa's authorize host is DERIVED from `ALFA_OAUTH_TOKEN_URL`
 *  (strip the trailing `/token`) so we don't add another env var; `ALFA_OAUTH_REDIRECT_URI` must
 *  EXACTLY match the one registered in the Alfa app. */
export function bankConnectConfigFromEnv(provider: BankProviderId): AlfaOAuthConfig | null {
  if (provider !== 'alfa-by') return null // Prior has its own config/flow; manual has no OAuth
  const clientId = process.env.ALFA_OAUTH_CLIENT_ID?.trim()
  const tokenUrl = process.env.ALFA_OAUTH_TOKEN_URL?.trim()
  const redirectUri = process.env.ALFA_OAUTH_REDIRECT_URI?.trim()
  if (!clientId || !tokenUrl || !redirectUri) return null
  // Authorize host = TOKEN_URL minus its trailing `/token`. If it doesn't end in /token we can't
  // derive the host safely → treat as unconfigured (fail-closed, no broken authorize URL).
  if (!/\/token\/*$/.test(tokenUrl)) return null
  const baseUrl = tokenUrl.replace(/\/token\/*$/, '')
  // Must be an absolute http(s) host — a relative TOKEN_URL like `/token` strips to '' and would
  // make buildAuthorizeUrl throw (500); fail-closed to null instead, as the doc above promises.
  if (!/^https?:\/\/[^/]/.test(baseUrl)) return null
  const scope = process.env.ALFA_OAUTH_SCOPE?.trim()
  return { baseUrl, clientId, redirectUri, ...(scope ? { scope } : {}) }
}

export interface ConnectStartResult {
  status: number
  body: Record<string, unknown>
}

/** Injected side-effects (live wiring in the route). */
export interface ConnectStartDeps {
  /** member_id of the portal we hold tokens for, by domain; null if not installed. */
  memberIdByDomain: (domain: string) => Promise<string | null>
  /** Validate the frame token against `domain` via a cheap REST call (`profile`), returning the
   *  initiating user's id + whether they're a portal admin (`profile.ADMIN`, basic scope), or
   *  THROWING if the token isn't valid for that portal (blocks domain spoofing). One call serves
   *  both membership proof and the admin gate. */
  validateFrame: (domain: string, accessToken: string) => Promise<{ userId: string, isAdmin: boolean }>
  /** Per-provider authorize config from env (null ⇒ not configured / unsupported). Alfa only —
   *  Prior's multi-step config is `priorConfig` below. */
  config: (provider: BankProviderId) => AlfaOAuthConfig | null
  /** Prior's connect config from env (null ⇒ not configured). Separate from `config` because
   *  Prior needs secrets (client_secret + signing key) for its live preamble, A5b. */
  priorConfig: () => PriorConnectConfig | null
  /** Run Prior's async preamble (token Б → consent → signed request JWT) and return the authorize
   *  URL. Injected so this handler stays testable without network/crypto; throws on any step
   *  failure (mapped to 502 — never a half-built URL). */
  buildPriorUrl: (config: PriorConnectConfig, state: string, nowMs: number) => Promise<string>
  /** HMAC secret for the connect state (the operator SESSION_SECRET). Empty ⇒ fail-closed. */
  secret: string
  /** Optional sanitized logger (already-safe strings only) — mirrors the callback's. Without it a
   *  failed Prior preamble would be completely unobservable (one opaque 502 for a rejected token Б,
   *  a consent 4xx, a missing intent id, or a malformed signing key). */
  log?: (msg: string) => void
}

export interface ConnectStartInput {
  accessToken: string
  domain: string
  provider: BankProviderId
  /** The bank account number the admin is connecting — carried through the signed state to the
   *  callback, which saves the token under it (bank_tokens.account_key), so the poller fetches that
   *  exact account (it's also the Alfa `number=` statement param). Required. */
  accountKey: string
  /** Random per-request nonce (correlation id in the state). */
  nonce: string
  /** Now, epoch ms (for the state expiry). */
  nowMs: number
  /** State lifetime (ms) — the OAuth round-trip window. */
  ttlMs?: number
}

/** Default connect-state lifetime: 10 min (generous for the admin to complete bank consent). */
export const CONNECT_STATE_TTL_MS = 600_000

/** An account key is an alphanumeric account number / IBAN-ish token (bounded). Rejects anything
 *  with separators/spaces so it can't smuggle content into the state or the later `number=` param. */
export function isValidAccountKey(v: string): boolean {
  return /^[A-Za-z0-9]{1,64}$/.test(v)
}

/**
 * Build the bank authorize URL (with a signed connect state) for the in-portal admin to open.
 * Returns 200 + `{ authorizeUrl }`, or a 4xx/5xx `{ error }`. Does NOT itself redirect — the route
 * returns the URL as JSON and the frontend navigates the top window.
 */
export async function handleBankConnectStart(deps: ConnectStartDeps, input: ConnectStartInput): Promise<ConnectStartResult> {
  const { accessToken, domain, provider, accountKey, nonce, nowMs } = input
  if (!accessToken || !domain) {
    return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  }
  if (!provider) return { status: 400, body: { error: 'provider required' } }
  // Счёт НЕОБЯЗАТЕЛЕН (#407): до авторизации админ не обязан помнить IBAN наизусть, а после неё
  // счёт можно выбрать из того, что отдал сам банк. Пустой ⇒ подключение уйдёт под временный ключ
  // (см. `provisionalAccountKey`), и UI попросит выбрать счёт уже по возвращении. Непустой, но
  // кривой — по-прежнему отказ: молча превращать мусор во временный ключ хуже явной ошибки.
  if (accountKey && !isValidAccountKey(accountKey)) {
    return { status: 400, body: { error: 'a valid account number is required' } }
  }

  // Provider must be configured + supported BEFORE we do any REST — a clean 400, not a broken URL.
  // Alfa uses the plain code-flow config; Prior has its own (multi-step, carries secrets, A5b).
  const isPrior = provider === 'prior-by'
  const config = isPrior ? null : deps.config(provider)
  const priorConfig = isPrior ? deps.priorConfig() : null
  if (!config && !priorConfig) {
    return { status: 400, body: { error: `provider ${provider} not available for online connect` } }
  }

  // No signing secret ⇒ the callback could never verify the state (fail-closed) — refuse to start.
  if (!deps.secret) return { status: 503, body: { error: 'connect unavailable (no session secret configured)' } }

  // Portal key check — do we hold tokens for this domain's portal?
  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed (no key)' } }

  // Prove the frame token belongs to THIS portal (blocks X-B24-Domain spoofing) AND read admin.
  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token for this portal' } }
  }
  // Admin-only: connecting a bank binds credentials to the whole portal. Enforce here — the callback
  // trusts the signed state blindly, so the authorization to START the flow must be gated now.
  if (!frame.isAdmin) return { status: 403, body: { error: 'bank connect requires a portal administrator' } }

  // memberId comes from OUR resolved portal (not the client) → the callback can trust state.memberId.
  // (There is no `memberId` in ConnectStartInput — the client cannot supply/override it; invariant 1.)
  const state: BankConnectState = {
    memberId,
    provider,
    // Пусто ⇒ в state счёта нет; колбэк положит токен под временный ключ.
    accountKey: accountKey || undefined,
    nonce,
    exp: nowMs + (input.ttlMs ?? CONNECT_STATE_TTL_MS)
  }
  const signed = signConnectState(state, deps.secret)

  // Prior: the authorize URL needs a LIVE preamble (token Б → consent → signed request JWT), so a
  // bank-side failure is a 502 (upstream), not a 400 — the request itself was well-formed. The
  // error text is ours (the pure core's), never the raw bank response.
  if (priorConfig) {
    try {
      const authorizeUrl = await deps.buildPriorUrl(priorConfig, signed, nowMs)
      return { status: 200, body: { authorizeUrl } }
    } catch (e) {
      // Log SANITIZED (CRLF-stripped, capped) so the four preamble steps stay distinguishable in
      // the logs — the admin still gets one opaque message (no bank-controlled text reaches them).
      // The bank's error ENVELOPE is included (`describeUpstreamError`): its status line alone is
      // the same "400 Bad Request" for a missing FAPI header, a rejected consent field and an
      // expired token, so without the body the log cannot tell an operator which one happened.
      deps.log?.(`[bank-connect] prior preamble failed: ${describeUpstreamError(e)}`)
      return { status: 502, body: { error: 'bank did not grant consent (connect preamble failed)' } }
    }
  }

  // Alfa: a pure string build — no bank round-trip needed to start.
  const authorizeUrl = buildAuthorizeUrl(config!, signed)
  return { status: 200, body: { authorizeUrl } }
}
