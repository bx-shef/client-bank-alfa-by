import { describe, expect, it, vi } from 'vitest'
import {
  buildPriorConnectUrl,
  priorConnectConfigFromEnv,
  priorConsentExpiry,
  PRIOR_CONSENT_SCOPE,
  type PriorConnectConfig,
  type PriorConnectDeps
} from '../server/utils/priorConnectStart'
import { PRIOR_API_PREFIXES, PRIOR_CLIENT_ASSERTION_TYPE } from '../app/utils/priorOauth'
import { Buffer } from 'node:buffer'

const config: PriorConnectConfig = {
  baseUrl: 'https://api.priorbank.by:9344',
  // ⚠ A DIFFERENT origin than `baseUrl` on purpose. Were it the value `baseUrl` derives, every
  // assertion below would pass just as well against the old code that rebuilt the token URL from
  // `baseUrl` — the fixture itself would hide the bug.
  tokenUrl: 'https://sso.priorbank.by:9544/oauth2/token',
  authorizeBaseUrl: 'https://api.priorbank.by:9344',
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
    tokenHeaders: [] as Record<string, string>[],
    consentUrl: [] as string[],
    consentToken: [] as string[],
    consentBody: [] as unknown[],
    signed: [] as { payload: Record<string, unknown>, kid: string }[]
  }
  let idCounter = 0
  const deps: PriorConnectDeps = {
    postToken: async (url, body, headers) => {
      calls.tokenUrl.push(url)
      calls.tokenBody.push(body)
      calls.tokenHeaders.push(headers)
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
    // Assign '' rather than `delete env[dynamicKey]` (lint: no-dynamic-delete). ⚠ NOT `undefined`:
    // `process.env.X = undefined` stores the STRING 'undefined', which is truthy — a test written
    // that way silently exercises «set to garbage» instead of «unset», and would pass even if the
    // unset branch were deleted.
    for (const k of [...KEYS, 'PRIOR_OAUTH_AUTHORIZE_BASE', 'PRIOR_OAUTH_AUTH_METHOD', 'PRIOR_OAUTH_TOKEN_URL']) process.env[k] = ''
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
        tokenUrl: 'https://api.priorbank.by:9344/open-banking-authorize/v1.0/oauth2/token',
        authorizeBaseUrl: 'https://api.priorbank.by:9344',
        clientId: 'C',
        clientSecret: 'S',
        redirectUri: 'https://app/cb',
        audience: 'https://api.priorbank.by:9544/oauth2/token',
        authMethod: 'client_secret_basic',
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

  // #444 follow-up: under private_key_jwt the assertion authenticates us and the bank may not
  // issue a client secret at all — demanding one would disable a correct production config.
  it('private_key_jwt: config builds WITHOUT a client secret', () => {
    setAll()
    process.env.PRIOR_OAUTH_CLIENT_SECRET = ''
    process.env.PRIOR_OAUTH_AUTH_METHOD = 'private_key_jwt'
    try {
      const cfg = priorConnectConfigFromEnv()
      expect(cfg).not.toBeNull()
      expect(cfg?.clientSecret).toBe('')
      expect(cfg?.authMethod).toBe('private_key_jwt')
    } finally {
      clearAll()
    }
  })

  it('client_secret_basic (default): a missing secret still fails closed', () => {
    setAll()
    process.env.PRIOR_OAUTH_CLIENT_SECRET = ''
    try {
      expect(priorConnectConfigFromEnv()).toBeNull()
    } finally {
      clearAll()
    }
  })

  // #455 — the crypto-gateway split. The backend talks to the local gateway over plain HTTP; the
  // admin's browser must still be sent to the bank's PUBLIC host, or the authorize page never
  // loads and the server sees no error at all.
  describe('crypto gateway (#455)', () => {
    it('backend base may be the internal gateway while authorize stays on the bank', () => {
      setAll()
      process.env.PRIOR_OAUTH_API_BASE = 'http://avtunproxy:1080'
      process.env.PRIOR_OAUTH_AUTHORIZE_BASE = 'https://apibel.priorbank.by:9345'
      try {
        const cfg = priorConnectConfigFromEnv()
        expect(cfg?.baseUrl).toBe('http://avtunproxy:1080')
        expect(cfg?.authorizeBaseUrl).toBe('https://apibel.priorbank.by:9345')
      } finally {
        clearAll()
      }
    })

    // The token endpoint and the resource API are DIFFERENT APIs at the bank, and only the
    // authorization server is documented as living behind BY-crypto TLS. So the token URL must be
    // configurable on its own — and it must be the SAME variable the refresh path reads, or the
    // two call sites of one endpoint would disagree about the host.
    it('token endpoint follows PRIOR_OAUTH_TOKEN_URL, resource API stays on the bank', () => {
      setAll()
      process.env.PRIOR_OAUTH_TOKEN_URL = 'http://crypto-gw:1080/open-banking-authorize/v1.0/oauth2/token'
      try {
        const cfg = priorConnectConfigFromEnv()
        expect(cfg?.tokenUrl).toBe('http://crypto-gw:1080/open-banking-authorize/v1.0/oauth2/token')
        expect(cfg?.baseUrl).toBe('https://api.priorbank.by:9344')
      } finally {
        clearAll()
      }
    })

    it('a SET but unusable token URL fails closed instead of falling back to the base', () => {
      // Silently substituting the base would make a typo look like a working deployment — and the
      // request would go to the host the operator explicitly tried to move it away from.
      setAll()
      process.env.PRIOR_OAUTH_TOKEN_URL = 'http://api.priorbank.by:9344/oauth2/token'
      try {
        expect(priorConnectConfigFromEnv()).toBeNull()
      } finally {
        clearAll()
      }
    })

    it('fail-closed when the base is internal and no public authorize origin is set', () => {
      // Otherwise we would hand the browser `http://avtunproxy:1080/...` — unreachable for it, and
      // silent on the server. Refusing to start is the only honest outcome.
      setAll()
      process.env.PRIOR_OAUTH_API_BASE = 'http://avtunproxy:1080'
      try {
        expect(priorConnectConfigFromEnv()).toBeNull()
      } finally {
        clearAll()
      }
    })

    it('rejects an internal authorize origin even when explicitly configured', () => {
      setAll()
      process.env.PRIOR_OAUTH_AUTHORIZE_BASE = 'http://avtunproxy:1080'
      try {
        expect(priorConnectConfigFromEnv()).toBeNull()
      } finally {
        clearAll()
      }
    })

    it('rejects plain http to a PUBLIC host (token would cross the network in clear text)', () => {
      setAll()
      process.env.PRIOR_OAUTH_API_BASE = 'http://apibel.priorbank.by:9345'
      try {
        expect(priorConnectConfigFromEnv()).toBeNull()
      } finally {
        clearAll()
      }
    })
  })
})

