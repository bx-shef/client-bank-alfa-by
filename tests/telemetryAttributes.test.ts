import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  REDACT_ATTR_KEYS,
  SAFE_MANUAL_ATTR_KEYS,
  httpOutcomeForStatus,
  isRedactedKey,
  pickSafeAttributes,
  portalHash,
  redactAttributes
} from '../server/utils/telemetryAttributes'

describe('pickSafeAttributes (manual-span allowlist)', () => {
  it('keeps allowlisted primitive keys', () => {
    expect(pickSafeAttributes({
      'dep.system': 'bitrix24',
      'dep.status': 'ok',
      'job.op_count': 5,
      'proc.allocated': 2,
      'portal.hash': 'abc123'
    })).toEqual({
      'dep.system': 'bitrix24',
      'dep.status': 'ok',
      'job.op_count': 5,
      'proc.allocated': 2,
      'portal.hash': 'abc123'
    })
  })

  it('keeps the job/dep span keys added with the coverage expansion (#78: job spans + batch dep)', () => {
    expect(pickSafeAttributes({
      'job.queue': 'bank-fetch',
      'job.kind': 'ONAPPINSTALL',
      'dep.operation': 'batch',
      'dep.op_count': 12
    })).toEqual({
      'job.queue': 'bank-fetch',
      'job.kind': 'ONAPPINSTALL',
      'dep.operation': 'batch',
      'dep.op_count': 12
    })
  })

  it('keeps the http settings-route span keys (#220 port: verb + op + outcome)', () => {
    expect(pickSafeAttributes({
      'http.method': 'POST',
      'http.op': 'settings.save',
      'http.outcome': 'forbidden'
    })).toEqual({
      'http.method': 'POST',
      'http.op': 'settings.save',
      'http.outcome': 'forbidden'
    })
  })

  it('drops non-allowlisted keys (e.g. a smuggled purpose / amount / account)', () => {
    expect(pickSafeAttributes({
      'dep.system': 'alfa',
      'purpose': 'Оплата по счёту №1042',
      'amount': 1840,
      'account': 'BY80ALFA...',
      'counterparty': 'ООО Ромашка'
    })).toEqual({ 'dep.system': 'alfa' })
  })

  it('drops object/null values even under an allowlisted key (no payload smuggling)', () => {
    expect(pickSafeAttributes({ 'dep.system': { nested: 'x' }, 'dep.status': null, 'dep.method': 'GET' }))
      .toEqual({ 'dep.method': 'GET' })
  })

  it('drops an array value (only scalars allowed — no payload smuggling)', () => {
    expect(pickSafeAttributes({ 'proc.recognized': [1, 2, 3], 'proc.allocated': 2 })).toEqual({ 'proc.allocated': 2 })
  })

  it('the allowlist contains no obviously-sensitive key', () => {
    for (const k of SAFE_MANUAL_ATTR_KEYS) {
      expect(/purpose|amount|account|counterpart|unp|назнач|сумм|счёт/i.test(k)).toBe(false)
    }
  })
})

describe('isRedactedKey (auto-instrumentation scrub)', () => {
  it('redacts SQL text and URL/query keys (can carry literals / tokens)', () => {
    expect(isRedactedKey('db.statement')).toBe(true)
    expect(isRedactedKey('db.query.text')).toBe(true)
    expect(isRedactedKey('http.url')).toBe(true)
    expect(isRedactedKey('url.query')).toBe(true)
  })
  it('redacts by sensitive marker substring (body/token/secret/authorization/cookie)', () => {
    expect(isRedactedKey('http.request.body')).toBe(true)
    expect(isRedactedKey('custom.access_token')).toBe(true)
    expect(isRedactedKey('req.Authorization')).toBe(true)
    expect(isRedactedKey('set-cookie')).toBe(true)
  })
  it('keeps safe shape keys', () => {
    expect(isRedactedKey('http.method')).toBe(false)
    expect(isRedactedKey('db.system')).toBe(false)
    expect(isRedactedKey('net.peer.name')).toBe(false)
  })
})

describe('redactAttributes', () => {
  it('strips sensitive keys, keeps safe ones, does not mutate input', () => {
    const input = { 'http.method': 'POST', 'db.statement': 'SELECT * FROM x WHERE acc=$1', 'net.peer.name': 'oauth.bitrix.info' }
    const out = redactAttributes(input)
    expect(out).toEqual({ 'http.method': 'POST', 'net.peer.name': 'oauth.bitrix.info' })
    expect(input['db.statement']).toBe('SELECT * FROM x WHERE acc=$1') // unchanged
  })
})

describe('preload redact list parity (no drift with the canonical TS list)', () => {
  // The preload otel.instrument.mjs can't import the TS bundle, so it INLINES the redact keys.
  // This guards against the two lists drifting apart (a new sensitive key added to one only).
  const preload = readFileSync(fileURLToPath(new URL('../otel.instrument.mjs', import.meta.url)), 'utf8')
  it('every canonical REDACT_ATTR_KEY appears in the preload', () => {
    for (const key of REDACT_ATTR_KEYS) {
      expect(preload).toContain(`'${key}'`)
    }
  })
  it('the preload shares the same sensitive markers', () => {
    for (const marker of ['body', 'payload', 'token', 'secret', 'password', 'authorization', 'cookie']) {
      expect(preload).toContain(`'${marker}'`)
    }
  })
})

describe('httpOutcomeForStatus (frame-route span outcome)', () => {
  it('maps the statuses our frame handlers produce to PII-safe outcomes', () => {
    expect(httpOutcomeForStatus(200)).toBe('ok')
    expect(httpOutcomeForStatus(202)).toBe('ok')
    expect(httpOutcomeForStatus(400)).toBe('bad_request')
    expect(httpOutcomeForStatus(401)).toBe('no_auth')
    expect(httpOutcomeForStatus(403)).toBe('forbidden')
    expect(httpOutcomeForStatus(409)).toBe('conflict')
    expect(httpOutcomeForStatus(429)).toBe('throttled')
    expect(httpOutcomeForStatus(500)).toBe('upstream_error')
    expect(httpOutcomeForStatus(502)).toBe('upstream_error')
    expect(httpOutcomeForStatus(503)).toBe('unavailable')
  })
  it('maps any other status to a generic error outcome', () => {
    expect(httpOutcomeForStatus(418)).toBe('error')
    expect(httpOutcomeForStatus(301)).toBe('error')
  })
  it('every mapped outcome is an allowlisted attribute value shape (enum, not content)', () => {
    for (const s of [200, 202, 400, 401, 403, 409, 500, 502, 503, 418]) {
      expect(typeof httpOutcomeForStatus(s)).toBe('string')
    }
  })
})

describe('portalHash', () => {
  it('is stable, short hex, and non-reversible (not the member id)', () => {
    const h = portalHash('member-123')
    expect(h).toMatch(/^[0-9a-f]{12}$/)
    expect(h).not.toContain('member-123')
    expect(portalHash('member-123')).toBe(h) // stable
    expect(portalHash('member-456')).not.toBe(h) // distinct
  })
  it('maps empty/absent to "unknown" without throwing', () => {
    expect(portalHash('')).toBe('unknown')
    expect(portalHash(undefined)).toBe('unknown')
    expect(portalHash(null)).toBe('unknown')
  })
})
