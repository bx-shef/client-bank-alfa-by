import { describe, expect, it, vi } from 'vitest'
import { isSettingsRejection, PortalRestError, portalErrorCode } from '../server/utils/portalError'
import { B24OAuth } from '@bitrix24/b24jssdk'
import type { B24OAuthParams } from '@bitrix24/b24jssdk'
import type { OAuthCallClient, SdkAjaxResult, SdkPortalDeps } from '../server/utils/b24Sdk'
import {
  buildRefreshPersist,
  makeFrameRestCall,
  makePortalSdkCall,
  makeSdkBatchCall,
  makeSdkRestCall,
  oauthParamsFromToken,
  rawTokenFromRefresh,
  SDK_BATCH_MAX,
  sdkPortalDeps,
  sdkRefreshTransport,
  tokenFromOAuthParams,
  withTimeout
} from '../server/utils/b24Sdk'
import type { PortalToken, QueryFn } from '../server/utils/tokenStore'
import { decryptSecret, encryptSecret } from '../server/utils/secretCrypto'

// Adapter over @bitrix24/b24jssdk B24OAuth (#191). The pure mapping helpers and the REST
// wrapper (`makeSdkRestCall`, structural client) are tested with a fake — no live portal.
// `makePortalSdkCall` constructs the real `B24OAuth`; to cover its construct→wire path
// without a live portal we mock the SDK module (the constructor does no I/O — only
// axios.create — so this is safe). The PortalToken→B24OAuthParams mapping is additionally
// typecheck-verified against the real SDK types by `typecheck:server`.

// Self-contained factory (hoisted above imports) — no outer references allowed. Individual
// tests override via `vi.mocked(B24OAuth).mockImplementation(...)` to capture wiring.
vi.mock('@bitrix24/b24jssdk', () => ({
  // ⚠ Логгер тоже приходится подменять: с #529 серверные модули тянут `useServerLogger`, а он
  // импортирует эти три экспорта из того же пакета — без них мок «съедает» их и модуль не грузится
  // вовсе (весь файл падает как Failed Suite, а не как красный тест, то есть симптом не по адресу).
  Logger: class { pushHandler() {} async info() {} async warning() {} async error() {} async debug() {} async notice() {} },
  StreamHandler: class { setFormatter() {} },
  // Пустой класс линтер отвергает, а мок формата обязан быть конструируемым — даём ему
  // ровно тот метод, который зовёт обработчик.
  JsonFormatter: class { format() { return '' } },
  LogLevel: { DEBUG: 100, INFO: 200, NOTICE: 250, WARNING: 300, ERROR: 400 },
  // Regular function (not arrow) so `new B24OAuth(...)` is constructable.
  B24OAuth: vi.fn(function () {
    return {
      actions: { v2: { call: { make: async () => ({ isSuccess: true, getData: () => ({ result: { items: [] } }), getErrorMessages: () => [] }) } } },
      setCallbackRefreshAuth: () => {},
      setCustomRefreshAuth: () => {},
      setRestrictionManagerParams: () => {}
    }
  }),
  // Used by disableSdkRetry (#123) — spread as the base config before overriding retry fields.
  // Carries a recognizable throttle marker (`rateLimit.drainRate`) so a test can assert the spread
  // SURVIVED (dropping `...getDefault()` would blank the throttle — setConfig replaces wholesale).
  ParamsFactory: { getDefault: () => ({ rateLimit: { drainRate: 2, burstLimit: 50 }, operatingLimit: {}, adaptiveConfig: {} }) }
}))

const token = (over: Partial<PortalToken> = {}): PortalToken => ({
  memberId: 'M1', domain: 'acme.bitrix24.com', accessToken: 'AT', refreshToken: 'RT',
  expiresAt: 1_700_000_000_000, applicationToken: 'APPTOK', ...over
})

/** A fake AjaxResult. */
const ajax = (over: Partial<SdkAjaxResult> = {}): SdkAjaxResult => ({
  isSuccess: true, getData: () => ({ result: { items: [] } }), getErrorMessages: () => [], ...over
})

/** A fake OAuth client recording calls made through it. `batchImpl` lets a test drive the
 *  batch endpoint; by default the batch echoes one empty-result AjaxResult per command. */