describe('buildPriorConnectUrl', () => {
  it('runs token Б → consent → sign → authorize and returns the URL', async () => {
    const { deps, calls } = fakeDeps()
    const url = await buildPriorConnectUrl(config, () => 'SIGNED-STATE', deps, NOW_MS)

    // 1) token Б: client_credentials + scope=accounts, creds in the Basic HEADER (NOT the body)
    expect(calls.tokenUrl[0]).toBe(config.tokenUrl)
    expect(calls.tokenBody[0]).toContain('grant_type=client_credentials')
    expect(calls.tokenBody[0]).toContain(`scope=${PRIOR_CONSENT_SCOPE}`)
    expect(calls.tokenBody[0]).not.toContain('SECRET-1') // secret never in the body
    expect(calls.tokenHeaders[0]?.authorization)
      .toBe('Basic ' + Buffer.from('CLIENT-1:SECRET-1').toString('base64'))

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
    expect(url.startsWith(`${config.authorizeBaseUrl}${PRIOR_API_PREFIXES.AUTH}/oauth2/authorize?`)).toBe(true)
    const q = new URL(url).searchParams
    expect(q.get('client_id')).toBe('CLIENT-1')
    expect(q.get('state')).toBe('SIGNED-STATE')
    expect(q.get('response_type')).toBe('code')
    expect(q.get('request')).toContain('SIGNED.')
    expect(url).not.toContain('SECRET-1') // no secret in the URL
    expect(url).not.toContain('PRIVATE KEY')
  })

  it('срок согласия ИЗ ОТВЕТА банка доезжает до подписчика state (#503)', async () => {
    // ⚠ Все прочие тесты передают `signState` как `() => '…'`, то есть аргумент игнорируют — а
    // значит удаление `extractConsentExpiry` из преамбулы проходило зелёным. Здесь подписчик —
    // шпион: проверяется РОВНО то, с чем его позвали.
    // ⚠ Банк отвечает НЕ ТЕМ, что мы просили: просим `2026-10-26` (90 дней), он выдаёт короче.
    // Так тест доказывает главное — берём ОТВЕТ, а не свою просьбу; иначе разницы было бы не видно.
    const { deps, calls } = fakeDeps({
      consentRaw: { data: { consentId: 'INTENT-9', expirationDate: '2026-09-01' } }
    })
    const seen: Array<{ consentExpiresAt: number | null }> = []
    await buildPriorConnectUrl(config, (extra) => {
      seen.push(extra)
      return 'SIGNED-STATE'
    }, deps, NOW_MS)
    expect(seen).toHaveLength(1) // подписываем ровно один раз
    expect(seen[0]!.consentExpiresAt).toBe(Date.parse('2026-09-01T23:59:59.999+03:00'))
    // И это точно не то, что мы просили:
    expect((calls.consentBody[0] as { data: { expirationDate: string } }).data.expirationDate).toBe('2026-10-26')
  })

  it('банк срока не вернул — подписываем `null`, дату НЕ выдумываем', async () => {
    const { deps } = fakeDeps() // фейк по умолчанию отвечает без expirationDate
    const seen: Array<{ consentExpiresAt: number | null }> = []
    await buildPriorConnectUrl(config, (extra) => {
      seen.push(extra)
      return 'S'
    }, deps, NOW_MS)
    expect(seen[0]!.consentExpiresAt).toBeNull()
  })

  // #444: token Б is the FOURTH client_secret_basic site and the easiest to miss (it lives in the
  // connect preamble, not the «token» modules). DCR registers ONE method per app, so leaving this
  // call on Basic breaks prod at the FIRST step — before any other migrated site is reached.
  it('private_key_jwt: token Б sends a signed client_assertion in the BODY, no Basic header', async () => {
    const { deps, calls } = fakeDeps()
    await buildPriorConnectUrl({ ...config, authMethod: 'private_key_jwt' }, () => 'SIGNED-STATE', deps, NOW_MS)

    const body = new URLSearchParams(calls.tokenBody[0]!)
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('client_assertion_type')).toBe(PRIOR_CLIENT_ASSERTION_TYPE)
    expect(body.get('client_assertion')).toContain('SIGNED.')
    // No client authentication in the header, and no secret anywhere on the wire.
    expect(calls.tokenHeaders[0]).toEqual({})
    expect(calls.tokenBody[0]).not.toContain('SECRET-1')

    // The assertion is a DISTINCT JWT from the authorize `request` one: iss=sub=client id,
    // aud as an ARRAY, and no authorize-only claims.
    const assertionClaims = calls.signed[0]!.payload as Record<string, unknown>
    expect(assertionClaims.iss).toBe('CLIENT-1')
    expect(assertionClaims.sub).toBe('CLIENT-1')
    expect(assertionClaims.aud).toEqual([config.audience])
    expect(assertionClaims.jti).toBeTruthy()
    expect(assertionClaims.response_type).toBeUndefined()
    expect(assertionClaims.claims).toBeUndefined()
    // Signed with the registered kid — the bank verifies against the app's jwks.
    expect(calls.signed[0]!.kid).toBe('prior-key-1')
  })

  it('private_key_jwt: each token call mints a FRESH assertion (single-use jti)', async () => {
    const { deps, calls } = fakeDeps()
    await buildPriorConnectUrl({ ...config, authMethod: 'private_key_jwt' }, () => 'S1', deps, NOW_MS)
    await buildPriorConnectUrl({ ...config, authMethod: 'private_key_jwt' }, () => 'S2', deps, NOW_MS)
    const first = calls.signed[0]!.payload as Record<string, unknown>
    const third = calls.signed[2]!.payload as Record<string, unknown> // [0]=assertion, [1]=request, [2]=assertion
    expect(first.jti).not.toBe(third.jti)
  })

  // #455: the two origins are used for DIFFERENT things — server calls vs the browser navigation.
  it('calls the gateway for token/consent but sends the browser to the bank', async () => {
    const { deps, calls } = fakeDeps()
    const url = await buildPriorConnectUrl(
      {
        ...config,
        baseUrl: 'http://avtunproxy:1080',
        tokenUrl: 'http://avtunproxy:1080/open-banking-authorize/v1.0/oauth2/token',
        authorizeBaseUrl: 'https://apibel.priorbank.by:9345'
      },
      () => 'SIGNED-STATE', deps, NOW_MS
    )
    expect(calls.tokenUrl[0]).toContain('http://avtunproxy:1080')
    expect(calls.consentUrl[0]).toContain('http://avtunproxy:1080')
    expect(url.startsWith('https://apibel.priorbank.by:9345')).toBe(true)
    expect(url).not.toContain('avtunproxy') // the internal host never reaches the browser
  })

  // The regression this guards: the token URL used to be DERIVED from `baseUrl`, so it could not
  // be moved on its own — while the refresh path has always read `PRIOR_OAUTH_TOKEN_URL`. Point
  // the two at different hosts (the documented production shape: authorization server behind the
  // BY-crypto gateway, resource API on the bank's public host) and the old code sent the token
  // request to the WRONG one, with refresh still going to the right one.
  it('token and consent may go to different hosts — the token follows tokenUrl, the consent baseUrl', async () => {
    const { deps, calls } = fakeDeps()
    await buildPriorConnectUrl(
      {
        ...config,
        baseUrl: 'https://api.priorbank.by:9344',
        tokenUrl: 'http://crypto-gw:1080/open-banking-authorize/v1.0/oauth2/token',
        authorizeBaseUrl: 'https://apibel.priorbank.by:9345'
      },
      () => 'SIGNED-STATE', deps, NOW_MS
    )
    expect(calls.tokenUrl[0]).toBe('http://crypto-gw:1080/open-banking-authorize/v1.0/oauth2/token')
    expect(calls.consentUrl[0]).toBe(`https://api.priorbank.by:9344${PRIOR_API_PREFIXES.OB}/accountConsents`)
  })

  it('throws on an OAuth error payload from the token step (never a half-built URL)', async () => {
    const { deps } = fakeDeps({ tokenRaw: { error: 'invalid_client', error_description: 'bad creds' } })
    await expect(buildPriorConnectUrl(config, () => 'S', deps, NOW_MS)).rejects.toThrow(/invalid_client/)
  })

  it('throws when the consent response carries no intent id', async () => {
    const { deps } = fakeDeps({ consentRaw: { data: {} } })
    await expect(buildPriorConnectUrl(config, () => 'S', deps, NOW_MS)).rejects.toThrow(/no intent id/)
  })

  it('does not sign or build a URL when the consent step fails', async () => {
    const signJwt = vi.fn(() => 'X')
    const postConsent = async () => {
      throw new Error('consent 500')
    }
    const { deps } = fakeDeps({ postConsent, signJwt })
    await expect(buildPriorConnectUrl(config, () => 'S', deps, NOW_MS)).rejects.toThrow(/consent 500/)
    expect(signJwt).not.toHaveBeenCalled()
  })
})
