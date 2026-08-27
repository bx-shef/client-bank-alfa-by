import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bankCredsFromEnv,
  bankOAuthErrorDetail,
  bankRefreshRequest,
  ensureBankToken,
  needsBankRefresh,
  parseBankRefresh,
  type BankOAuthCreds,
  type BankRefreshDeps
} from '../server/utils/ensureBankToken'
import { PRIOR_CLIENT_ASSERTION_TYPE } from '../app/utils/priorOauth'
import type { BankToken } from '../server/utils/bankTokenStore'
import type { QueryFn } from '../server/utils/tokenStore'

const NOW = 1_700_000_000_000
const creds: BankOAuthCreds = { clientId: 'cid', clientSecret: 'sec', tokenUrl: 'https://bank/token' }

const tok = (over: Partial<BankToken> = {}): BankToken => ({
  memberId: 'm1', provider: 'alfa-by', accountKey: 'MC_7',
  accessToken: 'A', refreshToken: 'R', expiresAt: NOW + 3_600_000, ...over
})

/** Deps that run `fn` immediately (no real lock), with a mutable stored token. Records the
 *  postRefresh + loadToken args so the wiring (right url/body/headers, key parts) is checked. */
function fakeDeps(over: Partial<BankRefreshDeps> & { stored?: BankToken | null, refreshRaw?: unknown } = {}) {
  const saved: BankToken[] = []
  const posts: { url: string, body: string, headers: Record<string, string> }[] = []
  const loads: unknown[][] = []
  const deps: BankRefreshDeps = {
    now: () => NOW,
    withLock: async (_key, fn) => fn((async () => []) as never),
    loadToken: async (_q, m, p, a) => {
      loads.push([m, p, a])
      return over.stored === undefined ? tok() : over.stored
    },
    // UPDATE-only contract (#505): `true` = the row was found and updated. By default the fake
    // stands in for an existing connection.
    saveToken: async (_q, t) => {
      saved.push(t)
      return true
    },
    creds: () => creds,
    postRefresh: async (url, body, headers) => {
      posts.push({ url, body, headers })
      return over.refreshRaw ?? { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 }
    },
    ...over
  }
  return { deps, saved, posts, loads }
}

describe('needsBankRefresh', () => {
  it('true within skew of expiry, false when comfortably fresh', () => {
    expect(needsBankRefresh(tok({ expiresAt: NOW + 30_000 }), NOW)).toBe(true) // 30s < 60s skew
    expect(needsBankRefresh(tok({ expiresAt: NOW + 3_600_000 }), NOW)).toBe(false)
    expect(needsBankRefresh(tok({ expiresAt: NOW - 1 }), NOW)).toBe(true) // already expired
  })
  it('honours the <= skew boundary exactly (default 60s) and an explicit skew', () => {
    expect(needsBankRefresh(tok({ expiresAt: NOW + 60_000 }), NOW)).toBe(true) // == skew edge → refresh
    expect(needsBankRefresh(tok({ expiresAt: NOW + 60_001 }), NOW)).toBe(false) // just past → fresh
    expect(needsBankRefresh(tok({ expiresAt: NOW + 5_000 }), NOW, 1_000)).toBe(false) // explicit 1s skew
  })
})

describe('bankRefreshRequest', () => {
  it('alfa: body carries client_id + client_secret + refresh_token, NO auth header', () => {
    const { url, body, headers } = bankRefreshRequest('alfa-by', creds, 'R')
    expect(url).toBe('https://bank/token')
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=R')
    expect(body).toContain('client_id=cid')
    expect(body).toContain('client_secret=sec')
    expect(headers).toEqual({}) // alfa auths in the body
  })
  it('prior: body is grant_type + refresh_token AND a Basic auth header (client_secret_basic)', () => {
    const { body, headers } = bankRefreshRequest('prior-by', creds, 'R')
    expect(body).toBe('grant_type=refresh_token&refresh_token=R') // secret NOT in body
    // Authorization: Basic base64('cid:sec') — the client auth Prior's token endpoint requires
    expect(headers.authorization).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`)
  })
  it('manual provider throws (no online OAuth)', () => {
    expect(() => bankRefreshRequest('manual', creds, 'R')).toThrow(/manual import only/)
  })

  // #444 — prod refresh authenticates with a signed assertion, not the sandbox-only Basic header.
  it('prior + private_key_jwt: assertion in the BODY, no Basic header', () => {
    const { body, headers } = bankRefreshRequest('prior-by', creds, 'R', {
      method: 'private_key_jwt',
      assertion: 'H.P.S'
    })
    const form = new URLSearchParams(body)
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('R')
    expect(form.get('client_assertion')).toBe('H.P.S')
    expect(form.get('client_assertion_type')).toBe(PRIOR_CLIENT_ASSERTION_TYPE)
    expect(headers).toEqual({})
    expect(body).not.toContain('sec') // client secret never on the wire under this method
  })

  it('prior: falls back to Basic when no auth is supplied (sandbox behaviour unchanged)', () => {
    const { headers } = bankRefreshRequest('prior-by', creds, 'R', undefined)
    expect(headers.authorization).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`)
  })

  it('alfa ignores a Prior auth argument (creds stay in the body, no header)', () => {
    const { body, headers } = bankRefreshRequest('alfa-by', creds, 'R', { method: 'private_key_jwt', assertion: 'X' })
    expect(headers).toEqual({})
    expect(body).not.toContain('client_assertion')
  })
})

