import { afterEach, describe, expect, it } from 'vitest'
import {
  B24RestError,
  b24ErrorMessage,
  b24RestErrorFrom,
  callRest,
  isAllowedPortalHost,
  isExpiredTokenError,
  parseSelfHostedHosts,
  portalHostname,
  restTimingLine,
  restUrl,
  serverDurationMs
} from '../server/utils/b24Rest'

describe('restTimingLine (#78)', () => {
  it('formats method + rounded ms + ok flag', () => {
    expect(restTimingLine('crm.item.list', 42.7, true)).toBe('[rest-timing] method=crm.item.list ms=43 ok=1')
    expect(restTimingLine('crm.item.list', 100, false)).toBe('[rest-timing] method=crm.item.list ms=100 ok=0')
  })
  it('includes server time when provided (rounded), omits it otherwise', () => {
    expect(restTimingLine('profile', 200, true, 55.4)).toBe('[rest-timing] method=profile ms=200 srv=55 ok=1')
    expect(restTimingLine('profile', 200, true, undefined)).toBe('[rest-timing] method=profile ms=200 ok=1')
    expect(restTimingLine('profile', 200, true, Number.NaN)).toBe('[rest-timing] method=profile ms=200 ok=1')
  })
})

describe('serverDurationMs (#78)', () => {
  it('converts B24 time.duration (seconds) to ms', () => {
    expect(serverDurationMs({ time: { duration: 0.0554 } })).toBeCloseTo(55.4)
  })
  it('returns undefined when time/duration is absent or non-finite', () => {
    expect(serverDurationMs({})).toBeUndefined()
    expect(serverDurationMs({ time: {} })).toBeUndefined()
    expect(serverDurationMs({ time: { duration: 'x' } })).toBeUndefined()
    expect(serverDurationMs({ time: { duration: Infinity } })).toBeUndefined()
    expect(serverDurationMs({ time: { duration: null } })).toBeUndefined()
    expect(serverDurationMs({ time: 5 })).toBeUndefined() // `time` a primitive, not an object
  })
  it('handles duration 0 and negative (finite) values', () => {
    expect(serverDurationMs({ time: { duration: 0 } })).toBe(0)
    expect(serverDurationMs({ time: { duration: -0.05 } })).toBeCloseTo(-50)
  })
})

describe('restUrl', () => {
  it('builds https://<host>/rest/<method> from a bare host', () => {
    expect(restUrl('p.bitrix24.by', 'app.option.get')).toBe('https://p.bitrix24.by/rest/app.option.get')
  })
  it('strips a scheme and any path if a full endpoint is passed', () => {
    expect(restUrl('https://p.bitrix24.by/rest/', 'app.option.set')).toBe('https://p.bitrix24.by/rest/app.option.set')
  })
  it('normalises http to https and drops a trailing path', () => {
    expect(restUrl('http://p.bitrix24.by/rest', 'app.info')).toBe('https://p.bitrix24.by/rest/app.info')
  })
  it('keeps only the host from a bare host with a path', () => {
    expect(restUrl('p.bitrix24.by/foo/bar', 'scope')).toBe('https://p.bitrix24.by/rest/scope')
  })
  it('resolves the REAL host from a userinfo trick (no parser-differential SSRF)', () => {
    // `x.bitrix24.by@evil.com` — the label before `@` is userinfo; the true host is evil.com.
    // restUrl must extract evil.com, the SAME host isAllowedPortalHost rejects (see below).
    expect(restUrl('x.bitrix24.by@evil.com', 'profile')).toBe('https://evil.com/rest/profile')
  })
  it('throws (fail-closed) on an empty/unparseable host instead of https:///…', () => {
    expect(() => restUrl('', 'app.info')).toThrow(/invalid\/empty portal host/)
    expect(() => restUrl('   ', 'app.info')).toThrow(/invalid\/empty portal host/)
  })
})

