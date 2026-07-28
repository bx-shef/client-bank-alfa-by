// RS256 JWT signer for Priorbank Open Banking (СПР) — the server-side capability the Prior
// connect flow (A5b, slice 2) needs and the synchronous Alfa code flow did not: the
// `GET /oauth2/authorize` call carries a SIGNED `request` JWT (RS256) binding the authorization
// to the consent (`openbanking_intent_id`). The claim-set is built by the pure core
// (app/utils/priorOauth.ts buildAuthorizeRequestClaims); the RS256 signing + key handling live
// HERE because they need node:crypto (not browser-safe), mirroring the recon script
// (scripts/prior-oauth-test.mjs signJwt) so there is one signing shape.
//
// The private key (PEM) + its `kid` come from env (PRIOR_OAUTH_PRIVATE_KEY / _KID); the public
// half is registered with the bank via DCR `jwks`. The key material never leaves this process and
// is never logged.

import { createSign } from 'node:crypto'
import { Buffer } from 'node:buffer'

/** base64url-encode a string/Buffer (RFC 7515 §2): standard base64 with `+/`→`-_` and no padding. */
export function base64UrlEncode(input: Buffer | string): string {
  const b = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The fixed JOSE header for a Prior `request` JWT: RS256 + the registered key id. */
export function buildPriorJwtHeader(kid: string): { alg: 'RS256', typ: 'JWT', kid: string } {
  return { alg: 'RS256', typ: 'JWT', kid }
}

/**
 * RS256-sign a JWT payload with the account's private key (PEM). Returns the compact JWS
 * `<b64url(header)>.<b64url(payload)>.<b64url(signature)>`. Throws when the key or kid is missing
 * (a Prior connect can't proceed without a registered signing key — fail loud, don't emit an
 * unsigned/invalid token). The signature covers the exact `header.payload` bytes we emit.
 */
export function signPriorJwt(payload: Record<string, unknown>, privateKeyPem: string, kid: string): string {
  if (!privateKeyPem) throw new Error('signPriorJwt: private key (PEM) is required')
  if (!kid) throw new Error('signPriorJwt: kid is required')
  const header = buildPriorJwtHeader(kid)
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem)
  return `${signingInput}.${base64UrlEncode(signature)}`
}
