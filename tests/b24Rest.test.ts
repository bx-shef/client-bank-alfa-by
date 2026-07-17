import { describe, expect, it } from 'vitest'
import {
  assertPortalHost,
  isAllowedPortalHost,
  parseSelfHostedHosts,
  portalHostname
} from '../server/utils/b24Rest'

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
    expect(isAllowedPortalHost('x.bitrix24.by@evil.com')).toBe(false)
  })
  it('allows an exact self-hosted host from the configured set, and nothing near it', () => {
    const selfHosted = parseSelfHostedHosts('b24.acme.tld')
    expect(isAllowedPortalHost('b24.acme.tld', selfHosted)).toBe(true)
    expect(isAllowedPortalHost('evil.b24.acme.tld', selfHosted)).toBe(false) // exact match only
    expect(isAllowedPortalHost('b24.acme.tld.evil.com', selfHosted)).toBe(false)
  })
})

describe('assertPortalHost (shared SSRF choke point for the jssdk frame client)', () => {
  it('returns the CLEAN parsed host for an allow-listed cloud portal', () => {
    expect(assertPortalHost('Acme.Bitrix24.BY')).toBe('acme.bitrix24.by')
    expect(assertPortalHost('https://acme.bitrix24.de/rest/')).toBe('acme.bitrix24.de')
  })
  it('THROWS on a non-allow-listed host (before any client is built)', () => {
    expect(() => assertPortalHost('169.254.169.254')).toThrow(/not allow-listed/)
    expect(() => assertPortalHost('localhost')).toThrow(/not allow-listed/)
    expect(() => assertPortalHost('')).toThrow(/not allow-listed/)
  })
  it('THROWS on the userinfo trick — the real host (evil.com), the SDK would fetch, is rejected', () => {
    // The clean host it would otherwise return is evil.com; that is not a portal → throw, so the
    // SDK client is never built for it. Load-bearing: passing the parsed host (not the raw label)
    // means a pass would have targeted evil.com, so rejecting the real host is the correct gate.
    expect(() => assertPortalHost('x.bitrix24.by@evil.com')).toThrow(/not allow-listed/)
  })
})