function fakeClient(
  res: SdkAjaxResult = ajax(),
  batchImpl?: (o: { calls: Array<[string, Record<string, unknown>]>, options?: Record<string, unknown> }) => Promise<{ isSuccess: boolean, getErrorMessages: () => string[], getData: () => unknown }>
) {
  const calls: Array<{ method: string, params?: Record<string, unknown> }> = []
  const batches: Array<Array<[string, Record<string, unknown>]>> = []
  const defaultBatch = async (o: { calls: Array<[string, Record<string, unknown>]> }) => {
    batches.push(o.calls)
    return { isSuccess: true, getErrorMessages: () => [], getData: () => o.calls.map(() => ajax()) }
  }
  const client: OAuthCallClient = {
    actions: { v2: {
      call: { make: async (o) => {
        calls.push(o)
        return res
      } },
      batch: { make: batchImpl ?? defaultBatch }
    } },
    setCallbackRefreshAuth: () => {},
    setCustomRefreshAuth: () => {},
    setRestrictionManagerParams: () => {},
    auth: { refreshAuth: async () => false }
  }
  return { client, calls, batches }
}

describe('oauthParamsFromToken', () => {
  it('maps our PortalToken to B24OAuthParams (seconds, endpoints, defaults)', () => {
    const p = oauthParamsFromToken(token(), { nowMs: 1_699_999_000_000, scope: 'crm,im' })
    expect(p.memberId).toBe('M1')
    expect(p.accessToken).toBe('AT')
    expect(p.refreshToken).toBe('RT')
    expect(p.applicationToken).toBe('APPTOK')
    expect(p.expires).toBe(1_700_000_000) // ms → s
    expect(p.expiresIn).toBe(1000) // (expiresAt - nowMs)/1000
    expect(p.scope).toBe('crm,im')
    expect(p.domain).toBe('acme.bitrix24.com')
    expect(p.clientEndpoint).toBe('https://acme.bitrix24.com/rest/')
    expect(p.serverEndpoint).toBe('https://oauth.bitrix.info/rest/')
    expect(p.status).toBe('L')
    expect(p.userId).toBe(0)
  })

  it('clamps a past-expiry token to expiresIn 0 and defaults scope to empty', () => {
    const p = oauthParamsFromToken(token({ expiresAt: 1_000 }), { nowMs: 2_000 })
    expect(p.expiresIn).toBe(0)
    expect(p.scope).toBe('')
  })

  it('trims the domain (no stray whitespace leaks into domain or clientEndpoint URL)', () => {
    const p = oauthParamsFromToken(token({ domain: '  acme.bitrix24.com  ' }), { nowMs: 0 })
    expect(p.domain).toBe('acme.bitrix24.com')
    expect(p.clientEndpoint).toBe('https://acme.bitrix24.com/rest/')
  })

  it('SSRF (#149): throws on a non-portal host so a poisoned stored domain cannot form the REST URL', () => {
    // The stored-token path (makePortalSdkClient) reaches the SDK's clientEndpoint through here;
    // without the gate a poisoned domain would make the worker POST to an attacker host.
    expect(() => oauthParamsFromToken(token({ domain: '169.254.169.254' }), { nowMs: 0 })).toThrow(/not allow-listed/)
    expect(() => oauthParamsFromToken(token({ domain: 'acme.bitrix24.by@evil.com' }), { nowMs: 0 })).toThrow(/not allow-listed/)
  })
})

describe('tokenFromOAuthParams', () => {
  it('is the inverse of the mapping for the persisted fields (s → ms)', () => {
    const p = oauthParamsFromToken(token(), { nowMs: 1_699_999_000_000 })
    expect(tokenFromOAuthParams(p)).toEqual(token()) // expiresAt round-trips at second granularity
  })
})

describe('buildRefreshPersist', () => {
  it('persists the SDK-refreshed token to our store', async () => {
    const saved: PortalToken[] = []
    const cb = buildRefreshPersist(async (t) => {
      saved.push(t)
    })
    const refreshed = oauthParamsFromToken(token({ accessToken: 'NEW_AT', refreshToken: 'NEW_RT' }), { nowMs: 0 })
    // The SDK invokes the callback with authData + b24OAuthParams; we only read the latter.
    await cb({ authData: {} as never, b24OAuthParams: refreshed })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ accessToken: 'NEW_AT', refreshToken: 'NEW_RT', memberId: 'M1', applicationToken: 'APPTOK' })
  })
})

