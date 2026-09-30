import { describe, expect, it } from 'vitest'
import {
  appTokenVerdict,
  B24_EVENT_INSTALL,
  B24_EVENT_UNINSTALL,
  eventCode,
  extractPortalCredentials,
  isInstallComplete,
  isSafeClientEndpoint,
  parseBracketForm,
  parseInstallEvent,
  parseSystemUserEvent,
  parseUninstallEvent,
  safeEqual,
  verifyApplicationToken
} from '~/utils/b24Events'

// Payloads modelled on the official REST docs (common/events/on-app-install,
// on-app-uninstall). `application_token` is the per-portal shared secret.
const APP_TOKEN = '51856fefc120afa4b628cc82d3935cce'

const installPayload = {
  event: 'ONAPPINSTALL',
  data: { VERSION: '1.0.0', ACTIVE: 'Y', INSTALLED: 'Y', LANGUAGE_ID: 'ru' },
  ts: '1696527000',
  auth: {
    domain: 'some-domain.bitrix24.ru',
    server_endpoint: 'https://oauth.bitrix24.tech/rest/',
    status: 'F',
    client_endpoint: 'https://some-domain.bitrix24.ru/rest/',
    member_id: 'a223c6b3710f85df22e9377d6c4f7553',
    application_token: APP_TOKEN,
    access_token: 'AAA',
    refresh_token: 'RRR',
    expires_in: 3600,
    scope: 'crm,im'
  }
}

const uninstallPayload = {
  event: 'ONAPPUNINSTALL',
  data: { LANGUAGE_ID: 'ru', CLEAN: 1 },
  ts: '1466439714',
  auth: {
    domain: 'some-domain.bitrix24.ru',
    member_id: 'a223c6b3710f85df22e9377d6c4f7553',
    application_token: APP_TOKEN
  }
}

describe('parseBracketForm', () => {
  it('restores a nested object from PHP bracket-encoded form body', () => {
    const raw = 'event=ONAPPINSTALL&data[VERSION]=1&data[INSTALLED]=Y&auth[member_id]=m1&auth[application_token]=t1'
    expect(parseBracketForm(raw)).toEqual({
      event: 'ONAPPINSTALL',
      data: { VERSION: '1', INSTALLED: 'Y' },
      auth: { member_id: 'm1', application_token: 't1' }
    })
  })

  it('handles deep nesting (data[bot][id])', () => {
    expect(parseBracketForm('data[bot][id]=7')).toEqual({ data: { bot: { id: '7' } } })
  })

  it('round-trips into parseInstallEvent', () => {
    const raw = 'event=ONAPPINSTALL&data[VERSION]=2&auth[domain]=d&auth[member_id]=m&auth[application_token]=tok'
    const event = parseInstallEvent(parseBracketForm(raw))
    expect(event.auth.application_token).toBe('tok')
    expect(event.data.VERSION).toBe('2')
  })

  it('returns an empty object for an empty body', () => {
    expect(parseBracketForm('')).toEqual({})
  })

  it('does not pollute Object.prototype via __proto__/constructor/prototype keys', () => {
    parseBracketForm('__proto__[polluted]=yes')
    parseBracketForm('auth[__proto__][polluted]=yes')
    parseBracketForm('constructor[prototype][polluted]=yes')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
  })
})

describe('eventCode', () => {
  it('upper-cases the event code for case-insensitive routing', () => {
    expect(eventCode({ event: 'OnAppInstall' })).toBe('ONAPPINSTALL')
  })
  it('returns empty string when absent or non-string', () => {
    expect(eventCode({})).toBe('')
    expect(eventCode(null)).toBe('')
    expect(eventCode({ event: 42 })).toBe('')
  })
})

describe('safeEqual / verifyApplicationToken', () => {
  it('matches equal strings and rejects different ones', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'ab')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
  it('verifyApplicationToken needs both sides non-empty', () => {
    expect(verifyApplicationToken(APP_TOKEN, APP_TOKEN)).toBe(true)
    expect(verifyApplicationToken(APP_TOKEN, 'other')).toBe(false)
    expect(verifyApplicationToken('', APP_TOKEN)).toBe(false)
    expect(verifyApplicationToken(APP_TOKEN, undefined)).toBe(false)
  })
})

