import { describe, expect, it, vi } from 'vitest'
import {
  buildPriorConnectUrl,
  priorConnectConfigFromEnv,
  priorConsentExpiry,
  PRIOR_CONSENT_SCOPE,
  type PriorConnectConfig,
  type PriorConnectDeps
} from '../server/utils/priorConnectStart'
import { PRIOR_API_PREFIXES } from '../app/utils/priorOauth'
import { Buffer } from 'node:buffer'

const config: PriorConnectConfig = {
  baseUrl: 'https://api.priorbank.by:9344',
  clientId: 'CLIENT-1',
  clientSecret: 'SECRET-1',
  redirectUri: 'https://app.example/api/bank/callback',
  audience: 'https://api.priorbank.by:9544/oauth2/token',
  privateKeyPem: '-----BEGIN PRIVATE KEY-----FAKE-----END PRIVATE KEY-----',
  kid: 'prior-key-1'
}
const NOW_MS = Date.parse('2026-07-28T00:00:00Z')

function fakeDeps(over: Partial<PriorConnectDeps> & { tokenRaw?: unknown, consentRaw?: unknown } = {}) {
  const calls = {
    tokenUrl: [] as string[],
    tokenBody: [] as string[],
    tokenCreds: [] as { clientId: string, clientSecret: string }[],
    consentUrl: [] as string[],
    consentToken: [] as string[],
    consentBody: [] as unknown[],
    signed: [] as { payload: Record<string, unknown>, kid: string }[]
  }
  let idCounter = 0
  const deps: PriorConnectDeps = {
    postToken: async (url, body, creds) => {
      calls.tokenUrl.push(url)
      calls.tokenBody.push(body)
      calls.tokenCreds.push(creds)
      return over.tokenRaw ?? { access_token: 'TOKEN-B', token_type: 'Bearer', expires_in: 3600 }
    },
    postConsent: async (url, accessToken, body) => {
      calls.consentUrl.push(url)
      calls.consentToken.push(accessToken)
      calls.consentBody.push(body)
      return over.consentRaw ?? { data: { consentId: 'INTENT-9' } }
    },
    signJwt: (payload, _pem, kid) => {
      calls.signed.push({ payload, kid })
      return `SIGNED.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.SIG`
    },
    nowSec: () => Math.floor(NOW_MS / 1000),
    newId: () => `id-${++idCounter}`,
    ...over
  }
  return { deps, calls }
}

describe('priorConsentExpiry', () => {
  it('is a yyyy-MM-dd date in the FUTURE (consent lifetime, not the statement window)', () => {
    expect(priorConsentExpiry(NOW_MS, 90)).toBe('2026-10-26')
    expect(priorConsentExpiry(NOW_MS, 1)).toBe('2026-07-29')
  })
})

describe('priorConnectConfigFromEnv', () => {
  const KEYS = [
    'PRIOR_OAUTH_API_BASE', 'PRIOR_OAUTH_CLIENT_ID', 'PRIOR_OAUTH_CLIENT_SECRET',
    'PRIOR_OAUTH_REDIRECT_URI', 'PRIOR_OAUTH_AUDIENCE', 'PRIOR_OAUTH_PRIVATE_KEY', 'PRIOR_OAUTH_KID'
  ]
  function setAll() {
    process.env.PRIOR_OAUTH_API_BASE = 'https://api.priorbank.by:9344/'
    process.env.PRIOR_OAUTH_CLIENT_ID = 'C'
    process.env.PRIOR_OAUTH_CLIENT_SECRET = 'S'
    process.env.PRIOR_OAUTH_REDIRECT_URI = 'https://app/cb'
    process.env.PRIOR_OAUTH_AUDIENCE = 'https://api.priorbank.by:9544/oauth2/token'
    process.env.PRIOR_OAUTH_PRIVATE_KEY = 'PEM'
    process.env.PRIOR_OAUTH_KID = 'k1'
  }
  function clearAll() {
    // Assign undefined rather than `delete env[dynamicKey]` (lint: no-dynamic-delete); the config
    // reader treats an undefined/blank value the same as an absent key.
    for (const k of KEYS) process.env[k] = undefined
  }

  it('null when nothing is set (feature off)', () => {
    clearAll()
    expect(priorConnectConfigFromEnv()).toBeNull()
  })

  it('builds the config and strips trailing slashes from the base', () => {
    setAll()
    try {
      expect(priorConnectConfigFromEnv()).toEqual({
        baseUrl: 'https://api.priorbank.by:9344',
        clientId: 'C',
        clientSecret: 'S',
        redirectUri: 'https://app/cb',
        audience: 'https://api.priorbank.by:9544/oauth2/token',
        privateKeyPem: 'PEM',
        kid: 'k1'
      })
    } finally {
      clearAll()
    }
  })

  it('fail-closed: ANY missing part → null (each key individually)', () => {
    for (const missing of KEYS) {
      setAll()
      process.env[missing] = ''
      try {
        expect(priorConnectConfigFromEnv(), `missing ${missing}`).toBeNull()
      } finally {
        clearAll()
      }
    }
  })

  it('fail-closed on a non-absolute base (would build a broken authorize URL)', () => {
    setAll()
    process.env.PRIOR_OAUTH_API_BASE = '/relative'
    try {
      expect(priorConnectConfigFromEnv()).toBeNull()
    } finally {
      clearAll()
    }
  })
})