describe('makeSdkRestCall', () => {
  it('unwraps the REST envelope on success', async () => {
    const { client, calls } = fakeClient(ajax({ getData: () => ({ result: { items: [{ id: 7 }] } }) }))
    const call = makeSdkRestCall(client)
    const out = await call('crm.item.list', { entityTypeId: 31 })
    expect(out).toEqual({ result: { items: [{ id: 7 }] } })
    expect(calls[0]).toEqual({ method: 'crm.item.list', params: { entityTypeId: 31 } })
  })

  it('returns {} when getData is null/undefined (tolerant)', async () => {
    const { client } = fakeClient(ajax({ getData: () => null }))
    expect(await makeSdkRestCall(client)('x', {})).toEqual({})
  })

  it('passes getData through verbatim — does NOT validate the envelope shape', async () => {
    // Documents the contract: the adapter is a thin transport, not a validator. Whatever
    // the SDK hands back (even without a `result` key) reaches the lookup unchanged.
    const { client } = fakeClient(ajax({ getData: () => ({ foo: 1 }) }))
    expect(await makeSdkRestCall(client)('x', {})).toEqual({ foo: 1 })
  })

  it('re-attaches top-level `total`/`next` from the SDK accessors (getData drops them) — #191 list pagination', async () => {
    // getData() returns ONLY {result,time}; the raw callRest envelope carries top-level
    // `total`/`next` that paymentLookup/negativeStages paginate on. Without re-attaching,
    // a >1-page list is silently truncated to the first page under the SDK transport.
    const { client } = fakeClient(ajax({
      getData: () => ({ result: { items: [{ id: 1 }] } }),
      getTotal: () => 120,
      isMore: () => true
    }))
    const out = await makeSdkRestCall(client)('crm.item.list', { entityTypeId: 2 })
    expect(out).toEqual({ result: { items: [{ id: 1 }] }, total: 120, next: true })
  })

  it('does not fabricate `next` when the SDK reports no more pages', async () => {
    const { client } = fakeClient(ajax({
      getData: () => ({ result: { items: [] } }),
      getTotal: () => 0,
      isMore: () => false
    }))
    const out = await makeSdkRestCall(client)('crm.item.list', {})
    expect(out).toEqual({ result: { items: [] }, total: 0 }) // total present (0), next absent
  })

  it('leaves the envelope untouched when the SDK exposes no total/isMore (graceful degrade)', async () => {
    // A future SDK bump could drop the @deprecated getTotal(); the optional guards must then
    // pass the envelope through unchanged rather than break.
    const { client } = fakeClient(ajax({ getData: () => ({ result: true }) }))
    expect(await makeSdkRestCall(client)('crm.item.payment.pay', {})).toEqual({ result: true })
  })

  it('does not overwrite a `total` the envelope already carries', async () => {
    const { client } = fakeClient(ajax({ getData: () => ({ result: { items: [] }, total: 5 }), getTotal: () => 999 }))
    expect((await makeSdkRestCall(client)('x', {})).total).toBe(5)
  })

  it('throws the SDK error messages on failure (so the job fails → clean retry)', async () => {
    const { client } = fakeClient(ajax({ isSuccess: false, getErrorMessages: () => ['QUERY_LIMIT_EXCEEDED', 'slow down'] }))
    await expect(makeSdkRestCall(client)('crm.item.list', {})).rejects.toThrow('QUERY_LIMIT_EXCEEDED; slow down')
  })

  it('keeps the PORTAL CODE on the thrown error (#572)', async () => {
    // ⚠ Mutation testing showed this was uncovered: reverting `PortalRestError` back to a bare
    // `Error` killed ZERO tests, because the neighbouring case above asserts only on the message
    // substring. The whole settings-error classification hangs on the code surviving this hop.
    const { client } = fakeClient(ajax({
      isSuccess: false,
      getErrorMessages: () => ['Invalid filter: field \'UF_CRM_NOPE\' is not allowed in filter'],
      getErrors: () => [Object.assign(new Error('x'), { code: 'INVALID_ARG_VALUE' })]
    }))
    const caught = await makeSdkRestCall(client)('crm.item.list', {}).catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(PortalRestError)
    expect(portalErrorCode(caught)).toBe('INVALID_ARG_VALUE')
    expect(isSettingsRejection(caught, 'field')).toBe(true)
    // The message is unchanged — callers that log or match on it must see exactly what they did.
    expect((caught as Error).message).toContain('is not allowed in filter')
  })

  it('a result without `getErrors` still throws, just without a code', async () => {
    // Losing the code must never become losing the error itself.
    const { client } = fakeClient(ajax({ isSuccess: false, getErrorMessages: () => ['boom'] }))
    const caught = await makeSdkRestCall(client)('crm.item.list', {}).catch((e: unknown) => e)
    expect((caught as Error).message).toBe('boom')
    expect(portalErrorCode(caught)).toBe('')
  })

  it('throws a generic message when the SDK gives no error text', async () => {
    const { client } = fakeClient(ajax({ isSuccess: false, getErrorMessages: () => [] }))
    await expect(makeSdkRestCall(client)('crm.deal.get', {})).rejects.toThrow('B24 REST crm.deal.get failed')
  })
})