describe('appTokenVerdict', () => {
  it('bootstraps install with any non-empty token (authentication is the OAuth binding, #162)', () => {
    expect(appTokenVerdict({ isInstall: true, incoming: APP_TOKEN })).toBe('accept')
    expect(appTokenVerdict({ isInstall: true, incoming: '' })).toBe('forbidden')
  })
  it('is fail-closed for non-install events with no expected token', () => {
    expect(appTokenVerdict({ isInstall: false, incoming: APP_TOKEN })).toBe('unconfigured')
  })
  it('accepts a non-install event matching the stored token', () => {
    expect(appTokenVerdict({ isInstall: false, incoming: APP_TOKEN, storedToken: APP_TOKEN })).toBe('accept')
    expect(appTokenVerdict({ isInstall: false, incoming: 'x', storedToken: APP_TOKEN })).toBe('forbidden')
  })
  it('ignores storedToken on install (bootstrap accepts any non-empty token)', () => {
    expect(appTokenVerdict({ isInstall: true, incoming: 'whatever', storedToken: 'db' })).toBe('accept')
  })
})

describe('parseInstallEvent', () => {
  it('parses a valid ONAPPINSTALL payload', () => {
    const event = parseInstallEvent(installPayload)
    expect(event.auth.member_id).toBe('a223c6b3710f85df22e9377d6c4f7553')
    expect(event.data.VERSION).toBe('1.0.0')
  })
  it('throws on the wrong event code', () => {
    expect(() => parseInstallEvent(uninstallPayload)).toThrow(/expected ONAPPINSTALL/)
  })
  it('throws when auth fields are missing', () => {
    expect(() => parseInstallEvent({ event: 'ONAPPINSTALL', data: { VERSION: '1' }, auth: { domain: 'd' } }))
      .toThrow(/member_id\/application_token/)
  })
  it('throws when data.VERSION is missing', () => {
    expect(() => parseInstallEvent({ ...installPayload, data: { LANGUAGE_ID: 'ru' } }))
      .toThrow(/missing data.VERSION/)
  })
})

describe('parseUninstallEvent', () => {
  it('parses a valid ONAPPUNINSTALL payload', () => {
    const event = parseUninstallEvent(uninstallPayload)
    expect(event.auth.member_id).toBe('a223c6b3710f85df22e9377d6c4f7553')
    expect(event.data.CLEAN).toBe(1)
  })
  it('throws on the wrong event code', () => {
    expect(() => parseUninstallEvent(installPayload)).toThrow(/expected ONAPPUNINSTALL/)
  })
  it('throws when auth fields are missing', () => {
    expect(() => parseUninstallEvent({ event: 'ONAPPUNINSTALL', auth: { domain: 'd' } }))
      .toThrow(/member_id\/application_token/)
  })
  it('rejects an object injected on a string auth field', () => {
    const injected = parseBracketForm('event=ONAPPUNINSTALL&auth[domain][x]=1&auth[member_id]=m&auth[application_token]=t')
    expect(() => parseUninstallEvent(injected)).toThrow(/auth is missing/)
  })
  it('defaults data to {} when absent', () => {
    const event = parseUninstallEvent({
      event: 'ONAPPUNINSTALL',
      auth: { domain: 'd', member_id: 'm', application_token: 't' }
    })
    expect(event.data).toEqual({})
  })
})

