import { describe, expect, it } from 'vitest'
import {
  B24_CSP_HOSTS,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  securityHeadersEnabled
} from '../server/utils/securityHeaders'

describe('securityHeadersEnabled', () => {
  it('is OFF by default (unset / empty / "0") — nginx path unchanged', () => {
    expect(securityHeadersEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(securityHeadersEnabled({ SECURITY_HEADERS_ENABLED: '' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(securityHeadersEnabled({ SECURITY_HEADERS_ENABLED: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false)
  })
  it('is ON for any other value', () => {
    expect(securityHeadersEnabled({ SECURITY_HEADERS_ENABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(securityHeadersEnabled({ SECURITY_HEADERS_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })
})

describe('buildContentSecurityPolicy', () => {
  const csp = buildContentSecurityPolicy()
  it('locks down the dangerous directives', () => {
    expect(csp).toContain('default-src \'self\'')
    expect(csp).toContain('object-src \'none\'')
    expect(csp).toContain('base-uri \'self\'')
  })
  it('allows the Bitrix24 embed + fetch allowlist (frame-ancestors + connect-src)', () => {
    expect(csp).toContain('frame-ancestors')
    for (const host of B24_CSP_HOSTS) expect(csp).toContain(host)
    expect(csp).toContain('connect-src')
  })
  it('permits the landing Yandex.Metrika snippet', () => {
    expect(csp).toContain('https://mc.yandex.ru')
  })
  it('does NOT set X-Frame-Options via CSP (frame-ancestors expresses the allowlist instead)', () => {
    // sanity: the CSP string is the only framing control here
    expect(csp).not.toContain('X-Frame-Options')
  })
})

describe('buildSecurityHeaders', () => {
  it('always sets nosniff / Referrer-Policy / Permissions-Policy / CSP', () => {
    const h = buildSecurityHeaders({ https: false })
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(h['Permissions-Policy']).toContain('geolocation=()')
    expect(h['Content-Security-Policy']).toContain('default-src \'self\'')
  })
  it('emits HSTS only over HTTPS (pointless on plain HTTP)', () => {
    expect(buildSecurityHeaders({ https: false })['Strict-Transport-Security']).toBeUndefined()
    expect(buildSecurityHeaders({ https: true })['Strict-Transport-Security']).toContain('max-age=31536000')
  })
  it('omits X-Frame-Options (CSP frame-ancestors is the allowlist-capable control)', () => {
    expect(buildSecurityHeaders({ https: true })['X-Frame-Options']).toBeUndefined()
  })
})