describe('makeSdkBatchCall (#191 batched fan-out)', () => {
  it('maps commands to array calls and returns per-command envelopes IN ORDER (with total/next re-attach)', async () => {
    const seen: Array<Array<[string, Record<string, unknown>]>> = []
    const { client } = fakeClient(ajax(), async (o) => {
      seen.push(o.calls)
      return {
        isSuccess: true, getErrorMessages: () => [],
        getData: () => o.calls.map((c, i) => ajax({
          getData: () => ({ result: { items: [{ id: i, m: c[0] }] } }),
          getTotal: () => (i + 1) * 10,
          isMore: () => i === 0
        }))
      }
    })
    const out = await makeSdkBatchCall(client)([
      { method: 'crm.status.list', params: { filter: { ENTITY_ID: 'A' } } },
      { method: 'crm.status.list', params: { filter: { ENTITY_ID: 'B' } } }
    ])
    expect(seen[0]).toEqual([
      ['crm.status.list', { filter: { ENTITY_ID: 'A' } }],
      ['crm.status.list', { filter: { ENTITY_ID: 'B' } }]
    ])
    // `total` re-attached per row; `next` is NOT re-attached in the batch path even when a row's
    // isMore() is true — batch rows always carry next:0 which the SDK's isMore() misreports.
    expect(out).toEqual([
      { result: { items: [{ id: 0, m: 'crm.status.list' }] }, total: 10 },
      { result: { items: [{ id: 1, m: 'crm.status.list' }] }, total: 20 }
    ])
  })

  it('does NOT stamp a spurious `next` on batched envelopes (SDK sets next:0 → isMore() true for every row)', async () => {
    // Regression guard (5-reviewer finding): a batched AjaxResult always has a numeric `next`
    // (0 when no more pages), and AjaxResult.isMore() returns isNumber(0)===true, so isMore() is
    // stuck true for every batched row. The batch envelope must not carry `next` from that.
    const { client } = fakeClient(ajax(), async o => ({
      isSuccess: true, getErrorMessages: () => [],
      getData: () => o.calls.map(() => ajax({ getData: () => ({ result: [] }), isMore: () => true }))
    }))
    const out = await makeSdkBatchCall(client)([{ method: 'crm.status.list' }])
    expect(out[0]).not.toHaveProperty('next')
  })

  it('defaults missing params to {} in the array call', async () => {
    const { client, batches } = fakeClient()
    await makeSdkBatchCall(client)([{ method: 'x' }])
    expect(batches[0]).toEqual([['x', {}]])
  })

  it('chunks a >SDK_BATCH_MAX fan-out into multiple batch requests, concatenated in order', async () => {
    const seen: number[] = []
    const { client } = fakeClient(ajax(), async (o) => {
      seen.push(o.calls.length)
      return { isSuccess: true, getErrorMessages: () => [], getData: () => o.calls.map(c => ajax({ getData: () => ({ id: c[1].n }) })) }
    })
    const calls = Array.from({ length: SDK_BATCH_MAX + 3 }, (_, n) => ({ method: 'm', params: { n } }))
    const out = await makeSdkBatchCall(client)(calls)
    expect(seen).toEqual([SDK_BATCH_MAX, 3]) // two chunks
    expect(out).toHaveLength(SDK_BATCH_MAX + 3)
    expect(out.map(r => (r as { id: number }).id)).toEqual(calls.map((_, n) => n)) // order preserved
  })

  it('throws when the batch envelope fails (job fails → clean retry)', async () => {
    const { client } = fakeClient(ajax(), async () => ({ isSuccess: false, getErrorMessages: () => ['batch boom'], getData: () => undefined }))
    await expect(makeSdkBatchCall(client)([{ method: 'x' }])).rejects.toThrow('batch boom')
  })

  it('throws when ANY single command fails, even if the batch envelope is ok (no silent drop)', async () => {
    const { client } = fakeClient(ajax(), async o => ({
      isSuccess: true, getErrorMessages: () => [],
      getData: () => o.calls.map((_, i) => i === 1
        ? ajax({ isSuccess: false, getErrorMessages: () => ['cmd 1 failed'] })
        : ajax())
    }))
    await expect(makeSdkBatchCall(client)([{ method: 'a' }, { method: 'b' }])).rejects.toThrow('cmd 1 failed')
  })
})

