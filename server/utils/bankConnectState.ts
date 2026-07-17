// CSRF-safe OAuth `state` for the bank connect flow (stage 5, A7a). When a portal admin
// starts connecting a bank account, the authorize-redirect embeds a SIGNED state that ties the
// eventual callback back to the initiating portal (memberId) + provider (+ optional account
// scope) and can't be forged or replayed past its short expiry. The callback verifies it before
// exchanging the code for tokens — so a stray/hostile callback can't inject a code for another
// portal (classic OAuth CSRF). Pure + DI over the HMAC secret, mirroring server/utils/session.ts
// (same `<b64url(json)>.<b64url(hmac)>` shape, constant-time compare, never throws on verify).
//
// The signing secret is the operator SESSION_SECRET (will be wired at the A7b route) — the plan calls for
// "CSRF-state HMAC как session.ts". No secret ⇒ sign/verify are inert (empty string / null), so a
// misconfigured deploy fails closed (the callback rejects rather than trusting an unsigned state).
//
// DOMAIN SEPARATION (critical): because we reuse SESSION_SECRET with the SAME envelope shape as the
// operator session cookie, the HMAC is taken over a domain-TAGGED input (`DOMAIN_TAG + body`). Without
// this, a connect state — which is NOT confidential (it rides in the authorize URL / Referer / bank
// logs) — could be replayed as a `cba_sess` cookie: `verifySession` recomputes `hmac(body)` and only
// checks a numeric `exp`, so an untagged connect state would verify as an operator session (privilege
// escalation). The tag makes our signature `hmac(TAG+body)` never equal session's `hmac(body)`, so
// neither value verifies as the other — in BOTH directions — and session.ts stays untouched.

import { createHmac } from 'node:crypto'
import { safeEqual } from '../../app/utils/b24Events'
import type { BankProviderId } from '../../app/types/statement'

/** The connect-flow state, signed into the OAuth `state` param. */
export interface BankConnectState {
  /** The portal (member_id) that initiated the connect — the callback stores the token here. */
  memberId: string
  /** Which bank is being connected. */
  provider: BankProviderId
  /** Optional account scope the consent covers (may be filled in only at callback for some banks). */
  accountKey?: string
  /** Per-request correlation id (random entropy so two concurrent connects by the same admin yield
   *  distinct `state` values). NOT a security control — forgery is blocked by the HMAC, and there
   *  is no nonce store here, so single-use (if desired) must be enforced by the A7b callback. */
  nonce: string
  /** Absolute expiry, epoch ms — short (the OAuth round-trip), so a leaked state can't be replayed. */
  exp: number
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Domain-separation tag folded into the signed input: our HMAC is `hmac(TAG + body)`, so it can
 *  never equal session.ts's `hmac(body)` — a connect state can't be replayed as a `cba_sess` cookie
 *  (nor a cookie as a connect state). Bump the version suffix if the payload format changes. */
const DOMAIN_TAG = 'cba.bankconnect.v1|'

function hmac(input: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(input).digest())
}

/** Sign a connect state into a `<b64url(json)>.<b64url(hmac)>` value for the OAuth `state` param.
 *  Empty secret ⇒ `''` (fail-closed: verify will reject it). */
export function signConnectState(state: BankConnectState, secret: string): string {
  if (!secret) return ''
  const body = b64url(JSON.stringify(state))
  return `${body}.${hmac(DOMAIN_TAG + body, secret)}`
}

/**
 * Verify a signed `state` from the OAuth callback: recompute the HMAC (constant-time compare),
 * then check expiry and shape. Returns the state or `null` (bad format / bad signature / expired /
 * empty secret / malformed payload). Never throws.
 */
export function verifyConnectState(value: string | undefined, secret: string, nowMs: number): BankConnectState | null {
  if (!value || !secret) return null
  const dot = value.indexOf('.')
  if (dot <= 0) return null
  const body = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  if (!safeEqual(sig, hmac(DOMAIN_TAG + body, secret))) return null
  let payload: BankConnectState
  try {
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  if (typeof payload.memberId !== 'string' || !payload.memberId) return null
  if (typeof payload.provider !== 'string' || !payload.provider) return null
  if (typeof payload.nonce !== 'string' || !payload.nonce) return null
  if (typeof payload.exp !== 'number' || payload.exp <= nowMs) return null
  return payload
}