describe('portalHostname', () => {
  it('extracts the bare lowercase host from bare/scheme/path/port forms', () => {
    expect(portalHostname('P.Bitrix24.BY')).toBe('p.bitrix24.by')
    expect(portalHostname('https://p.bitrix24.by/rest/')).toBe('p.bitrix24.by')
    expect(portalHostname('p.bitrix24.by:8080/foo')).toBe('p.bitrix24.by')
  })
  it('resolves the true host past a userinfo `@`', () => {
    expect(portalHostname('x.bitrix24.by@evil.com')).toBe('evil.com')
  })
  it('returns empty for blank / unparseable input (→ fail-closed)', () => {
    expect(portalHostname('')).toBe('')
    expect(portalHostname('   ')).toBe('')
  })
})

describe('parseSelfHostedHosts', () => {
  it('parses a comma/space/newline list into normalized bare hosts', () => {
    expect([...parseSelfHostedHosts('b24.acme.tld, https://portal.corp.local\n  crm.example.org')])
      .toEqual(['b24.acme.tld', 'portal.corp.local', 'crm.example.org'])
  })
  it('is empty for undefined / blank (cloud-only default)', () => {
    expect(parseSelfHostedHosts(undefined).size).toBe(0)
    expect(parseSelfHostedHosts('   ').size).toBe(0)
  })
})

describe('isAllowedPortalHost (SSRF gate #149)', () => {
  it('allows cloud *.bitrix24.<tld> portals', () => {
    expect(isAllowedPortalHost('acme.bitrix24.by')).toBe(true)
    expect(isAllowedPortalHost('acme.bitrix24.com')).toBe(true)
    expect(isAllowedPortalHost('acme.bitrix24.com.br')).toBe(true)
    expect(isAllowedPortalHost('https://acme.bitrix24.de/rest/')).toBe(true)
  })
  it('allows the international regional zones (DPA-listed) — «портал может быть в любой стране»', () => {
    for (const h of ['acme.bitrix24.jp', 'acme.bitrix24.com.tr', 'acme.bitrix24.in',
      'acme.bitrix24.uk', 'acme.bitrix24.mx', 'acme.bitrix24.co', 'acme.bitrix24.cn',
      'acme.bitrix24.id', 'acme.bitrix24.vn']) {
      expect(isAllowedPortalHost(h)).toBe(true)
    }
  })
  it('rejects look-alike hosts (leading-dot suffix guard)', () => {
    expect(isAllowedPortalHost('evil-bitrix24.by')).toBe(false) // no dot before bitrix24
    expect(isAllowedPortalHost('acme.bitrix24.by.attacker.com')).toBe(false) // suffix in the middle
    expect(isAllowedPortalHost('bitrix24.by')).toBe(false) // bare apex, not a portal subdomain
  })
  it('rejects internal / arbitrary hosts (the SSRF targets)', () => {
    expect(isAllowedPortalHost('localhost')).toBe(false)
    expect(isAllowedPortalHost('169.254.169.254')).toBe(false) // cloud metadata endpoint
    expect(isAllowedPortalHost('internal.svc.cluster.local')).toBe(false)
    expect(isAllowedPortalHost('')).toBe(false)
  })
  it('rejects a userinfo trick — the true host is not allow-listed', () => {
    // Even though the label reads like a portal, the real host (evil.com) is rejected,
    // and restUrl fetches that same evil.com — so the request never fires.
    expect(isAllowedPortalHost('x.bitrix24.by@evil.com')).toBe(false)
  })
  it('allows an exact self-hosted host from the configured set, and nothing near it', () => {
    const selfHosted = parseSelfHostedHosts('b24.acme.tld')
    expect(isAllowedPortalHost('b24.acme.tld', selfHosted)).toBe(true)
    expect(isAllowedPortalHost('evil.b24.acme.tld', selfHosted)).toBe(false) // exact match only
    expect(isAllowedPortalHost('b24.acme.tld.evil.com', selfHosted)).toBe(false)
  })
})

describe('b24ErrorMessage', () => {
  it('returns null for a success body (no error field)', () => {
    expect(b24ErrorMessage({ result: { id: 1 } })).toBeNull()
    expect(b24ErrorMessage({ result: true })).toBeNull()
    expect(b24ErrorMessage({ error: '' })).toBeNull() // empty error string = not an error
  })
  it('reports error with description when present', () => {
    expect(b24ErrorMessage({ error: 'NOT_FOUND', error_description: 'Not found.' })).toBe('NOT_FOUND: Not found.')
  })
  it('reports the bare error code when there is no description', () => {
    expect(b24ErrorMessage({ error: 'insufficient_scope' })).toBe('insufficient_scope')
  })
})