describe('parseSystemUserEvent (ONAPPUSERREADY)', () => {
  // Shape from the official doc (common/events/on-app-user-ready) as it arrives on the wire:
  // form-encoded, so every leaf is a string.
  const wire = 'event=ONAPPUSERREADY&data[access_token]=SYS_A&data[refresh_token]=SYS_R&data[expires_in]=3600'
    + '&data[member_id]=a223c6b3710f85df22e9377d6c4f7553&data[user_id]=512&data[status]=S'
    + '&ts=1756890123&auth[domain]=some-domain.bitrix24.ru&auth[member_id]=a223c6b3710f85df22e9377d6c4f7553'
    + `&auth[user_id]=1&auth[application_token]=${APP_TOKEN}&auth[access_token]=INST_A`
  const payload = () => parseBracketForm(wire)

  it('takes the system user id from data and the app token from auth', () => {
    expect(parseSystemUserEvent(payload())).toEqual({
      memberId: 'a223c6b3710f85df22e9377d6c4f7553',
      userId: 512,
      applicationToken: APP_TOKEN
    })
  })

  it('never returns the long-lived authorization of the system user', () => {
    // We need the id, not one more permanent key to the client's portal.
    const text = JSON.stringify(parseSystemUserEvent(payload()))
    expect(text).not.toContain('SYS_A')
    expect(text).not.toContain('SYS_R')
  })

  it('takes data.user_id, not auth.user_id (that one is the installer)', () => {
    expect(parseSystemUserEvent(payload()).userId).toBe(512)
  })

  it.each([['0'], ['-5'], ['0x11'], ['1e1'], ['9007199254740993'], ['abc'], ['']])(
    'rejects a user id the portal would not have sent: %j', (raw) => {
      // It becomes the responsible of CRM elements, and whether the portal validates that field
      // there is not measured: '0x11' would be user 17, a digit string past 2^53 somebody else.
      const p = payload() as { data: Record<string, unknown> }
      p.data.user_id = raw
      expect(() => parseSystemUserEvent(p)).toThrow(/user_id/)
    })

  // The only event whose fields may reach the queue before authentication: a forged request must not
  // park megabytes in Redis nor forge log lines with a newline (review of #783).
  it.each([
    ['member_id', 'x'.repeat(65)],
    ['member_id', 'abc\n[auth] ERROR: fake'],
    ['member_id', 'a b'],
    ['application_token', 't'.repeat(129)],
    ['application_token', 'tok\r\nX'],
    ['domain', 'evil.example\n[auth] ERROR: fake'],
    ['domain', 'a b'],
    ['domain', 'a'.repeat(254)]
  ])('rejects a malformed auth.%s before anything looks at it', (field, value) => {
    const p = payload() as { auth: Record<string, unknown> }
    p.auth[field] = value
    expect(() => parseSystemUserEvent(p)).toThrow(new RegExp(`malformed ${field}`))
  })

  it.each([['1756890123abc'], ['1'.repeat(13)], ['-1']])('rejects a malformed ts %j', (ts) => {
    const p = payload() as Record<string, unknown>
    p.ts = ts
    expect(() => parseSystemUserEvent(p)).toThrow(/malformed ts/)
  })

  it('error messages name the field and never echo the attacker-controlled value', () => {
    const p = payload() as { auth: Record<string, unknown> }
    p.auth.member_id = 'SECRET-LOOKING-VALUE\n'
    expect(() => parseSystemUserEvent(p)).toThrow(/^(?!.*SECRET-LOOKING-VALUE).*$/s)
  })

  it.each([
    ['portal.example.by:8443'], // коробка с портом
    ['crm_portal.local'], // подчёркивание во внутреннем имени (находка ревью #783)
    ['crm.компания.рф'], // кириллический адрес коробки, если портал пришлёт его как есть
    ['[2001:db8::1]:8080'] // IPv6-литерал
  ])('accepts the host shapes real portals send: %s', (domain) => {
    // The domain is only bounded: nothing on this path calls the portal by it, and a strict host
    // pattern silently lost the system user of a legitimate box.
    const p = payload() as { auth: Record<string, unknown> }
    p.auth.domain = domain
    expect(parseSystemUserEvent(p).userId).toBe(512)
  })

  it('rejects an event whose data and auth name different portals', () => {
    const p = payload() as { data: Record<string, unknown> }
    p.data.member_id = 'someone-else'
    expect(() => parseSystemUserEvent(p)).toThrow(/member_id/)
  })

  it('accepts an event without data.member_id — auth is what the app token authenticates', () => {
    const p = payload() as { data: Record<string, unknown> }
    delete p.data.member_id
    expect(parseSystemUserEvent(p).memberId).toBe('a223c6b3710f85df22e9377d6c4f7553')
  })

  it('rejects a missing data block, a missing app token and a different event', () => {
    const noData = payload() as Record<string, unknown>
    delete noData.data
    expect(() => parseSystemUserEvent(noData)).toThrow(/data/)
    const noToken = payload() as { auth: Record<string, unknown> }
    delete noToken.auth.application_token
    expect(() => parseSystemUserEvent(noToken)).toThrow()
    expect(() => parseSystemUserEvent(installPayload)).toThrow(/ONAPPUSERREADY/)
  })
})

