// Priorbank connect-start orchestration (A5b, slice 2b) — the multi-step preamble Alfa does not
// have. Alfa's authorize URL is a pure string build (client_id + redirect + state); Prior needs a
// live round-trip BEFORE the user can be sent anywhere:
//
//   1. token Б   — POST /oauth2/token, grant_type=client_credentials, scope=accounts
//                  (client_secret_basic: creds in the Authorization header, never the body/URL)
//   2. consent   — POST /open-banking/v1.0/accountConsents  → openbanking_intent_id
//   3. request   — RS256-sign the authorize claim-set (binds the intent id)   [priorJwt.ts]
//   4. authorize — GET /oauth2/authorize?…&request=<JWT>     → the URL the admin opens
//
// Everything pure (bodies, claim-set, URL) comes from the tested core app/utils/priorOauth.ts;
// the transport + signing + clock + ids are INJECTED, so this orchestration is unit-testable
// without network or crypto. Secrets (client_secret, private key) are only ever passed to the
// injected transport/signer — never returned, logged, or embedded in the URL.
//
// The caller (the connect route, slice 2c) owns portal resolution, the admin gate and the signed
// connect-state — identical to the Alfa path (bankConnectStart.ts); this module only produces the
// bank-side authorize URL.

import {
  buildAuthorizeRequestClaims,
  buildClientCredentialsBody,
  buildConsentRequest,
  buildPriorAuthorizeUrl,
  extractIntentId,
  extractConsentExpiry,
  parsePriorTokenResponse,
  priorTokenRequest,
  PRIOR_API_PREFIXES
} from '../../app/utils/priorOauth'
import type { PriorTokenAuthMethod } from '../../app/utils/priorOauth'
import { priorAuthMethodFromEnv, resolvePriorTokenAuth } from './priorTokenAuth'
import { priorRequestTypFromEnv } from './priorJwt'
import { normalizeAuthorizeBase, normalizeBankApiBase } from '../../app/utils/bankGatewayUrl'

/** Non-secret Prior connect config (from env) + the secrets the injected transport needs. */
export interface PriorConnectConfig {
  /**
   * Origin the BACKEND calls for the RESOURCE API — consent, accounts, statements. May legitimately
   * be plain HTTP on an internal network when it points at the BY-crypto TLS gateway (#41/#455),
   * which raises the crypto TLS itself.
   *
   * ⚠ NOT the token endpoint: that is `tokenUrl` below, and the two can be different hosts. This
   * field is only the FALLBACK source for it when `PRIOR_OAUTH_TOKEN_URL` is unset.
   */
  baseUrl: string
  /**
   * FULL URL of the token endpoint. Separate from `baseUrl` because the bank splits the two: the
   * guide (p. 4) and the bank's own reply scope the BY-crypto `:9345` requirement to the
   * **Open-banking-authorize** API — "для взаимодействия с сервером авторизации" — while the
   * Open-banking resource API (consents, accounts, statements) is never said to move there.
   *
   * ⚠ This used to be derived from `baseUrl`, which silently disagreed with the REFRESH path:
   * that one has always read `PRIOR_OAUTH_TOKEN_URL` (`priorRefreshAuthFromEnv`). While both env
   * vars name the same origin nothing breaks — which is exactly why the divergence stayed
   * invisible. Point the token endpoint at the gateway and leave the resource API on the bank's
   * public host, and the two call sites would go to DIFFERENT hosts: connect fails, refresh
   * works. Deriving it here made the variable a lie for half the code.
   */
  tokenUrl: string
  /**
   * Origin the ADMIN'S BROWSER opens for the bank's authorize page — always the bank's public
   * host, never the gateway. ⚠ Pointing this at an internal gateway kills the connect flow with
   * NO server-side error (the server never makes that request). Defaults to `baseUrl` when
   * unset, which is correct as long as there is no gateway.
   */
  authorizeBaseUrl: string
  /** Business-app client id (from DCR). */
  clientId: string
  /** Business-app client secret (from DCR) — client_secret_basic. */
  clientSecret: string
  /** Registered redirect URI — must EXACTLY match the DCR-registered value. */
  redirectUri: string
  /** JWT `aud` — the issuer / token endpoint from /oidcdiscovery (port 9544, not 9344). Used by
   *  BOTH the authorize `request` JWT and (under private_key_jwt) the `client_assertion`. */
  audience: string
  /**
   * Client authentication at the token endpoint. `client_secret_basic` is SANDBOX-ONLY
   * (guide p. 9 §2.2); production needs `private_key_jwt`. Must match what DCR registered.
   * Absent ⇒ sandbox default (#444).
   */
  /**
   * JOSE `typ` of the authorize REQUEST OBJECT (#449). Optional: unset means `'JWT'`, the same value
   * the `client_assertion` carries — i.e. today's behaviour, so an existing deployment is unchanged.
   * Set `PRIOR_OAUTH_REQUEST_TYP` to split them.
   */
  requestTyp?: string
  authMethod?: PriorTokenAuthMethod
  /** RS256 private key (PEM) whose public half is registered in the app's `jwks`. */
  privateKeyPem: string
  /** Key id matching the `kid` published in `jwks`. */
  kid: string
}

