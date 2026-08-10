// Client authentication for Priorbank's token endpoint — the ONE place that turns the
// configured method into a ready-to-send `PriorTokenAuth` (#444).
//
// Why a shared module: DCR registers a SINGLE `token_endpoint_auth_method` per application, so
// every token-endpoint call must authenticate the same way. The four call sites (DCR register,
// token Б / consent, code exchange, refresh) previously built their own `Authorization: Basic`
// header inline — two of them duplicated in thin routes with no test coverage. Funnelling them
// through here means a method change is one edit, not four, and can't half-land.
//
// `client_secret_basic` is SANDBOX-ONLY per the bank's guide (p. 9 §2.2); production needs
// `private_key_jwt`. Default stays `client_secret_basic` so an unconfigured deploy keeps the
// behaviour its DCR registration actually has.

import { buildClientAssertionClaims, parsePriorAuthMethod } from '../../app/utils/priorOauth'
import type { PriorTokenAuth, PriorTokenAuthMethod } from '../../app/utils/priorOauth'

/** Everything needed to authenticate as the client, under either method. */
export interface PriorAuthConfig {
  clientId: string
  /** Used by `client_secret_basic` only. */
  clientSecret: string
  /** JWT `aud` for `private_key_jwt` — the issuer from `/oidcdiscovery` (`PRIOR_OAUTH_AUDIENCE`). */
  audience: string
  /** RS256 private key (PEM) whose public half is registered in the app's `jwks`. */
  privateKeyPem: string
  /** Key id matching the `kid` published in `jwks`. */
  kid: string
}

/** Injected crypto/clock/ids, so the resolution is unit-testable without node:crypto. */
export interface PriorAuthDeps {
  /** RS256-sign a claim-set (`server/utils/priorJwt.ts` `signPriorJwt`). */
  signJwt: (payload: Record<string, unknown>, privateKeyPem: string, kid: string) => string
  /** Epoch SECONDS (JWT `iat`/`exp`). */
  nowSec: () => number
  /** Fresh random id for the JWT `jti` (single-use assertion). */
  newId: () => string
}

/** The configured method, from `PRIOR_OAUTH_AUTH_METHOD` (unset/unknown ⇒ sandbox default). */
export function priorAuthMethodFromEnv(): PriorTokenAuthMethod {
  return parsePriorAuthMethod(process.env.PRIOR_OAUTH_AUTH_METHOD)
}

/**
 * Resolve the client authentication for one token request.
 *
 * `private_key_jwt` mints a FRESH short-lived assertion per call (`jti` unique, `exp` from
 * `PRIOR_ASSERTION_TTL_SEC`) — assertions are single-use, so they must not be cached or reused
 * across requests. Throws when the key material is missing rather than silently falling back to
 * Basic: falling back would send sandbox-only credentials to production and fail with an opaque
 * 401 far from the misconfiguration.
 */
export function resolvePriorTokenAuth(
  method: PriorTokenAuthMethod,
  config: PriorAuthConfig,
  deps: PriorAuthDeps
): PriorTokenAuth {
  if (method === 'private_key_jwt') {
    if (!config.privateKeyPem || !config.kid || !config.audience) {
      throw new Error('priorTokenAuth: private_key_jwt needs PRIOR_OAUTH_PRIVATE_KEY, _KID and _AUDIENCE')
    }
    const claims = buildClientAssertionClaims({
      clientId: config.clientId,
      aud: config.audience,
      nowSec: deps.nowSec(),
      jti: deps.newId()
    })
    return { method: 'private_key_jwt', assertion: deps.signJwt(claims, config.privateKeyPem, config.kid) }
  }
  return { method: 'client_secret_basic', clientId: config.clientId, clientSecret: config.clientSecret }
}
