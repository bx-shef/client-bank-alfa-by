// Pure session/credentials core for the operator login (see docs/AUTH.md).
// Ported from the Procure AI (postroyka/purchase-ai-chat) auth model: a public
// /login form gated by env credentials, a SIGNED session cookie (HMAC, not a
// bearer token in the browser), a CSRF header on mutations. No I/O here — env
// resolution, credential check, cookie sign/verify — so it is unit-testable;
// the routes (server/api/auth/*) wire it to requests.

import { createHmac } from 'node:crypto'
import { safeEqual } from '../../app/utils/b24Events'

/** Resolved auth config from env. `pass` empty ⇒ login is NOT configured (503). */
export interface AuthConfig {
  user: string
  /** Shared operator password; empty means auth is disabled (endpoint → 503). */
  pass: string
  /** HMAC signing secret; derived from the password when SESSION_SECRET is unset. */
  secret: string
  /** Session lifetime in ms. */
  ttlMs: number
}

const DEFAULT_USER = 'operator'
const DEFAULT_TTL_HOURS = 12

/** Read auth config from a plain env bag (process.env in the route). Pure. */
export function resolveAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const user = (env.PUBLIC_PAGE_BASIC_AUTH_USER || DEFAULT_USER).trim()
  const pass = (env.PUBLIC_PAGE_BASIC_AUTH_PASS || '').trim()
  const hours = Number(env.SESSION_TTL_HOURS)
  const ttlMs = (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS) * 3_600_000
  // Derive a signing secret from the password when none is given — so a configured
  // password alone yields a stable, non-empty secret (never sign with '').
  const secret = (env.SESSION_SECRET || '').trim() || (pass ? `derived:${pass}` : '')
  return { user, pass, secret, ttlMs }
}

/** Whether login is configured (a password is set). */
export function isAuthConfigured(cfg: AuthConfig): boolean {
  return cfg.pass.length > 0
}

/**
 * Constant-time credential check. Both user and password are compared with
 * `safeEqual` (no early return on the first differing byte). Returns false when
 * auth is not configured (empty `pass`) so an empty submitted password can never
 * match.
 */
export function checkCredentials(user: string, password: string, cfg: AuthConfig): boolean {
  if (!isAuthConfigured(cfg)) return false
  // Evaluate BOTH comparisons (no &&-shortcut) so timing doesn't reveal which field failed.
  const okUser = safeEqual(user, cfg.user)
  const okPass = safeEqual(password, cfg.pass)
  return okUser && okPass
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Session payload embedded (signed, not encrypted) in the cookie. */
export interface SessionPayload {
  /** Subject — the operator user name. */
  sub: string
  /** Absolute expiry, epoch ms. */
  exp: number
}

function hmac(input: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(input).digest())
}

/** Sign a payload into a `<b64url(json)>.<b64url(hmac)>` cookie value. */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = b64url(JSON.stringify(payload))
  return `${body}.${hmac(body, secret)}`
}

/**
 * Verify a signed cookie value: recompute the HMAC (constant-time compare),
 * then check expiry. Returns the payload or `null` (bad format / bad signature /
 * expired / empty secret). Never throws.
 */
export function verifySession(value: string | undefined, secret: string, nowMs: number): SessionPayload | null {
  if (!value || !secret) return null
  const dot = value.indexOf('.')
  if (dot <= 0) return null
  const body = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  if (!safeEqual(sig, hmac(body, secret))) return null
  let payload: SessionPayload
  try {
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp <= nowMs) return null
  return payload
}

/**
 * Non-secret startup diagnostic for the operator gate. Returns a warning string
 * when the current env is risky, or `null` when fine. Pure (takes an env bag):
 *  - production with no password ⇒ the whole operator zone is silently open;
 *  - a configured password but no explicit SESSION_SECRET ⇒ the HMAC key is
 *    derived from the password, so a leaked cookie enables an offline attack on
 *    the actual password. Callers log the result; secrets are never included.
 */
export function authStartupWarning(env: Record<string, string | undefined>): string | null {
  const isProd = env.NODE_ENV === 'production'
  const cfg = resolveAuthConfig(env)
  if (isProd && !isAuthConfigured(cfg)) {
    return 'operator zone is OPEN — PUBLIC_PAGE_BASIC_AUTH_PASS is not set in production'
  }
  if (isProd && isAuthConfigured(cfg) && !(env.SESSION_SECRET || '').trim()) {
    return 'SESSION_SECRET is not set — signing key is derived from the password; set an independent SESSION_SECRET in production'
  }
  return null
}

/** Cookie name for the operator session. */
export const SESSION_COOKIE = 'cba_sess'
/** CSRF header required on state-changing auth calls (custom header ⇒ needs CORS
 * preflight cross-site, so it can't be forged by a plain form POST). */
export const CSRF_HEADER = 'x-cba-auth'