describe('sdkPortalDeps (live token-store wiring)', () => {
  it('loadToken reads via getToken; the persist is UPDATE-only and cannot resurrect (#510)', async () => {
    process.env.B24_TOKEN_ENC_KEY = 'bb'.repeat(32)
    const sql: Array<{ q: string, p?: unknown[] }> = []
    // Fake pg: tombstone SELECT → empty (not blocked); getToken SELECT → one row; upsert/delete → [].
    const query: QueryFn = async (q, p) => {
      sql.push({ q, p })
      if (/FROM portal_tokens WHERE member_id/i.test(q) && /SELECT member_id, domain/i.test(q)) {
        return [{ member_id: 'M1', domain: 'acme.bitrix24.com', access_token: 'AT', refresh_token_enc: encryptSecret('RT'), expires_at: 1_700_000_000_000, application_token: 'APPTOK' }]
      }
      // ⚠ UPDATE обязан отдать строку: `RETURNING member_id` — это и есть способ узнать, что
      // регистрация ещё жива. Пустой ответ означает «портала больше нет», и персист тогда бросает.
      if (/UPDATE portal_tokens/i.test(q)) return [{ member_id: 'M1' }]
      return []
    }
    const deps = sdkPortalDeps({ query, clientId: 'cid', clientSecret: 'sec', now: () => 123 })
    expect(deps.creds).toEqual({ clientId: 'cid', clientSecret: 'sec' })

    const loaded = await deps.loadToken('M1')
    expect(loaded).toMatchObject({ memberId: 'M1', domain: 'acme.bitrix24.com', accessToken: 'AT' })
    // The refresh token is stored ENCRYPTED at rest — getToken must decrypt it back so the SDK
    // gets a usable refresh token (a silent decrypt bug would otherwise pass unnoticed).
    expect(loaded!.refreshToken).toBe('RT')

    await deps.saveToken(token({ accessToken: 'NEW', refreshToken: 'NEW_RT' }))
    // ⚠ Раньше здесь проверялось, что персист — upsert с гардом тумбстоуна (`eventTs=0`). Это
    // сузило, но не закрывало окно: тумбстоун-SELECT и INSERT — два оператора, и деинсталляция,
    // легшая между ними, оставляла строку удалённого портала (#510). Теперь персист — голый
    // UPDATE, и ожидание сильнее прежнего: создать строку он не может в принципе.
    const write = sql.find(s => /UPDATE portal_tokens/i.test(s.q))
    expect(write, 'персист не сделал UPDATE').toBeTruthy()
    expect(sql.some(s => /INSERT INTO portal_tokens/i.test(s.q)), 'персист всё ещё вставляет строку').toBe(false)
    // ⚠ Тумбстоун этот путь больше не читает — и это не потеря: запрещать создание нечему, когда
    // создание невозможно. Проверяется явно, чтобы возврат к upsert'у не прошёл незамеченным.
    expect(sql.some(s => /portal_tombstone/i.test(s.q)), 'UPDATE-only не должен читать тумбстоун').toBe(false)
    // Refresh-токен обязан уехать ЗАШИФРОВАННЫМ и расшифроваться обратно — это доказывает всю
    // цепочку «SDK обновил → положили шифротекст», а не просто «запрос выполнился».
    const refreshEncBind = write!.p?.[3] as string
    expect(refreshEncBind).not.toBe('NEW_RT') // не открытым текстом
    expect(decryptSecret(refreshEncBind)).toBe('NEW_RT') // шифр, round-trip
  })

  it('портал удалён во время рефреша ⇒ персист БРОСАЕТ, а не глотает (#510)', async () => {
    // ⚠ Находка ревью, и она не про хранение, а про ДЕЙСТВИЕ. Колбэк вызывается ВНУТРИ
    // `AuthOAuthManager.refreshAuth()` самого SDK, и если он разрешается, `refreshAuth()` отдаёт
    // свежие authData, а `_makeRequestWithAuthRetry` тут же ПЕРЕИГРЫВАЕТ исходный упавший
    // REST-вызов с ними. То есть проглоченный `false` означал бы: портал нас удалил, токен мы
    // честно не сохранили — и следом записали дело / отправили сообщение в чат / провели оплату
    // в CRM этого клиента. Не держать их данные — только половина; не действовать в их портале
    // после того, как нас выгнали, — вторая.
    //
    // Бросок реджектит `refreshAuth()`, переигровка не случается, джоба падает и чисто ретраится
    // по BullMQ — тот же контракт «throw → clean retry», на котором стоит весь модуль.
    process.env.B24_TOKEN_ENC_KEY = 'bb'.repeat(32)
    const query: QueryFn = async q => (/UPDATE portal_tokens/i.test(q) ? [] : []) // строки нет
    const deps = sdkPortalDeps({ query, clientId: 'cid', clientSecret: 'sec', now: () => 123 })
    await expect(deps.saveToken(token({ accessToken: 'NEW' }))).rejects.toThrow(/uninstalled mid-refresh/)
  })
})

