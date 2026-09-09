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
// bank redirects to our callback (A7b-2) with `code` + `state`. Provider config comes from env
// (priorConnectConfigFromEnv); an unconfigured/unsupported provider is rejected here rather than
// producing a broken authorize URL.
//
// ⚠ ПУТЬ ОСТАЛСЯ ТОЛЬКО У ПРИОРА (#488). У Альфы authorize-поток убран совсем: измерено дважды,
// что цепочка refresh её Code Grant живёт РОВНО 10 часов от авторизации и не продлевается ни
// частым обновлением, ни обращениями к API, — то есть непрерывный импорт требовал бы живого входа
// владельца счёта в интернет-банк дважды в сутки. Альфа подключается ключом API — соседний
// `bankConnectKey.ts`, общие проверки у них одни (`gateConnectAdmin`). У Приора Open Banking, и выбора
// там нет: его authorize-URL требует ЖИВОЙ преамбулы (токен Б → /accountConsents → RS256-подписанный
// `request` JWT — см. priorConnectStart.ts), внедрённой сюда как `buildPriorUrl`; её сбой — 502 (запрос был
// корректен), а ненастроенный провайдер — 400.

import type { AlfaOAuthConfig } from '../../app/utils/alfaOauth'
import { signConnectState, type BankConnectState } from './bankConnectState'
import { describeUpstreamError } from './logSanitize'
import { CONNECT_STATE_TTL_MS } from '../../app/utils/bankConnectTtl'
import type { PriorConnectConfig } from './priorConnectStart'
import type { BankProviderId } from '../../app/types/statement'
import { MY_COMPANY_GATE_MESSAGE, type MyCompanyGate } from './myCompanyRequisites'

/** Non-secret token-endpoint config for Alfa, from env. `null` when the provider isn't configured
 *  (feature off) or isn't Alfa (Prior uses its own multi-step config — `priorConnectConfigFromEnv`;
 *  `manual` has no bank at all). Pure. The host is DERIVED from `ALFA_OAUTH_TOKEN_URL` (strip the
 *  trailing `/token`) so we don't add another env var.
 *
 *  ⚠ Живёт ЗДЕСЬ, а зовёт его `/api/bank/connect-key` — этот путь Альфу больше не обслуживает
 *  (#488). Переезд функции в `bankConnectKey.ts` был бы честнее, но разошёлся бы с историей и с
 *  `envCheck`, который читает ту же тройку переменных; оставлено намеренно. */
