import { describe, expect, it } from 'vitest'
import {
  b24ErrorMessage,
  isAllowedPortalHost,
  parseSelfHostedHosts,
  portalHostname,
  restUrl
} from '../server/utils/b24Rest'

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