describe('buildPriorConnectUrl', () => {
  it('runs token Б → consent → sign → authorize and returns the URL', async () => {
    const { deps, calls } = fakeDeps()
    const url = await buildPriorConnectUrl(config, 'SIGNED-STATE', deps, NOW_MS)

    // 1) token Б: client_credentials + scope=accounts, creds passed for the Basic header (NOT the body)
    expect(calls.tokenUrl[0]).toBe(`${config.baseUrl}${PRIOR_API_PREFIXES.AUTH}/oauth2/token`)
    expect(calls.tokenBody[0]).toContain('grant_type=client_credentials')
    expect(calls.tokenBody[0]).toContain(`scope=${PRIOR_CONSENT_SCOPE}`)
    expect(calls.tokenBody[0]).not.toContain('SECRET-1') // secret never in the body
    expect(calls.tokenCreds[0]).toEqual({ clientId: 'CLIENT-1', clientSecret: 'SECRET-1' })

    // 2) consent: posted with the token-Б bearer, expiry in the future
    expect(calls.consentUrl[0]).toBe(`${config.baseUrl}${PRIOR_API_PREFIXES.OB}/accountConsents`)
    expect(calls.consentToken[0]).toBe('TOKEN-B')
    const consentBody = calls.consentBody[0] as { data: { expirationDate: string, permissions: readonly string[] } }
    expect(consentBody.data.expirationDate).toBe('2026-10-26')
    expect(consentBody.data.permissions.length).toBeGreaterThan(0)

    // 3) the signed claim-set binds the consent intent id + our state
    expect(calls.signed[0]!.kid).toBe('prior-key-1')
    const claims = calls.signed[0]!.payload as Record<string, unknown>
    expect(claims.client_id).toBe('CLIENT-1')
    expect(claims.state).toBe('SIGNED-STATE')
    expect(claims.redirect_uri).toBe(config.redirectUri)
    expect(claims.aud).toEqual([config.audience])
    expect(JSON.stringify(claims)).toContain('INTENT-9') // openbanking_intent_id claim

    // 4) the authorize URL carries client_id, state and the signed request JWT
    expect(url.startsWith(`${config.baseUrl}${PRIOR_API_PREFIXES.AUTH}/oauth2/authorize?`)).toBe(true)
    const q = new URL(url).searchParams
    expect(q.get('client_id')).toBe('CLIENT-1')
    expect(q.get('state')).toBe('SIGNED-STATE')
    expect(q.get('response_type')).toBe('code')
    expect(q.get('request')).toContain('SIGNED.')
    expect(url).not.toContain('SECRET-1') // no secret in the URL
    expect(url).not.toContain('PRIVATE KEY')
  })

  it('throws on an OAuth error payload from the token step (never a half-built URL)', async () => {
    const { deps } = fakeDeps({ tokenRaw: { error: 'invalid_client', error_description: 'bad creds' } })
    await expect(buildPriorConnectUrl(config, 'S', deps, NOW_MS)).rejects.toThrow(/invalid_client/)
  })

  it('throws when the consent response carries no intent id', async () => {
    const { deps } = fakeDeps({ consentRaw: { data: {} } })
    await expect(buildPriorConnectUrl(config, 'S', deps, NOW_MS)).rejects.toThrow(/no intent id/)
  })

  it('does not sign or build a URL when the consent step fails', async () => {
    const signJwt = vi.fn(() => 'X')
    const postConsent = async () => {
      throw new Error('consent 500')
    }
    const { deps } = fakeDeps({ postConsent, signJwt })
    await expect(buildPriorConnectUrl(config, 'S', deps, NOW_MS)).rejects.toThrow(/consent 500/)
    expect(signJwt).not.toHaveBeenCalled()
  })
})
