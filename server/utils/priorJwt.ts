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

/**
 * JOSE `typ` for the `client_assertion` — the JWT that proves WHO WE ARE at `/oauth2/token`.
 *
 * ⚠ A CONSTANT, never read from env, and that asymmetry is the whole point (#449). This value must
 * not follow whatever the authorize side is set to, or the two headers would converge again the
 * moment someone «unifies» the knob — and their being distinguishable is the mitigation.
 */
export const PRIOR_ASSERTION_TYP = 'JWT'

/**
 * JOSE `typ` RFC 9101 §4 prescribes for the authorize REQUEST OBJECT. Opt-in via env; see
 * `priorRequestTypFromEnv`.
 */
export const PRIOR_REQUEST_OBJECT_TYP = 'oauth-authz-req+jwt'

/** A `typ` must be a media-type token — anything else is a typo, not a media type. */
const TYP_MASK = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/

/**
 * Which `typ` the authorize `request` JWT carries. Default is `'JWT'` — TODAY'S BEHAVIOUR, so an
 * unset env changes nothing on a working production connect.
 *
 * ⚠ Opt-in rather than default-on because this is the one step a WRONG value breaks in the face of
 * the ACCOUNT OWNER, not us: they open the link, the bank answers `invalid_request_object`, and it
 * reads as our integration being broken. The bank's own example header carries no `typ` at all
 * (`{"kid":…,"alg":"RS256"}`), so how strictly it validates the field is unknown — and unknown, in
 * front of a person entering their internet-bank password, is not something to guess at.
 *
 * ⚠ An invalid value falls back to the default instead of failing the connect: this is optional
 * hardening, and refusing to connect at all because a hardening knob has a typo is a worse trade
 * than connecting without it. The typo is surfaced at boot by `envCheck`, not swallowed.
 */
export function priorRequestTypFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PRIOR_OAUTH_REQUEST_TYP?.trim()
  if (!raw) return PRIOR_ASSERTION_TYP
  return TYP_MASK.test(raw) ? raw : PRIOR_ASSERTION_TYP
}

/** True when the env names a `typ` we refused to use — `envCheck` turns this into a boot warning. */
export function isPriorRequestTypInvalid(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PRIOR_OAUTH_REQUEST_TYP?.trim()
  return !!raw && !TYP_MASK.test(raw)
}

/**
 * The JOSE header for a Prior JWT: RS256 + the registered key id + `typ`.
 *
 * ⚠ `typ` is a PARAMETER, not a constant, because the two JWTs this key signs must be
 * distinguishable (#449). The authorize `request` object travels IN A URL — and we hand that URL to
 * the admin to forward to the account owner, so it routinely passes through a messenger — while the
 * `client_assertion` travels in a POST body. Their claim-sets differ only by the authorize side
 * having MORE: same `iss`/`sub`/`aud`/`exp`/`jti`, same `kid`, same signature key. A leaked
 * authorize JWT is therefore a syntactically valid `client_assertion` unless something tells them
 * apart.
 */
export function buildPriorJwtHeader(kid: string, typ: string = PRIOR_ASSERTION_TYP): { alg: 'RS256', typ: string, kid: string } {
  return { alg: 'RS256', typ, kid }
}

/**
 * RS256-sign a JWT payload with the account's private key (PEM). Returns the compact JWS
 * `<b64url(header)>.<b64url(payload)>.<b64url(signature)>`. Throws when the key or kid is missing
 * (a Prior connect can't proceed without a registered signing key — fail loud, don't emit an
 * unsigned/invalid token). The signature covers the exact `header.payload` bytes we emit.
 */
export function signPriorJwt(payload: Record<string, unknown>, privateKeyPem: string, kid: string, typ?: string): string {
  if (!privateKeyPem) throw new Error('signPriorJwt: private key (PEM) is required')
  if (!kid) throw new Error('signPriorJwt: kid is required')
  const header = buildPriorJwtHeader(kid, typ)
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem)
  return `${signingInput}.${base64UrlEncode(signature)}`
}