describe('parseBankRefresh', () => {
  it('alfa: maps access/refresh/expires', () => {
    expect(parseBankRefresh('alfa-by', { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 }))
      .toEqual({ accessToken: 'A2', refreshToken: 'R2', expiresIn: 3600 })
  })
  it('prior: tolerates a missing refresh_token (→ empty, caller keeps old)', () => {
    expect(parseBankRefresh('prior-by', { access_token: 'A2', expires_in: 900 }))
      .toEqual({ accessToken: 'A2', refreshToken: '', expiresIn: 900 })
  })
  it('propagates an OAuth error payload', () => {
    expect(() => parseBankRefresh('alfa-by', { error: 'invalid_grant' })).toThrow(/invalid_grant/)
  })
  it('alfa: throws when access_token is missing (delegated to the provider parser)', () => {
    expect(() => parseBankRefresh('alfa-by', { refresh_token: 'R2', expires_in: 3600 })).toThrow(/missing access_token/)
  })
})

describe('ensureBankToken', () => {
  it('returns the token unchanged when comfortably fresh (no refresh)', async () => {
    const { deps, saved } = fakeDeps()
    const post = vi.fn(deps.postRefresh)
    const out = await ensureBankToken(tok(), { ...deps, postRefresh: post })
    expect(out.accessToken).toBe('A')
    expect(post).not.toHaveBeenCalled()
    expect(saved).toHaveLength(0)
  })

  it('refreshes + persists when near expiry, rotating access AND refresh', async () => {
    const near = tok({ expiresAt: NOW + 10_000 })
    const { deps, saved } = fakeDeps({ stored: near })
    const out = await ensureBankToken(near, deps)
    expect(out.accessToken).toBe('A2')
    expect(out.refreshToken).toBe('R2')
    expect(out.expiresAt).toBe(NOW + 3_600_000)
    expect(saved).toEqual([out]) // persisted the rotated token
  })

  // ⚠ #488, находка ревью. Отметка попытки (`last_attempt_at`) — не телеметрия: на ней держится
  // ответ, который читает администратор портала («банк отказал» ⇒ переподключение лечит, против
  // «мы ни разу не пытались» ⇒ не лечит). Ставил её ТОЛЬКО крон продления, а опрос обновлял токен
  // по дороге молча — то есть отказ банка, полученный по пути опроса, выглядел как «никто не
  // пробовал». Зеркальная копия дефекта, ради которого задача и заводилась.
  describe('отметка попытки продления (#488)', () => {
    it('ставится ДО похода в банк — иначе отказ банка не отметился бы НИКОГДА', async () => {
      const near = tok({ expiresAt: NOW + 10_000 })
      const order: string[] = []
      const { deps } = fakeDeps({ stored: near })
      await ensureBankToken(near, {
        ...deps,
        markAttempt: async () => {
          order.push('mark')
        },
        postRefresh: async (...args) => {
          order.push('post')
          return deps.postRefresh(...args)
        }
      })
      expect(order).toEqual(['mark', 'post'])
    })

    it('отмечается и тогда, когда банк ОТКАЗАЛ — ради этого случая всё и написано', async () => {
      const near = tok({ expiresAt: NOW + 10_000 })
      const { deps } = fakeDeps({ stored: near })
      const markAttempt = vi.fn(async () => {})
      await expect(ensureBankToken(near, {
        ...deps,
        markAttempt,
        postRefresh: async () => {
          throw new Error('invalid_grant')
        }
      })).rejects.toThrow('invalid_grant')
      expect(markAttempt).toHaveBeenCalledTimes(1)
    })

    it('отмечается СТРОКА ИЗ БАЗЫ, а не переданный токен — ключ счёта мог смениться', async () => {
      // Между отбором и локом админ мог выбрать счёт (`~pending:` → номер, #509). Отмечать надо то,
      // что реально лежит в базе, иначе метка легла бы мимо строки.
      const near = tok({ accountKey: '~pending:n1', expiresAt: NOW + 10_000 })
      const stored = tok({ accountKey: 'BY99REAL', expiresAt: NOW + 10_000 })
      const { deps } = fakeDeps({ stored })
      const marked: BankToken[] = []
      const markAttempt = async (t: BankToken) => {
        marked.push(t)
      }
      await ensureBankToken(near, { ...deps, loadToken: async () => stored, markAttempt })
      expect(marked[0]?.accountKey).toBe('BY99REAL')
    })

    it('свежий токен банк не трогает — и отметку тоже', async () => {
      const { deps } = fakeDeps()
      const markAttempt = vi.fn(async () => {})
      await ensureBankToken(tok(), { ...deps, markAttempt })
      expect(markAttempt).not.toHaveBeenCalled()
    })

    it('нет refresh-токена — в банк не идём, значит и попытки нет', async () => {
      // Иначе строка без refresh копила бы «попытки», которых не было, и `expiredCause` объявлял
      // бы «банк отказал» там, где мы не спрашивали.
      const near = tok({ provider: 'prior-by', expiresAt: NOW + 10_000, refreshToken: '' })
      const { deps } = fakeDeps({ stored: near })
      const markAttempt = vi.fn(async () => {})
      await ensureBankToken(near, { ...deps, markAttempt })
      expect(markAttempt).not.toHaveBeenCalled()
    })

    it('отказ САМОЙ отметки не смеет отменить продление', async () => {
      // Лучшие усилия: диагностика не имеет права ломать то, что диагностирует.
      const near = tok({ expiresAt: NOW + 10_000 })
      const { deps, saved } = fakeDeps({ stored: near })
      const out = await ensureBankToken(near, {
        ...deps,
        markAttempt: async () => {
          throw new Error('db down')
        }
      })
      expect(out.accessToken).toBe('A2')
      expect(saved).toHaveLength(1)
    })
  })

  // ⚠ #649, по живому прогону 2026-08-27. Двенадцать финальных падений с текстом
  // `[POST] ".../token": 400 Bad Request` — и по нему нельзя было отличить «refresh мёртв, нужен
  // поход владельца счёта в банк» от «у нас в .env не тот client_secret». Цена ошибки
  // несимметрична: во втором случае человека посылают в интернет-банк впустую.
  describe('причина отказа токен-эндпоинта доезжает до человека (#649)', () => {
    /** Ошибка в форме, которую бросает ofetch: сообщение + разобранное тело в `data`. */
    const fetchError = (message: string, data: unknown) => Object.assign(new Error(message), { data })

    it('`invalid_grant` называется прямо — это единственный случай, где нужен поход в банк', async () => {
      const near = tok({ expiresAt: NOW + 10_000 })
      const { deps } = fakeDeps({ stored: near })
      await expect(ensureBankToken(near, {
        ...deps,
        postRefresh: async () => {
          throw fetchError('[POST] "https://bank/token": 400 Bad Request',
            { error: 'invalid_grant', error_description: 'Refresh token is invalid or expired' })
        }
      })).rejects.toThrow(/invalid_grant/)
    })

    it('⚠ `invalid_client` НЕ путается с ним — это наш .env, а не мёртвый грант', async () => {
      const near = tok({ expiresAt: NOW + 10_000 })
      const { deps } = fakeDeps({ stored: near })
      await expect(ensureBankToken(near, {
        ...deps,
        postRefresh: async () => {
          throw fetchError('[POST] "https://bank/token": 400 Bad Request', { error: 'invalid_client' })
        }
      })).rejects.toThrow(/invalid_client/)
    })

    it('исходное сообщение СОХРАНЯЕТСЯ — по нему грепает рантбук', async () => {
      const near = tok({ expiresAt: NOW + 10_000 })
      const { deps } = fakeDeps({ stored: near })
      const err = await ensureBankToken(near, {
        ...deps,
        postRefresh: async () => {
          throw fetchError('[POST] "https://bank/token": 400 Bad Request', { error: 'invalid_grant' })
        }
      }).then(() => null, (e: Error) => e)
      expect(err, 'продление не упало — тест проверяет не то').toBeInstanceOf(Error)
      expect(err!.message, 'потеряли класс отказа, по которому ищут в логе').toContain('400 Bad Request')
      expect(err!.message, 'причина не дописана').toContain('invalid_grant')
    })

    it('⚠ ТЕЛО ЗАПРОСА не попадает в сообщение ни при каких условиях', async () => {
      // В нём живой `refresh_token` и (у Альфы) `client_secret`. Инвариант заявлен в комментарии,
      // но не проверялся ничем: фикстуры `postRefresh` игнорировали свои аргументы, поэтому
      // мутация «дописать `(${body})` к сообщению» прошла бы незамеченной (находка ревью).
      const near = tok({ expiresAt: NOW + 10_000, refreshToken: 'RT-live-secret-value-0123456789' })
      const { deps } = fakeDeps({ stored: near })
      let sentBody = ''
      const err = await ensureBankToken(near, {
        ...deps,
        postRefresh: async (_u, b) => {
          sentBody = b
          throw Object.assign(new Error('[POST] "https://bank/token": 400 Bad Request'),
            { data: { error: 'invalid_grant' } })
        }
      }).then(() => null, (e: Error) => e)
      expect(sentBody, 'тело запроса не собралось — тест проверяет не то').toContain('RT-live-secret')
      expect(err!.message, 'тело запроса уехало в сообщение исключения').not.toContain('RT-live-secret')
      expect(err!.message).toContain('invalid_grant')
    })

    it('⚠⚠ ПРОВОДКА: секреты доезжают до редакции, а не остаются в аргументах по умолчанию', async () => {
      // Мутация «звать `bankOAuthErrorDetail(e)` без второго аргумента» проходила зелёной: юнит
      // на саму функцию передаёт секреты руками, а проводку не проверял никто. Между тем именно
      // она и защищает — функция без секретов вырезать значение не может в принципе.
      const refresh = 'RT-live-secret-value-0123456789'
      const near = tok({ expiresAt: NOW + 10_000, refreshToken: refresh })
      const { deps } = fakeDeps({ stored: near })
      const err = await ensureBankToken(near, {
        ...deps,
        postRefresh: async () => {
          // Банк цитирует отвергнутый параметр ЗНАЧЕНИЕМ — под шаблон формы это не попадает.
          throw Object.assign(new Error('[POST] "https://bank/token": 400 Bad Request'),
            { data: { error: 'invalid_grant', error_description: `refresh token '${refresh}' already used` } })
        }
      }).then(() => null, (e: Error) => e)
      expect(err!.message, 'живой refresh-токен уехал в лог: секреты не доехали до редакции')
        .not.toContain(refresh)
      expect(err!.message, 'вместе с секретом вычистили и диагностику').toContain('invalid_grant')
    })

    it('⚠ класс отказа СОХРАНЯЕТСЯ — по нему телеметрия метит спан', async () => {
      // Первая редакция бросала голый `new Error`, и `errorKind()` деградировал с `FetchError` до
      // безликого `Error` ровно в обогащённом случае (находка ревью).
      const near = tok({ expiresAt: NOW + 10_000 })
      const { deps } = fakeDeps({ stored: near })
      const err = await ensureBankToken(near, {
        ...deps,
        postRefresh: async () => {
          throw Object.assign(new Error('[POST] "https://bank/token": 400 Bad Request'),
            { name: 'FetchError', data: { error: 'invalid_grant' }, status: 400 })
        }
      }).then(() => null, (e: Error) => e)
      expect(err!.name, 'потерян класс отказа — job.error_kind станет безликим').toBe('FetchError')
      expect((err as Error & { status?: number }).status).toBe(400)
    })

    it('отказ БЕЗ разбираемого тела пробрасывается как есть, а не оборачивается пустотой', async () => {
      // Сеть легла, таймаут, обрыв — тела нет. Приписка «банк ответил: » была бы враньём.
      const near = tok({ expiresAt: NOW + 10_000 })
      const { deps } = fakeDeps({ stored: near })
      const err = await ensureBankToken(near, {
        ...deps,
        postRefresh: async () => {
          throw new Error('fetch failed')
        }
      }).then(() => null, (e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err!.message).toBe('fetch failed')
      expect(err!.message).not.toContain('банк ответил')
    })
  })

  describe('bankOAuthErrorDetail', () => {
    it('склеивает код и описание, когда есть оба', () => {
      expect(bankOAuthErrorDetail({ data: { error: 'invalid_grant', error_description: 'expired' } }))
        .toBe('invalid_grant: expired')
    })

    it('обходится одним из двух', () => {
      expect(bankOAuthErrorDetail({ data: { error: 'invalid_client' } })).toBe('invalid_client')
      expect(bankOAuthErrorDetail({ data: { error_description: 'no soup for you' } })).toBe('no soup for you')
    })

    it('не-JSON ответ (HTML от прокси) отдаётся текстом, а не теряется', () => {
      expect(bankOAuthErrorDetail({ data: '<html>502</html>' })).toContain('502')
    })

    it('⚠ строковая ветка ТОЖЕ капается и чистится — иначе прокси подделает строку лога', () => {
      // Находка ревью: у функции были ДВА вызова `logSafe`, по одному на ветку, и строковая
      // проверялась только на `toContain('502')`. Мутация «вернуть `data.trim()`» проходила
      // зелёной, а с ней в лог уезжал перевод строки — прямой CWE-117.
      expect(bankOAuthErrorDetail({ data: 'x'.repeat(5000) }).length).toBeLessThanOrEqual(200)
      const forged = bankOAuthErrorDetail({ data: 'proxy said:\nERROR: подделанная строка' })
      expect(forged, 'перевод строки прошёл в лог').not.toContain('\n')
    })

    it('⚠ КОНВЕРТ НЕ ПО RFC разбирается, а не теряется', () => {
      // Токен-эндпоинт Альфы стоит на шлюзе WSO2 (`{fault:…}`), у Приора Open Banking
      // (`{Code, Errors:[…]}`). Разбирай мы только `error`/`error_description` — вернулась бы
      // пустота, то есть то самое опаковое «400», ради которого всё писалось (находка ревью).
      expect(bankOAuthErrorDetail({ data: { fault: { code: 900901, message: 'Invalid Credentials' } } }))
        .toContain('Invalid Credentials')
      expect(bankOAuthErrorDetail({ data: { Code: '400 BadRequest', Errors: [{ ErrorCode: 'BY.NBRB.Field.Invalid' }] } }))
        .toContain('BY.NBRB.Field.Invalid')
    })

    it('⚠⚠ СЕКРЕТ, процитированный банком, ВЫРЕЗАЕТСЯ — по форме и по значению', () => {
      // Блокер ревью безопасности. OAuth-серверы рутинно цитируют отвергнутый параметр, а в теле
      // нашего запроса едут `client_secret` (Альфа), `client_assertion` (Приор) и живой
      // `refresh_token`. Кап длины от этого не спасает: голова строки — как раз то место, куда
      // процитированный токен и попадает.
      const refresh = 'RT-live-secret-value-0123456789'
      const secret = 'CS-live-client-secret-0123456789'

      // По ЗНАЧЕНИЮ: банк процитировал голый токен, ни один шаблон формы не совпадёт.
      const byValue = bankOAuthErrorDetail(
        { data: { error: 'invalid_grant', error_description: `refresh token '${refresh}' already used` } },
        [refresh, secret]
      )
      expect(byValue, 'живой refresh-токен уехал в лог').not.toContain(refresh)
      expect(byValue).toContain('[redacted]')
      expect(byValue, 'диагностика вычищена вместе с секретом').toContain('invalid_grant')

      // По ФОРМЕ: подписанный `client_assertion` в описании.
      const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.c2lnbmF0dXJlLXZhbHVl'
      const byShape = bankOAuthErrorDetail(
        { data: { error: 'invalid_client', error_description: `assertion rejected: ${jwt}` } }, []
      )
      expect(byShape, 'подписанный assertion уехал в лог').not.toContain(jwt)
      expect(byShape).toContain('invalid_client')
    })

    it('⚠ ПУСТОЙ секрет не превращает текст в решето', () => {
      // У Приора под `private_key_jwt` `client_secret` может отсутствовать вовсе. Замена пустой
      // строки вырезала бы вообще всё.
      expect(bankOAuthErrorDetail({ data: { error: 'invalid_grant' } }, ['', 'abc']))
        .toBe('invalid_grant')
    })

    it('пустое тело даёт пустую строку — приписки не будет', () => {
      // ⚠ `{}`/`[]` информации не несут, а приписку рисуют: `— банк ответил: {}` хуже её
      // отсутствия, потому что читатель решит, что причина названа, и перестанет искать.
      for (const data of [undefined, null, {}, [], 42, 'unserializable' in {} ? 1 : '   ']) {
        expect(bankOAuthErrorDetail({ data }), JSON.stringify(data) ?? String(data)).toBe('')
      }
      expect(bankOAuthErrorDetail(new Error('plain'))).toBe('')
    })

    it('⚠ НЕЗНАКОМЫЙ, но НЕПУСТОЙ конверт отдаётся целиком — это лучше, чем молчание', () => {
      // Ровно тот случай, ради которого фолбэк и заведён: форму мы не знаем, но у человека на
      // руках оказывается то, что банк действительно сказал.
      expect(bankOAuthErrorDetail({ data: { foo: 'bar' } })).toContain('bar')
    })

    it('⚠ ДЛИНА ограничена: строка уезжает в лог, который живёт до вытеснения по объёму', () => {
      const detail = bankOAuthErrorDetail({ data: { error_description: 'x'.repeat(5000) } })
      expect(detail.length).toBeLessThanOrEqual(200)
    })

    it('⚠ управляющие символы вычищаются — иначе банк впишет свою строку в наш лог', () => {
      // Перевод строки в теле ответа подделал бы вторую строку лога с любым содержанием.
      const detail = bankOAuthErrorDetail({ data: { error: 'x\nERROR: всё сломалось' } })
      expect(detail).not.toContain('\n')
    })
  })

  it('keeps the old refresh token when the provider omits a new one (Prior)', async () => {
    const near = tok({ provider: 'prior-by', expiresAt: NOW + 10_000, refreshToken: 'OLD' })
    const { deps } = fakeDeps({ stored: near, refreshRaw: { access_token: 'A2', expires_in: 900 } })
    const out = await ensureBankToken(near, deps)
    expect(out.accessToken).toBe('A2')
    expect(out.refreshToken).toBe('OLD') // fell back to the stored one
  })

  // #444: the resolved auth must reach the wire — testing only the pure bankRefreshRequest would
  // miss a broken `deps.priorTokenAuth` wiring, which is exactly where a prod 401 would come from.
  it('prior + private_key_jwt: the assertion reaches postRefresh, no Basic header', async () => {
    const near = tok({ provider: 'prior-by', expiresAt: NOW + 10_000 })
    const { deps } = fakeDeps({ stored: near })
    const post = vi.fn(deps.postRefresh)
    await ensureBankToken(near, {
      ...deps,
      postRefresh: post,
      priorTokenAuth: () => ({ method: 'private_key_jwt', assertion: 'H.P.S' })
    })
    const [, body, headers] = post.mock.calls[0]!
    expect(new URLSearchParams(body).get('client_assertion')).toBe('H.P.S')
    expect(headers).toEqual({})
  })

  it('alfa ignores priorTokenAuth entirely (creds stay in the body)', async () => {
    const near = tok({ provider: 'alfa-by', expiresAt: NOW + 10_000 })
    const { deps } = fakeDeps({ stored: near })
    const post = vi.fn(deps.postRefresh)
    const priorTokenAuth = vi.fn(() => ({ method: 'private_key_jwt' as const, assertion: 'X' }))
    await ensureBankToken(near, { ...deps, postRefresh: post, priorTokenAuth })
    expect(priorTokenAuth).not.toHaveBeenCalled()
    expect(post.mock.calls[0]![1]).not.toContain('client_assertion')
  })

  it('no creds → returns the stored token as-is (cannot refresh)', async () => {
    const near = tok({ expiresAt: NOW - 1 })
    const post = vi.fn(async () => ({}))
    const { deps } = fakeDeps({ stored: near })
    const out = await ensureBankToken(near, { ...deps, creds: () => null, postRefresh: post })
    expect(out).toBe(near)
    expect(post).not.toHaveBeenCalled()
  })

  it('account disconnected between check and lock (stored=null) → no save, returns passed token', async () => {
    const near = tok({ expiresAt: NOW - 1 })
    const saveToken = vi.fn(async () => true)
    const { deps } = fakeDeps({ stored: null })
    const out = await ensureBankToken(near, { ...deps, saveToken })
    expect(out).toBe(near)
    expect(saveToken).not.toHaveBeenCalled()
  })

  it('force: refreshes a clock-fresh token, but only if the stored one is STILL the rejected token', async () => {
    // stored access token already rotated by a concurrent worker → use theirs, no re-refresh
    const rotated = tok({ accessToken: 'ROTATED' })
    const post = vi.fn(async () => ({ access_token: 'A3', refresh_token: 'R3', expires_in: 3600 }))
    const { deps } = fakeDeps({ stored: rotated })
    const out = await ensureBankToken(tok({ accessToken: 'OLD' }), { ...deps, postRefresh: post }, { force: true })
    expect(out.accessToken).toBe('ROTATED')
    expect(post).not.toHaveBeenCalled()
  })

  it('force: refreshes when the stored token IS still the rejected one', async () => {
    const stale = tok({ accessToken: 'OLD' })
    const { deps, saved } = fakeDeps({ stored: stale })
    const out = await ensureBankToken(tok({ accessToken: 'OLD' }), deps, { force: true })
    expect(out.accessToken).toBe('A2')
    expect(saved).toEqual([out])
  })

  it('locks per (member, provider, account) and loads by the same key parts', async () => {
    const near = tok({ expiresAt: NOW + 10_000 })
    // ⚠ A generic port: `vi.fn` cannot carry a generic, hence the cast when handing it to deps.
    const withLock = vi.fn(async (_key: string, fn: (q: QueryFn) => Promise<unknown>) => fn(null as unknown as QueryFn))
    const { deps, loads } = fakeDeps({ stored: near })
    await ensureBankToken(near, { ...deps, withLock: withLock as typeof deps.withLock })
    expect(withLock.mock.calls[0]![0]).toBe('bankrefresh:m1:alfa-by:MC_7')
    expect(loads[0]).toEqual(['m1', 'alfa-by', 'MC_7']) // loadToken got the right key parts
  })

  it('ГРАНТ ДОЕЗЖАЕТ ДО КЛЮЧА ЛОКА — иначе счета одного согласия не сериализуются (#23)', async () => {
    // ⚠ Дыра, которую эта проверка закрывает, невидима вдвойне: чистый `bankRefreshLockKey` покрыт
    // своими тестами, но НИКТО не проверял, что грант ему вообще передают. Забудь мы аргумент — лок
    // берётся добросовестно, ошибок нет, тесты зелёные, а два счёта одного гранта уходят в банк
    // параллельно, и второй тратит refresh, который первый уже сжёг ротацией.
    const near = tok({ expiresAt: NOW + 10_000, grantId: 'G1' })
    const withLock = vi.fn(async (_key: string, fn: (q: QueryFn) => Promise<unknown>) => fn(null as unknown as QueryFn))
    const { deps } = fakeDeps({ stored: near })
    await ensureBankToken(near, { ...deps, withLock: withLock as typeof deps.withLock })
    expect(withLock.mock.calls[0]![0]).toBe('bankrefresh:m1:alfa-by:grant:G1')
  })

  it('NON-FORCE re-read: passed token near-expiry but stored is FRESH (concurrent worker won) → return stored, no refresh', async () => {
    const passedNear = tok({ expiresAt: NOW + 10_000, accessToken: 'OLD' })
    const storedFresh = tok({ expiresAt: NOW + 3_600_000, accessToken: 'FRESH' })
    const { deps, saved, posts } = fakeDeps({ stored: storedFresh })
    const out = await ensureBankToken(passedNear, deps)
    expect(out).toBe(storedFresh) // used the concurrent worker's fresh token
    expect(posts).toHaveLength(0) // no refresh POST
    expect(saved).toHaveLength(0) // nothing persisted
  })

  it('sends the RIGHT url/body/headers to postRefresh (wiring: uses stored.refreshToken + provider request)', async () => {
    const near = tok({ provider: 'prior-by', expiresAt: NOW + 10_000, refreshToken: 'STORED_R' })
    const { deps, posts } = fakeDeps({ stored: near, refreshRaw: { access_token: 'A2', expires_in: 900 } })
    await ensureBankToken(near, deps)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe('https://bank/token')
    expect(posts[0]!.body).toBe('grant_type=refresh_token&refresh_token=STORED_R') // stored refresh, not the passed one
    expect(posts[0]!.headers.authorization).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`) // Prior Basic auth reaches the POST
  })

  it('force on a clock-fresh already-rotated token persists nothing', async () => {
    const rotated = tok({ accessToken: 'ROTATED' })
    const { deps, saved } = fakeDeps({ stored: rotated })
    await ensureBankToken(tok({ accessToken: 'OLD' }), deps, { force: true })
    expect(saved).toHaveLength(0)
  })
})

describe('bankCredsFromEnv', () => {
  const KEYS = ['ALFA_OAUTH_CLIENT_ID', 'ALFA_OAUTH_CLIENT_SECRET', 'ALFA_OAUTH_TOKEN_URL']
  afterEach(() => KEYS.forEach(k => Reflect.deleteProperty(process.env, k)))

  it('returns null when any part is unset', () => {
    expect(bankCredsFromEnv('alfa-by')).toBeNull()
    process.env.ALFA_OAUTH_CLIENT_ID = 'cid'
    expect(bankCredsFromEnv('alfa-by')).toBeNull() // secret/url still missing
  })
  it('resolves alfa creds from ALFA_OAUTH_* when all set', () => {
    process.env.ALFA_OAUTH_CLIENT_ID = 'cid'
    process.env.ALFA_OAUTH_CLIENT_SECRET = 'sec'
    process.env.ALFA_OAUTH_TOKEN_URL = 'https://bank/token'
    expect(bankCredsFromEnv('alfa-by')).toEqual({ clientId: 'cid', clientSecret: 'sec', tokenUrl: 'https://bank/token' })
  })
  it('resolves prior creds from PRIOR_OAUTH_* (separate prefix)', () => {
    const PK = ['PRIOR_OAUTH_CLIENT_ID', 'PRIOR_OAUTH_CLIENT_SECRET', 'PRIOR_OAUTH_TOKEN_URL']
    process.env.PRIOR_OAUTH_CLIENT_ID = 'pid'
    process.env.PRIOR_OAUTH_CLIENT_SECRET = 'psec'
    process.env.PRIOR_OAUTH_TOKEN_URL = 'https://prior/token'
    try {
      expect(bankCredsFromEnv('prior-by')).toEqual({ clientId: 'pid', clientSecret: 'psec', tokenUrl: 'https://prior/token' })
      expect(bankCredsFromEnv('alfa-by')).toBeNull() // alfa prefix not set → isolated
    } finally {
      PK.forEach(k => Reflect.deleteProperty(process.env, k))
    }
  })
  it('manual provider → null (no online OAuth)', () => {
    expect(bankCredsFromEnv('manual')).toBeNull()
  })
})

describe('disconnect during a refresh (#505)', () => {
  // ⚠ The race is real, not theoretical: the refresh holds a per-account advisory lock, but that
  // lock does not hold back a plain `DELETE`, and the bank POST runs up to 15 s. The order
  // «re-read → go to the bank → admin hits Disconnect → come back and save» used to resurrect the
  // row through `INSERT … ON CONFLICT`, and the app kept reaching into the client's bank after
  // they had forbidden it.

  it('row vanished while we were at the bank — the token is NOT written back', async () => {
    const near = tok({ expiresAt: NOW + 10_000 })
    // `false` = the UPDATE matched no row, i.e. the account was disconnected between re-read and write.
    const saveToken = vi.fn(async () => false)
    const { deps } = fakeDeps({ stored: near })
    const out = await ensureBankToken(near, { ...deps, saveToken })
    expect(saveToken).toHaveBeenCalledTimes(1) // the attempt IS how we learn the row is gone
    expect(out).toBe(near) // hand back the stored token: the fetch then fails honestly
  })

  it('normal path untouched: the row is there, the refresh is persisted', async () => {
    const near = tok({ expiresAt: NOW + 10_000 })
    const { deps, saved } = fakeDeps({ stored: near })
    const out = await ensureBankToken(near, deps)
    expect(saved).toEqual([out])
    expect(out.accessToken).toBe('A2')
  })
})

describe('ensureBankToken: ожидание лока выбирает ВЫЗЫВАЮЩИЙ (#539)', () => {
  const near = () => tok({ expiresAt: NOW + 10_000 })
  // ⚠ Третий параметр объявлен ЯВНО: без него `calls[0][2]` — ошибка типа, то есть проверить
  // ожидание лока было бы нечем (типы тестов проверяются, #527).
  const spyLock = () => vi.fn(
    async (_key: string, fn: (q: QueryFn) => Promise<unknown>, _opts?: { lockWait?: string }) => fn(null as unknown as QueryFn)
  )

  it('передаёт заданное ожидание в лок', async () => {
    // HTTP-маршрут с админом на том конце (сверка счетов) обязан ждать коротко: держатель — POST
    // к банку с потолком 15 с, дождаться нельзя, а ожидающий всё это время держит соединение из
    // пула (пул — 10, из него же берут readiness-проба и остальные порталы).
    const withLock = spyLock()
    const { deps } = fakeDeps({ stored: near() })
    await ensureBankToken(near(), { ...deps, withLock: withLock as typeof deps.withLock }, { lockWait: '2s' })
    expect(withLock.mock.calls[0]![2]).toEqual({ lockWait: '2s' })
  })

  it('без указания оставляет умолчание — фоновому вызывающему ждать правильно', async () => {
    // Крон продления и задача опроса идут без человека: короткое ожидание там означало бы
    // пропущенный тик вместо обновлённого токена.
    const withLock = spyLock()
    const { deps } = fakeDeps({ stored: near() })
    await ensureBankToken(near(), { ...deps, withLock: withLock as typeof deps.withLock })
    expect(withLock.mock.calls[0]![2]).toEqual({ lockWait: undefined })
  })
})