export function bankConnectConfigFromEnv(provider: BankProviderId): AlfaOAuthConfig | null {
  if (provider !== 'alfa-by') return null // Prior has its own config/flow; manual has no OAuth
  const clientId = process.env.ALFA_OAUTH_CLIENT_ID?.trim()
  const tokenUrl = process.env.ALFA_OAUTH_TOKEN_URL?.trim()
  // ⚠ `ALFA_OAUTH_REDIRECT_URI` БОЛЬШЕ НЕ ТРЕБУЕТСЯ и не читается: он существовал только ради
  // authorize-редиректа, которого у Альфы больше нет (#488). Останься он обязательным — стенд, где
  // переменную не задали, отвечал бы «провайдер недоступен» на подключение ПО КЛЮЧУ, к которому
  // адрес возврата отношения не имеет.
  if (!clientId || !tokenUrl) return null
  // Authorize host = TOKEN_URL minus its trailing `/token`. If it doesn't end in /token we can't
  // derive the host safely → treat as unconfigured (fail-closed, no broken authorize URL).
  if (!/\/token\/*$/.test(tokenUrl)) return null
  const baseUrl = tokenUrl.replace(/\/token\/*$/, '')
  // Must be an absolute http(s) host — a relative TOKEN_URL like `/token` strips to '' and the
  // exchange would POST to `/token` on ourselves; fail-closed to null instead.
  if (!/^https?:\/\/[^/]/.test(baseUrl)) return null
  const scope = process.env.ALFA_OAUTH_SCOPE?.trim()
  return { baseUrl, clientId, ...(scope ? { scope } : {}) }
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
  /** Prior's connect config from env (null ⇒ not configured). Separate from `config` because
   *  Prior needs secrets (client_secret + signing key) for its live preamble, A5b. */
  priorConfig: () => PriorConnectConfig | null
  /** Run Prior's async preamble (token Б → consent → signed request JWT) and return the authorize
   *  URL. Injected so this handler stays testable without network/crypto; throws on any step
   *  failure (mapped to 502 — never a half-built URL). */
  buildPriorUrl: (config: PriorConnectConfig, signState: (extra: { consentExpiresAt: number | null }) => string, nowMs: number) => Promise<string>
  /** HMAC secret for the connect state (the operator SESSION_SECRET). Empty ⇒ fail-closed. */
  secret: string
  /** Whether the portal has a company marked «моя» with a settlement account (#493).
   *
   *  ⚠ FAIL-OPEN on purpose, and this is the one place that deserves the exception: the gate exists
   *  to save the account owner a pointless trip through their internet bank, not to protect
   *  anything. If we cannot ASK the portal (REST hiccup, trimmed rights), blocking a correctly
   *  configured client would be a worse outcome than letting a misconfigured one through — the
   *  second is recoverable in the settings screen, the first is not recoverable at all from the
   *  admin's side. Absent dep ⇒ no gate (older wirings, tests). */
  myCompanyGate?: (domain: string, accessToken: string) => Promise<MyCompanyGate>
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
   *  exact account (it's also the Alfa `number=` statement param). ⚠ OPTIONAL, and the UI no longer
   *  sends one at all (#482): asking up front misled, since the number never reached the bank. An
   *  empty value lands the connection under a provisional key, to be named from the list later. */
  accountKey: string
  /** Random per-request nonce (correlation id in the state). */
  nonce: string
  /** Now, epoch ms (for the state expiry). */
  nowMs: number
  /** State lifetime (ms) — the OAuth round-trip window. */
  ttlMs?: number
}

// Re-exported from the shared module so the UI can quote the SAME window without importing server
// code — the number is user-facing copy on one side and a signature claim on the other (#461).
export { CONNECT_STATE_TTL_MS }

/** An account key is an alphanumeric account number / IBAN-ish token (bounded). Rejects anything
 *  with separators/spaces so it can't smuggle content into the state or the later `number=` param. */
export function isValidAccountKey(v: string): boolean {
  return /^[A-Za-z0-9]{1,64}$/.test(v)
}

/** Исход общих проверок подключения: либо портал опознан, либо готовый ответ с отказом. */
export type ConnectAdminGate
  = | { ok: true, memberId: string }
    | { ok: false, res: ConnectStartResult }

/**
 * Общие проверки для ЛЮБОГО способа подключить банк: портал установлен → фрейм-токен доказан для
 * ЭТОГО домена → человек администратор → у портала есть «моя компания» с расчётным счётом.
 *
 * ⚠ Вынесено потому, что способов подключения стало два (authorize-редирект у Приора и ключ API у
 * Альфы), а проверки у них одни. Вторая копия этой последовательности — это второй список того,
 * кому можно привязать банковские креды ко всему порталу, и разошёлся бы он молча.
 *
 * ⚠ Порядок значим: сперва дешёвые проверки нашей базы, потом REST в портал. И «моя компания»
 * стоит ПОСЛЕДНЕЙ, но ДО обращения к банку — дальше идёт либо ввод пароля от интернет-банка, либо
 * трата ключа API, и уткнуться после этого в ненастроенный портал дороже всего.
 */
export async function gateConnectAdmin(
  deps: Pick<ConnectStartDeps, 'memberIdByDomain' | 'validateFrame' | 'myCompanyGate' | 'log'>,
  input: { accessToken: string, domain: string }
): Promise<ConnectAdminGate> {
  const { accessToken, domain } = input

  // Portal key check — do we hold tokens for this domain's portal?
  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { ok: false, res: { status: 409, body: { error: 'portal not installed (no key)' } } }

  // Prove the frame token belongs to THIS portal (blocks X-B24-Domain spoofing) AND read admin.
  let frame: { userId: string, isAdmin: boolean }
  try {
    frame = await deps.validateFrame(domain, accessToken)
  } catch {
    return { ok: false, res: { status: 403, body: { error: 'invalid frame token for this portal' } } }
  }
  // Admin-only: connecting a bank binds credentials to the whole portal.
  if (!frame.isAdmin) {
    return { ok: false, res: { status: 403, body: { error: 'bank connect requires a portal administrator' } } }
  }

  // «Моя компания» с расчётным счётом — предусловие, а не настройка (#493).
  if (deps.myCompanyGate) {
    let gate: MyCompanyGate = 'ok'
    try {
      gate = await deps.myCompanyGate(domain, accessToken)
    } catch (e) {
      // Спросить не смогли — пропускаем (см. контракт депа) и говорим об этом вслух.
      deps.log?.(`my-company precheck failed, allowing: ${(e as Error)?.message ?? ''}`)
    }
    if (gate !== 'ok') {
      return { ok: false, res: { status: 409, body: { error: MY_COMPANY_GATE_MESSAGE[gate], reason: gate } } }
    }
  }

  return { ok: true, memberId }
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

  // ⚠ ЭТОТ ПУТЬ ОБСЛУЖИВАЕТ ТОЛЬКО ПРИОРА (#488). У Альфы authorize-поток убран совсем: измерено,
  // что цепочка refresh Code Grant живёт ровно 10 часов от авторизации и не продлевается ничем, то
  // есть подключение требовало живого входа владельца счёта в интернет-банк дважды в сутки. Она
  // подключается ключом API — `/api/bank/connect-key`. У Приора Open Banking, и выбора там нет.
  const isPrior = provider === 'prior-by'
  if (!isPrior) {
    return {
      status: 400,
      body: { error: `${provider}: этот банк подключается ключом API, а не переходом в банк` }
    }
  }
  const priorConfig = deps.priorConfig()
  if (!priorConfig) {
    return { status: 400, body: { error: `provider ${provider} not available for online connect` } }
  }

  // No signing secret ⇒ the callback could never verify the state (fail-closed) — refuse to start.
  if (!deps.secret) return { status: 503, body: { error: 'connect unavailable (no session secret configured)' } }

  const gate = await gateConnectAdmin(deps, { accessToken, domain })
  if (!gate.ok) return gate.res
  const memberId = gate.memberId

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
  // ⚠ Подписываем ЗДЕСЬ только для Альфы. У Приора дата согласия становится известна лишь в
  // середине преамбулы, поэтому подпись отдаётся туда колбэком — иначе в state нечего было бы
  // положить, а другого канала до колбэка нет (#503).
  const signWith = (extra: { consentExpiresAt: number | null }): string =>
    signConnectState(
      { ...state, ...(extra.consentExpiresAt ? { consentExpiresAt: extra.consentExpiresAt } : {}) },
      deps.secret
    )

  // Prior: the authorize URL needs a LIVE preamble (token Б → consent → signed request JWT), so a
  // bank-side failure is a 502 (upstream), not a 400 — the request itself was well-formed. The
  // error text is ours (the pure core's), never the raw bank response.
  {
    try {
      const authorizeUrl = await deps.buildPriorUrl(priorConfig, signWith, nowMs)
      return { status: 200, body: { authorizeUrl } }
    } catch (e) {
      // Log SANITIZED (CRLF-stripped, capped) so the four preamble steps stay distinguishable in
      // the logs — the admin still gets one opaque message (no bank-controlled text reaches them).
      // The bank's error ENVELOPE is included (`describeUpstreamError`): its status line alone is
      // the same "400 Bad Request" for a missing FAPI header, a rejected consent field and an
      // expired token, so without the body the log cannot tell an operator which one happened.
      deps.log?.(`prior preamble failed: ${describeUpstreamError(e)}`)
      return { status: 502, body: { error: 'bank did not grant consent (connect preamble failed)' } }
    }
  }
}