describe('makePortalSdkCall', () => {
  const deps = (over: Partial<SdkPortalDeps> = {}): SdkPortalDeps => ({
    loadToken: async () => token(),
    saveToken: async () => {},
    creds: { clientId: 'local.x', clientSecret: 'SECRET' },
    now: () => 1_699_999_000_000,
    ...over
  })

  it('returns null when the portal has no token (no client constructed)', async () => {
    // No stored token (uninstalled / demo) → null, returns before touching the SDK.
    vi.mocked(B24OAuth).mockClear()
    expect(await makePortalSdkCall('M1', deps({ loadToken: async () => null }))).toBeNull()
    expect(vi.mocked(B24OAuth)).not.toHaveBeenCalled()
  })

  it('constructs one B24OAuth with mapped params + creds, wires refresh-persist, disables retry, returns a working RestCall', async () => {
    const saved: PortalToken[] = []
    const calls: Array<{ method: string }> = []
    const restrictionParams: Array<Record<string, unknown>> = []
    let registeredCb: ((a: { authData: never, b24OAuthParams: ReturnType<typeof oauthParamsFromToken> }) => Promise<void>) | null = null
    vi.mocked(B24OAuth).mockReset()
    // Regular function (not arrow) so `new B24OAuth(...)` returns this object.
    vi.mocked(B24OAuth).mockImplementation((function () {
      return {
        actions: { v2: { call: { make: async (o: { method: string }) => {
          calls.push(o)
          return ajax()
        } } } },
        setCallbackRefreshAuth: (cb: typeof registeredCb) => {
          registeredCb = cb
        },
        setCustomRefreshAuth: () => {},
        setRestrictionManagerParams: (p: Record<string, unknown>) => {
          restrictionParams.push(p)
        }
      }
    }) as unknown as typeof B24OAuth)

    const call = await makePortalSdkCall('M1', deps({ saveToken: async (t) => {
      saved.push(t)
    } }))

    // one instance per portal, constructed with the mapped params + our creds
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(1)
    const [params, secret] = vi.mocked(B24OAuth).mock.calls[0]
    expect(params).toMatchObject({ memberId: 'M1', accessToken: 'AT', clientEndpoint: 'https://acme.bitrix24.com/rest/' })
    expect(secret).toEqual({ clientId: 'local.x', clientSecret: 'SECRET' })

    // #123: in-client retry disabled (fail fast → BullMQ job retry, which is idempotent), AND the
    // throttle base config is preserved (spread of getDefault() survives — dropping it would blank
    // rateLimit and unleash a QUERY_LIMIT_EXCEEDED storm; setConfig replaces the config wholesale).
    expect(restrictionParams).toHaveLength(1)
    expect(restrictionParams[0]).toMatchObject({ maxRetries: 1, retryOnNetworkError: false, rateLimit: { drainRate: 2 } })

    // returns a working RestCall routed through the client
    const out = await call!('crm.item.list', {})
    expect(out).toEqual({ result: { items: [] } })
    expect(calls[0]).toMatchObject({ method: 'crm.item.list' })

    // refresh-persist wired: the registered callback saves the refreshed token to our store
    expect(registeredCb).toBeTypeOf('function')
    await registeredCb!({ authData: {} as never, b24OAuthParams: oauthParamsFromToken(token({ accessToken: 'REFRESHED' }), { nowMs: 0 }) })
    expect(saved[0]).toMatchObject({ accessToken: 'REFRESHED', memberId: 'M1' })
  })
})

describe('makeFrameRestCall (frame-token jssdk transport + SSRF gate #149)', () => {
  const creds = { clientId: 'cid', clientSecret: 'sec' }

  it('THROWS (SSRF gate) before any client is built, for internal + userinfo-trick hosts', () => {
    vi.mocked(B24OAuth).mockClear()
    // The throw happens synchronously in makeFrameRestCall (assertPortalHost), before `new B24OAuth`.
    expect(() => makeFrameRestCall('169.254.169.254', 'AT', creds, { now: () => 0 })).toThrow(/not allow-listed/)
    expect(() => makeFrameRestCall('x.bitrix24.by@evil.com', 'AT', creds, { now: () => 0 })).toThrow(/not allow-listed/)
    expect(() => makeFrameRestCall('', 'AT', creds, { now: () => 0 })).toThrow(/not allow-listed/)
    expect(vi.mocked(B24OAuth)).not.toHaveBeenCalled()
  })

  it('builds one B24OAuth for an allow-listed portal (CLEAN host, empty refresh token), hard-rejects refresh, disables retry, returns a working RestCall', async () => {
    const calls: Array<{ method: string }> = []
    const restrictionParams: Array<Record<string, unknown>> = []
    let customRefresh: (() => Promise<unknown>) | null = null
    vi.mocked(B24OAuth).mockReset()
    // Regular function (not arrow) so `new B24OAuth(...)` returns this object.
    vi.mocked(B24OAuth).mockImplementation((function () {
      return {
        actions: { v2: { call: { make: async (o: { method: string }) => {
          calls.push(o)
          return { isSuccess: true, getData: () => ({ result: { ID: 42 } }), getErrorMessages: () => [] }
        } } } },
        setCallbackRefreshAuth: () => {},
        setCustomRefreshAuth: (cb: () => Promise<unknown>) => {
          customRefresh = cb
        },
        setRestrictionManagerParams: (p: Record<string, unknown>) => {
          restrictionParams.push(p)
        }
      }
    }) as unknown as typeof B24OAuth)

    // Mixed-case host proves the CLEAN parsed host reaches the SDK clientEndpoint.
    const call = makeFrameRestCall('Acme.Bitrix24.COM', 'FRAME_AT', creds, { now: () => 1_000, scope: 'crm' })
    const out = await call('profile', {})
    expect(out).toEqual({ result: { ID: 42 } })
    expect(calls[0]).toMatchObject({ method: 'profile' })

    // constructed once, with the clean lowercased host + our creds, and NO refresh token
    // (a frame token is fresh & unrefreshable) so the SDK never pre-emptively refreshes.
    expect(vi.mocked(B24OAuth)).toHaveBeenCalledTimes(1)
    const [params, secret] = vi.mocked(B24OAuth).mock.calls[0]
    expect(params).toMatchObject({
      domain: 'acme.bitrix24.com',
      clientEndpoint: 'https://acme.bitrix24.com/rest/',
      accessToken: 'FRAME_AT',
      refreshToken: '',
      scope: 'crm'
    })
    expect(secret).toEqual(creds)

    // hard-reject wired: a rejected frame token throws invalid_token, not an empty-refresh POST.
    expect(customRefresh).toBeTypeOf('function')
    await expect(customRefresh!()).rejects.toThrow(/invalid_token/)

    // #123: in-client retry disabled on the frame client too (fail fast), throttle base preserved.
    expect(restrictionParams).toHaveLength(1)
    expect(restrictionParams[0]).toMatchObject({ maxRetries: 1, retryOnNetworkError: false, rateLimit: { drainRate: 2 } })
  })
})