// The SECURITY BOUNDARY is the gate INSIDE callRest — the pure predicate tests above don't
// prove callRest actually calls it. These pin that a non-allow-listed host is refused BEFORE
// any network call (the reject path throws before touching $fetch), and that an allow-listed
// host is let PAST the gate to the transport (proves the gate is host-conditional, not a
// blanket throw). $fetch is a Nitro global absent in the node unit env — stub it for the
// pass-through case; the reject cases never reach it.
describe('callRest SSRF gate (#149)', () => {
  const g = globalThis as unknown as { $fetch?: unknown }
  afterEach(() => {
    delete g.$fetch
  })

  it('refuses the metadata endpoint before any network call', async () => {
    await expect(callRest('169.254.169.254', 'secret', 'app.info')).rejects.toThrow(/not allow-listed/)
  })
  it('refuses localhost / internal hosts before any network call', async () => {
    await expect(callRest('localhost', 'secret', 'app.info')).rejects.toThrow(/not allow-listed/)
    await expect(callRest('internal.svc.cluster.local', 'secret', 'app.info')).rejects.toThrow(/not allow-listed/)
  })
  it('refuses the userinfo trick (true host evil.com) before any network call', async () => {
    await expect(callRest('x.bitrix24.by@evil.com', 'secret', 'app.info')).rejects.toThrow(/not allow-listed/)
  })
  it('lets an allow-listed cloud host PAST the gate to the transport (host-conditional, not blanket)', async () => {
    // Stub the transport with a sentinel — an allowed host must reach it, NOT be rejected at
    // the gate. A blanket-throw regression would surface /not allow-listed/ here and fail.
    g.$fetch = async () => {
      throw new Error('TRANSPORT_REACHED')
    }
    await expect(callRest('acme.bitrix24.by', 'secret', 'app.info')).rejects.toThrow('TRANSPORT_REACHED')
  })
})