describe('extractPortalCredentials', () => {
  it('maps the auth block to stored credentials, omitting absent fields', () => {
    const creds = extractPortalCredentials(parseInstallEvent(installPayload))
    expect(creds).toEqual({
      memberId: 'a223c6b3710f85df22e9377d6c4f7553',
      domain: 'some-domain.bitrix24.ru',
      applicationToken: APP_TOKEN,
      clientEndpoint: 'https://some-domain.bitrix24.ru/rest/',
      serverEndpoint: 'https://oauth.bitrix24.tech/rest/',
      accessToken: 'AAA',
      refreshToken: 'RRR',
      expiresIn: 3600,
      scope: 'crm,im'
    })
  })
  it('omits OAuth fields when the event carries none', () => {
    const minimal = {
      event: 'ONAPPINSTALL',
      data: { VERSION: '1' },
      auth: { domain: 'd', member_id: 'm', application_token: 't' }
    }
    expect(extractPortalCredentials(parseInstallEvent(minimal))).toEqual({
      memberId: 'm',
      domain: 'd',
      applicationToken: 't'
    })
  })
})

describe('isInstallComplete', () => {
  it('treats INSTALLED=Y (or absent) as complete', () => {
    expect(isInstallComplete({ VERSION: '1', LANGUAGE_ID: 'ru', INSTALLED: 'Y' })).toBe(true)
    expect(isInstallComplete({ VERSION: '1', LANGUAGE_ID: 'ru' })).toBe(true)
    expect(isInstallComplete({ VERSION: '1', LANGUAGE_ID: 'ru', INSTALLED: 'N' })).toBe(false)
  })
})

describe('isSafeClientEndpoint', () => {
  it('accepts an https portal endpoint', () => {
    expect(isSafeClientEndpoint('https://some-domain.bitrix24.ru/rest/')).toBe(true)
  })
  it('rejects non-https, loopback and private hosts', () => {
    expect(isSafeClientEndpoint('http://some-domain.bitrix24.ru/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://localhost/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://127.0.0.1/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://0.0.0.0/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://10.0.0.5/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://192.168.1.1/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://169.254.1.1/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://172.16.0.1/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://172.31.255.255/rest/')).toBe(false)
    expect(isSafeClientEndpoint(undefined)).toBe(false)
    expect(isSafeClientEndpoint('not a url')).toBe(false)
  })
  it('rejects IPv6 loopback, ULA, link-local and IPv4-mapped private', () => {
    expect(isSafeClientEndpoint('https://[::1]/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://[::]/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://[fc00::1]/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://[fd12:3456::1]/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://[fe80::1]/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://[::ffff:127.0.0.1]/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://[::ffff:10.0.0.1]/rest/')).toBe(false)
  })
  it('blocks IPv4 written in octal/decimal forms (normalized by URL)', () => {
    expect(isSafeClientEndpoint('https://0177.0.0.1/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://2130706433/rest/')).toBe(false)
  })
  it('allows public IPs outside the private ranges', () => {
    expect(isSafeClientEndpoint('https://172.15.0.1/rest/')).toBe(true)
    expect(isSafeClientEndpoint('https://172.32.0.1/rest/')).toBe(true)
    expect(isSafeClientEndpoint('https://8.8.8.8/rest/')).toBe(true)
    expect(isSafeClientEndpoint('https://[2606:4700::1111]/rest/')).toBe(true)
  })
})

describe('event-code constants', () => {
  it('exposes the canonical event-code constants', () => {
    expect(B24_EVENT_INSTALL).toBe('ONAPPINSTALL')
    expect(B24_EVENT_UNINSTALL).toBe('ONAPPUNINSTALL')
  })
})