describe('withTimeout', () => {
  it('resolves the value on the fast path', async () => {
    expect(await withTimeout(Promise.resolve(7), 1_000)).toBe(7)
  })
  it('rejects when the promise outruns the timeout', async () => {
    await expect(withTimeout(new Promise<never>(() => {}), 10)).rejects.toThrow(/no response within 10ms/)
  })
})

describe('rawTokenFromRefresh', () => {
  const cap = (o: Partial<PortalToken> = {}) => oauthParamsFromToken(token(o), { nowMs: 0 })
  const authData = { access_token: 'AD_AT', refresh_token: 'AD_RT', expires: 0, expires_in: 99, domain: 'd', member_id: 'MAD' }
  it('prefers captured params over authData', () => {
    const r = rawTokenFromRefresh(cap({ accessToken: 'CAP_AT', refreshToken: 'CAP_RT', memberId: 'MC' }), authData)
    expect(r).toMatchObject({ access_token: 'CAP_AT', refresh_token: 'CAP_RT', member_id: 'MC' })
  })
  it('falls back to authData when captured is undefined', () => {
    expect(rawTokenFromRefresh(undefined, authData)).toMatchObject({ access_token: 'AD_AT', refresh_token: 'AD_RT', expires_in: 99, member_id: 'MAD' })
  })
  it('leaves access/refresh UNDEFINED when neither source has them → parseRefreshResponse fails closed', () => {
    const r = rawTokenFromRefresh(undefined, false)
    expect(r.access_token).toBeUndefined()
    expect(r.refresh_token).toBeUndefined()
  })
})

