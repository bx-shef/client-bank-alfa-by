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
  routeB24Event,
  safeEqual,
  shouldPurgeData,
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
  })
  it('verifyApplicationToken needs both sides non-empty', () => {
    expect(verifyApplicationToken(APP_TOKEN, APP_TOKEN)).toBe(true)
    expect(verifyApplicationToken(APP_TOKEN, 'other')).toBe(false)
    expect(verifyApplicationToken('', APP_TOKEN)).toBe(false)
    expect(verifyApplicationToken(APP_TOKEN, undefined)).toBe(false)
  })
})

describe('appTokenVerdict', () => {
  it('bootstraps install with any non-empty token when no env token', () => {
    expect(appTokenVerdict({ isInstall: true, incoming: APP_TOKEN })).toBe('accept')
    expect(appTokenVerdict({ isInstall: true, incoming: '' })).toBe('forbidden')
  })
  it('enforces the env token on install when configured', () => {
    expect(appTokenVerdict({ isInstall: true, incoming: APP_TOKEN, envToken: APP_TOKEN })).toBe('accept')
    expect(appTokenVerdict({ isInstall: true, incoming: 'x', envToken: APP_TOKEN })).toBe('forbidden')
  })
  it('is fail-closed for non-install events with no expected token', () => {
    expect(appTokenVerdict({ isInstall: false, incoming: APP_TOKEN })).toBe('unconfigured')
  })
  it('accepts a non-install event matching the stored token', () => {
    expect(appTokenVerdict({ isInstall: false, incoming: APP_TOKEN, storedToken: APP_TOKEN })).toBe('accept')
    expect(appTokenVerdict({ isInstall: false, incoming: 'x', storedToken: APP_TOKEN })).toBe('forbidden')
  })
  it('prefers the env token over the stored one', () => {
    expect(appTokenVerdict({ isInstall: false, incoming: 'env', envToken: 'env', storedToken: 'db' })).toBe('accept')
    expect(appTokenVerdict({ isInstall: false, incoming: 'db', envToken: 'env', storedToken: 'db' })).toBe('forbidden')
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

describe('isInstallComplete / shouldPurgeData', () => {
  it('treats INSTALLED=Y (or absent) as complete', () => {
    expect(isInstallComplete({ VERSION: '1', LANGUAGE_ID: 'ru', INSTALLED: 'Y' })).toBe(true)
    expect(isInstallComplete({ VERSION: '1', LANGUAGE_ID: 'ru' })).toBe(true)
    expect(isInstallComplete({ VERSION: '1', LANGUAGE_ID: 'ru', INSTALLED: 'N' })).toBe(false)
  })
  it('purges only when CLEAN is 1 or "1"', () => {
    expect(shouldPurgeData({ LANGUAGE_ID: 'ru', CLEAN: 1 })).toBe(true)
    expect(shouldPurgeData({ LANGUAGE_ID: 'ru', CLEAN: '1' })).toBe(true)
    expect(shouldPurgeData({ LANGUAGE_ID: 'ru', CLEAN: 0 })).toBe(false)
    expect(shouldPurgeData({ LANGUAGE_ID: 'ru', CLEAN: '0' })).toBe(false)
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
    expect(isSafeClientEndpoint('https://10.0.0.5/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://192.168.1.1/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://169.254.1.1/rest/')).toBe(false)
    expect(isSafeClientEndpoint('https://172.16.0.1/rest/')).toBe(false)
    expect(isSafeClientEndpoint(undefined)).toBe(false)
    expect(isSafeClientEndpoint('not a url')).toBe(false)
  })
  it('allows public IPs outside the private ranges', () => {
    expect(isSafeClientEndpoint('https://172.15.0.1/rest/')).toBe(true)
    expect(isSafeClientEndpoint('https://8.8.8.8/rest/')).toBe(true)
  })
})

describe('routeB24Event', () => {
  it('routes a valid install to a persist decision', () => {
    const decision = routeB24Event(installPayload)
    expect(decision.kind).toBe('install')
    if (decision.kind === 'install') {
      expect(decision.credentials.applicationToken).toBe(APP_TOKEN)
    }
  })

  it('rejects an install with an empty token (probe)', () => {
    const bad = { ...installPayload, auth: { ...installPayload.auth, application_token: '' } }
    expect(() => routeB24Event(bad)).toThrow(/auth is missing|rejected/)
  })

  it('enforces the env token on install', () => {
    expect(() => routeB24Event(installPayload, { envToken: 'different' }))
      .toThrow(/ONAPPINSTALL: application_token rejected \(forbidden\)/)
    expect(routeB24Event(installPayload, { envToken: APP_TOKEN }).kind).toBe('install')
  })

  it('routes a verified uninstall to a purge decision', () => {
    const decision = routeB24Event(uninstallPayload, { storedToken: APP_TOKEN })
    expect(decision).toMatchObject({ kind: 'uninstall', purge: true, memberId: uninstallPayload.auth.member_id })
  })

  it('keeps data when uninstall CLEAN is 0', () => {
    const keep = { ...uninstallPayload, data: { LANGUAGE_ID: 'ru', CLEAN: 0 } }
    const decision = routeB24Event(keep, { storedToken: APP_TOKEN })
    expect(decision).toMatchObject({ kind: 'uninstall', purge: false })
  })

  it('throws on an uninstall with no stored token (unconfigured, fail-closed)', () => {
    expect(() => routeB24Event(uninstallPayload)).toThrow(/rejected \(unconfigured\)/)
  })

  it('throws on an uninstall with a mismatched token (forbidden)', () => {
    expect(() => routeB24Event(uninstallPayload, { storedToken: 'forged' }))
      .toThrow(/rejected \(forbidden\)/)
  })

  it('returns unsupported for events we do not subscribe to', () => {
    expect(routeB24Event({ event: 'ONCRMDEALADD', auth: { application_token: 'x' } }))
      .toEqual({ kind: 'unsupported', code: 'ONCRMDEALADD' })
  })

  it('exposes the canonical event-code constants', () => {
    expect(B24_EVENT_INSTALL).toBe('ONAPPINSTALL')
    expect(B24_EVENT_UNINSTALL).toBe('ONAPPUNINSTALL')
  })
})