/** Read the Prior connect config from env. Returns `null` when ANY required part is unset —
 *  fail-closed, so an unconfigured provider yields a clean 400 instead of a broken authorize URL
 *  (mirrors `bankConnectConfigFromEnv` for Alfa). */
export function priorConnectConfigFromEnv(): PriorConnectConfig | null {
  const baseUrl = normalizeBankApiBase(process.env.PRIOR_OAUTH_API_BASE)
  // Public authorize origin (#455). UNSET ⇒ fall back to the API base — today's single-origin
  // behaviour, correct until a gateway is introduced. SET BUT INVALID ⇒ fail closed rather than
  // quietly substitute the API base: an explicit value that didn't take is a typo someone needs to
  // see, and silently overriding it is how a wrong deployment looks healthy.
  const rawAuthorizeBase = process.env.PRIOR_OAUTH_AUTHORIZE_BASE?.trim()
  const authorizeBaseUrl = rawAuthorizeBase
    ? normalizeAuthorizeBase(rawAuthorizeBase)
    : normalizeAuthorizeBase(baseUrl)
  // Token endpoint: the SAME variable the refresh path reads, so both sites agree. Set but
  // unusable ⇒ null ⇒ config null ⇒ clean 400, rather than quietly falling back to `baseUrl`: an
  // explicit value that didn't take is a typo someone needs to see (same rule as authorize base).
  const rawTokenUrl = process.env.PRIOR_OAUTH_TOKEN_URL?.trim()
  const tokenUrl = rawTokenUrl
    ? normalizeBankApiBase(rawTokenUrl)
    : (baseUrl ? `${baseUrl}${PRIOR_API_PREFIXES.AUTH}/oauth2/token` : null)
  const clientId = process.env.PRIOR_OAUTH_CLIENT_ID?.trim()
  const clientSecret = process.env.PRIOR_OAUTH_CLIENT_SECRET?.trim()
  const redirectUri = process.env.PRIOR_OAUTH_REDIRECT_URI?.trim()
  const audience = process.env.PRIOR_OAUTH_AUDIENCE?.trim()
  const privateKeyPem = process.env.PRIOR_OAUTH_PRIVATE_KEY?.trim()
  const kid = process.env.PRIOR_OAUTH_KID?.trim()
  const authMethod = priorAuthMethodFromEnv()
  // #449: the `typ` of the authorize REQUEST OBJECT. Default equals the assertion's, i.e. today's
  // behaviour — the split is opt-in, see `priorRequestTypFromEnv`.
  const requestTyp = priorRequestTypFromEnv()
  // `clientSecret` is not required under private_key_jwt — the assertion authenticates us and the
  // bank may not issue one (#444). `authorizeBaseUrl` is null when the API base is an internal
  // gateway and no public origin was configured: that combination CANNOT produce a working
  // authorize URL, so fail closed here rather than emit one the browser can't open (#455).
  const secretRequired = authMethod === 'client_secret_basic'
  if (!baseUrl || !tokenUrl || !authorizeBaseUrl || !clientId || !redirectUri || !audience || !privateKeyPem || !kid) return null
  if (secretRequired && !clientSecret) return null
  return { baseUrl, tokenUrl, authorizeBaseUrl, clientId, clientSecret: clientSecret ?? '', redirectUri, audience, authMethod, privateKeyPem, kid, requestTyp }
}

/** Injected side-effects, so the orchestration is testable without network/crypto/clock. */
export interface PriorConnectDeps {
  /** POST a form body to the Prior token endpoint; returns raw JSON. Client authentication is
   *  already applied by `priorTokenRequest` — `headers` carries the Basic header under
   *  client_secret_basic and is EMPTY under private_key_jwt (the assertion rides in `body`).
   *  Neither the secret nor the assertion may be logged. */
  postToken: (url: string, body: string, headers: Record<string, string>) => Promise<unknown>
  /** POST the consent JSON with the token-Б Bearer; returns raw JSON. */
  postConsent: (url: string, accessToken: string, body: unknown) => Promise<unknown>
  /** RS256-sign the authorize claim-set (server/utils/priorJwt.ts signPriorJwt). `typ` distinguishes
   *  this JWT from the `client_assertion` signed by the same key (#449). */
  signJwt: (payload: Record<string, unknown>, privateKeyPem: string, kid: string, typ?: string) => string
  /** Epoch SECONDS (JWT iat/exp). */
  nowSec: () => number
  /** Fresh random ids for the JWT `jti` and the OIDC `nonce`. */
  newId: () => string
}