describe('sdkRefreshTransport (keep-alive refresh via SDK, #175)', () => {
  it('drives auth.refreshAuth with the stored refresh token + creds and returns the raw token JSON', async () => {
    let cb: ((a: { authData: never, b24OAuthParams: B24OAuthParams }) => Promise<void>) | null = null
    let ctor: { params: B24OAuthParams, secret: { clientId: string, clientSecret: string } } | null = null
    vi.mocked(B24OAuth).mockReset()
    vi.mocked(B24OAuth).mockImplementation((function (params: B24OAuthParams, secret: { clientId: string, clientSecret: string }) {
      ctor = { params, secret }
      return {
        setCallbackRefreshAuth: (c: typeof cb) => { cb = c },
        auth: { refreshAuth: async () => {
          // The SDK fires the persist callback with the refreshed params, then returns AuthData.
          // The SDK sets expiresIn from the fresh OAuth response (~3600), NOT from an absolute
          // expiry — model that so rawTokenFromRefresh yields a sane expires_in for the caller.
          const refreshed: B24OAuthParams = { ...oauthParamsFromToken(token({ accessToken: 'NEW_AT', refreshToken: 'NEW_RT', memberId: 'M1' }), { nowMs: 0 }), expiresIn: 3600 }
          await cb!({ authData: {} as never, b24OAuthParams: refreshed })
          return { access_token: 'NEW_AT', refresh_token: 'NEW_RT', expires: 0, expires_in: 3600, domain: 'x', member_id: 'M1' }
        } }
      }
    }) as unknown as typeof B24OAuth)

    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: 'cid', client_secret: 'sec', refresh_token: 'RT' }).toString()
    const raw = await sdkRefreshTransport()(body) as Record<string, unknown>

    // Built with the stored refresh token + app creds; refresh POSTs to the OAuth server
    // (domain is a placeholder — serverEndpoint is oauth.bitrix.info).
    expect(ctor!.params).toMatchObject({ refreshToken: 'RT', serverEndpoint: 'https://oauth.bitrix.info/rest/' })
    expect(ctor!.secret).toEqual({ clientId: 'cid', clientSecret: 'sec' })
    // Captured refreshed params → the raw JSON parseRefreshResponse consumes.
    expect(raw).toMatchObject({ access_token: 'NEW_AT', refresh_token: 'NEW_RT', expires_in: 3600, member_id: 'M1' })
  })

  it('propagates a refresh failure (→ ensureAccessToken lets the job fail; lock released)', async () => {
    vi.mocked(B24OAuth).mockReset()
    vi.mocked(B24OAuth).mockImplementation((function () {
      return {
        setCallbackRefreshAuth: () => {},
        auth: { refreshAuth: async () => { throw new Error('invalid_grant') } }
      }
    }) as unknown as typeof B24OAuth)
    const body = new URLSearchParams({ client_id: 'c', client_secret: 's', refresh_token: 'DEAD' }).toString()
    await expect(sdkRefreshTransport()(body)).rejects.toThrow('invalid_grant')
  })
})

describe('наблюдение истёкшей подписки (#614)', () => {
  // ⚠ Шов, а не правило: чистое ядро (`isSubscriptionEnded`) проверено отдельно, а здесь — что его
  // ВООБЩЕ кто-то зовёт. Ровно этой проверки не было у #574, и удаление всего блока пометки
  // оставляло весь набор зелёным (замерено мутацией на ревью).

  it('ОШИБКА об истёкшей подписке ставит метку', async () => {
    const { client } = fakeClient()
    client.actions.v2.call.make = async () => {
      throw new Error('Subscription has been ended')
    }
    const seen: string[] = []
    const call = makeSdkRestCall(client, { memberId: 'M1', onSubscriptionEnded: async (m) => {
      seen.push(m)
    } })
    await expect(call('crm.item.list', {})).rejects.toThrow()
    expect(seen, 'метка не поставлена — отключение через 4 дня не наступит никогда').toEqual(['M1'])
  })

  it('ПРОВАЛИВШИЙСЯ РЕЗУЛЬТАТ с тем же текстом — тоже', async () => {
    // ⚠ Портал отдаёт отказ двумя путями, и какой именно был в живом логе — не наблюдалось.
    // Закрыть надо оба, иначе метка не встанет ровно в половине случаев.
    const failed = ajax({ isSuccess: false, getErrorMessages: () => ['Subscription has been ended'] })
    const { client } = fakeClient(failed)
    const seen: string[] = []
    const call = makeSdkRestCall(client, { memberId: 'M1', onSubscriptionEnded: async (m) => {
      seen.push(m)
    } })
    await expect(call('crm.item.list', {})).rejects.toThrow()
    expect(seen).toEqual(['M1'])
  })

  it('ЧУЖОЙ отказ метку НЕ ставит', async () => {
    // Ошибка в эту сторону отключает банк живому клиенту через четверо суток.
    const { client } = fakeClient()
    client.actions.v2.call.make = async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    }
    const seen: string[] = []
    const call = makeSdkRestCall(client, { memberId: 'M1', onSubscriptionEnded: async (m) => {
      seen.push(m)
    } })
    await expect(call('crm.item.list', {})).rejects.toThrow()
    expect(seen).toEqual([])
  })

  it('успешный вызов метку не ставит и результат не портит', async () => {
    const { client } = fakeClient()
    const seen: string[] = []
    const call = makeSdkRestCall(client, { memberId: 'M1', onSubscriptionEnded: async (m) => {
      seen.push(m)
    } })
    await call('crm.item.list', {})
    expect(seen).toEqual([])
  })

  it('отказ САМОЙ пометки не подменяет ошибку портала', async () => {
    // Вызывающий ждёт отказа портала; подменив его отказом нашей записи, мы превратили бы понятный
    // сбой в загадочный. Тот же контракт, что у `onGrantDead`.
    const { client } = fakeClient()
    client.actions.v2.call.make = async () => {
      throw new Error('Subscription has been ended')
    }
    const call = makeSdkRestCall(client, {
      memberId: 'M1',
      onSubscriptionEnded: async () => {
        throw new Error('база молчит')
      }
    })
    await expect(call('crm.item.list', {})).rejects.toThrow(/Subscription has been ended/)
  })
})