describe('B24RestError + isExpiredTokenError (reactive retry)', () => {
  const g = globalThis as unknown as { $fetch?: unknown }
  afterEach(() => {
    delete g.$fetch
  })

  it('isExpiredTokenError is true only for expired_token / invalid_token codes', () => {
    expect(isExpiredTokenError(new B24RestError('expired_token', 'x', 'm'))).toBe(true)
    expect(isExpiredTokenError(new B24RestError('invalid_token', '', 'm'))).toBe(true)
    expect(isExpiredTokenError(new B24RestError('QUERY_LIMIT_EXCEEDED', '', 'm'))).toBe(false)
    expect(isExpiredTokenError(new Error('expired_token'))).toBe(false) // plain Error, no code
    expect(isExpiredTokenError('expired_token')).toBe(false)
  })

  it('callRest throws a B24RestError carrying the error code on a 200+{error} body', async () => {
    g.$fetch = async () => ({ error: 'expired_token', error_description: 'The access token provided has expired' })
    const err = await callRest('acme.bitrix24.by', 'tok', 'crm.item.list').catch(e => e)
    expect(err).toBeInstanceOf(B24RestError)
    expect((err as B24RestError).code).toBe('expired_token')
    expect(isExpiredTokenError(err)).toBe(true)
    // message unchanged so `.message`-matching callers still work
    expect((err as Error).message).toBe('B24 REST crm.item.list failed — expired_token: The access token provided has expired')
  })

  it('a non-auth B24 error is a B24RestError but NOT an expired-token error', async () => {
    g.$fetch = async () => ({ error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' })
    const err = await callRest('acme.bitrix24.by', 'tok', 'crm.item.list').catch(e => e)
    expect(err).toBeInstanceOf(B24RestError)
    expect(isExpiredTokenError(err)).toBe(false)
  })

  // The REAL production shape: B24 returns `expired_token` as HTTP 401, so ofetch THROWS a
  // FetchError before the 200-body check ever runs. The thrown error carries the parsed body
  // on `.data`. Without classifying that, `isExpiredTokenError` is always false in prod and the
  // reactive-retry surface is dead code. Simulate a FetchError-like throw with `.data`.
  it('classifies a THROWN non-2xx response (401 expired_token) into a typed B24RestError', async () => {
    g.$fetch = async () => {
      const e = new Error('[POST] "…": 401 Unauthorized') as Error & { data?: unknown, status?: number }
      e.data = { error: 'expired_token', error_description: 'The access token provided has expired' }
      e.status = 401
      throw e
    }
    const err = await callRest('acme.bitrix24.by', 'tok', 'crm.item.list').catch(e => e)
    expect(err).toBeInstanceOf(B24RestError)
    expect((err as B24RestError).code).toBe('expired_token')
    expect(isExpiredTokenError(err)).toBe(true)
    expect((err as Error).message).toBe('B24 REST crm.item.list failed — expired_token: The access token provided has expired')
  })

  it('classifies a THROWN non-2xx invalid_token body too (both are expiry codes)', async () => {
    g.$fetch = async () => {
      const e = new Error('401') as Error & { data?: unknown }
      e.data = { error: 'invalid_token', error_description: 'bad token' }
      throw e
    }
    const err = await callRest('acme.bitrix24.by', 'tok', 'crm.item.list').catch(e => e)
    expect(isExpiredTokenError(err)).toBe(true)
  })

  it('propagates a raw transport error (no B24 body) unchanged — not a B24RestError', async () => {
    const network = new Error('fetch failed: ECONNRESET')
    g.$fetch = async () => {
      throw network
    }
    const err = await callRest('acme.bitrix24.by', 'tok', 'crm.item.list').catch(e => e)
    expect(err).toBe(network) // same instance, not wrapped
    expect(err).not.toBeInstanceOf(B24RestError)
    expect(isExpiredTokenError(err)).toBe(false)
  })

  it('propagates a thrown non-2xx whose body is NOT a B24 error (e.g. HTML 502) unchanged', async () => {
    const gateway = new Error('502 Bad Gateway') as Error & { data?: unknown }
    gateway.data = '<html>Bad Gateway</html>' // string body, no {error}
    g.$fetch = async () => {
      throw gateway
    }
    const err = await callRest('acme.bitrix24.by', 'tok', 'crm.item.list').catch(e => e)
    expect(err).toBe(gateway)
    expect(err).not.toBeInstanceOf(B24RestError)
  })

  it('propagates a thrown non-2xx whose .data is an OBJECT but not a B24 {error} (e.g. proxy JSON) unchanged', async () => {
    // The middle arm of the catch: `.data` passes the `typeof === 'object'` guard but
    // `b24RestErrorFrom` returns null (no `error` field) → must fall through to `throw e` raw,
    // NOT become a bogus B24RestError with an empty code.
    const proxy = new Error('500') as Error & { data?: unknown }
    proxy.data = { result: false, status: 'gateway-timeout' } // object, no `error`
    g.$fetch = async () => {
      throw proxy
    }
    const err = await callRest('acme.bitrix24.by', 'tok', 'crm.item.list').catch(e => e)
    expect(err).toBe(proxy)
    expect(err).not.toBeInstanceOf(B24RestError)
  })
})

describe('b24RestErrorFrom (shared classifier)', () => {
  it('builds a typed error from a {error, error_description} body', () => {
    const e = b24RestErrorFrom('crm.item.list', { error: 'expired_token', error_description: 'expired' })
    expect(e).toBeInstanceOf(B24RestError)
    expect(e!.code).toBe('expired_token')
    expect(e!.description).toBe('expired')
    expect(e!.message).toBe('B24 REST crm.item.list failed — expired_token: expired')
  })
  it('uses the bare code as the message when there is no description', () => {
    const e = b24RestErrorFrom('profile', { error: 'insufficient_scope' })
    expect(e!.code).toBe('insufficient_scope')
    expect(e!.description).toBe('')
    expect(e!.message).toBe('B24 REST profile failed — insufficient_scope')
  })
  it('returns null for a success body (no error) so callers keep the result', () => {
    expect(b24RestErrorFrom('x', { result: { id: 1 } })).toBeNull()
    expect(b24RestErrorFrom('x', { error: '' })).toBeNull()
  })
})