/** Consent scope for token Б (the client_credentials token that creates the consent). */
export const PRIOR_CONSENT_SCOPE = 'accounts'

/** How long the created consent stays valid. The bank requires `expirationDate` to be in the
 *  FUTURE (it is the consent's lifetime, NOT the statement window) — 90 days keeps the connected
 *  account polling without re-consent for a quarter. */
export const PRIOR_CONSENT_DAYS = 90

/** Build the consent `expirationDate` (`yyyy-MM-dd`) `days` ahead of `nowMs`. Pure. */
export function priorConsentExpiry(nowMs: number, days = PRIOR_CONSENT_DAYS): string {
  return new Date(nowMs + days * 864e5).toISOString().slice(0, 10)
}

/**
 * Run the Prior connect preamble and return the authorize URL the admin must open.
 * `state` is the caller's already-signed connect state (opaque here — it round-trips through the
 * bank back to our callback). Throws with a clean message on any step failure (no secrets in the
 * message) so the route can map it to a 502 — it never returns a half-built URL.
 */
export async function buildPriorConnectUrl(
  config: PriorConnectConfig,
  /**
   * Подписать `state`, УЖЕ ЗНАЯ срок согласия (#503).
   *
   * ⚠ Колбэк, а не готовая строка, ровно из-за порядка: согласие создаётся на шаге 2, а `state`
   * нужен только на шаге 3. Подписав раньше, мы бы не смогли положить в него дату — а другого
   * пути донести её до колбэка нет: между стартом и возвратом из банка у нас нет своего хранилища,
   * и подписанный state — единственное, чему колбэк вправе верить.
   */
  signState: (extra: { consentExpiresAt: number | null }) => string,
  deps: PriorConnectDeps,
  nowMs: number
): Promise<string> {
  // Token endpoint from config (may be a DIFFERENT origin than the resource API — see the field
  // docs); the consent lives on the Open-banking resource API, hence `baseUrl`.
  const tokenUrl = config.tokenUrl
  const consentUrl = `${config.baseUrl}${PRIOR_API_PREFIXES.OB}/accountConsents`

  // 1) token Б (client_credentials, scope=accounts). Client auth per the configured method —
  // ⚠ THIS call is easy to forget when migrating (#444): it lives in the connect preamble, not in
  // the «token» modules, yet DCR registers one method per app, so leaving it on the sandbox-only
  // Basic breaks prod at the FIRST step — before any other site is even reached.
  const tokenAuth = resolvePriorTokenAuth(config.authMethod ?? 'client_secret_basic', config, deps)
  const tokenReq = priorTokenRequest(buildClientCredentialsBody(PRIOR_CONSENT_SCOPE), tokenAuth)
  const tokenRaw = await deps.postToken(tokenUrl, tokenReq.body, tokenReq.headers)
  // parsePriorTokenResponse throws on an OAuth error payload / missing access_token.
  const tokenB = parsePriorTokenResponse(tokenRaw as never)

  // 2) consent → openbanking_intent_id.
  const consentRaw = await deps.postConsent(
    consentUrl,
    tokenB.accessToken,
    buildConsentRequest({ expirationDate: priorConsentExpiry(nowMs) })
  )
  const intentId = extractIntentId(consentRaw)
  if (!intentId) throw new Error('priorConnect: consent response carried no intent id')
  // Срок согласия берём ИЗ ОТВЕТА банка: просили мы своё (`priorConsentExpiry`), но банк волен
  // урезать запрошенное и отвечает тем, что реально выдал. `null` — поля не было; выдумывать дату
  // нельзя, «неизвестно» честнее (#503).
  const consentExpiresAt = extractConsentExpiry(consentRaw)
  const state = signState({ consentExpiresAt })

  // 3) sign the authorize `request` JWT (binds the consent to the authorization).
  const claims = buildAuthorizeRequestClaims({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    intentId,
    aud: config.audience,
    nonce: deps.newId(),
    state,
    nowSec: deps.nowSec(),
    jti: deps.newId()
  })
  // ⚠ The FOURTH argument is the mitigation, not decoration (#449): this JWT leaves in a URL the
  // admin forwards to the account owner, while the `client_assertion` — same key, same `kid`, a
  // SUBSET of these very claims — never leaves a POST body. Without a distinguishing `typ` a
  // forwarded connect link is a syntactically valid client assertion.
  const requestJwt = deps.signJwt(claims, config.privateKeyPem, config.kid, config.requestTyp)

  // 4) the authorize URL the admin opens top-level.
  // ⚠ The AUTHORIZE origin, not the API base: this URL is opened by the admin's browser.
  return buildPriorAuthorizeUrl(config.authorizeBaseUrl, {
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    state,
    requestJwt
  })
}
