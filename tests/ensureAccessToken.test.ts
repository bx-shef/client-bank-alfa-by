import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureAccessToken, needsRefresh, type RefreshDeps } from '../server/utils/ensureAccessToken'
import type { PortalToken, QueryFn } from '../server/utils/tokenStore'

const NOW = 1_700_000_000_000
const FAR = NOW + 3_600_000 // ~1h out → not near expiry
const NEAR = NOW + 10_000 // within the 60s skew → needs refresh

function tok(over: Partial<PortalToken> = {}): PortalToken {
  return { memberId: 'M', domain: 'p.bitrix24.by', accessToken: 'A', refreshToken: 'R', expiresAt: FAR, applicationToken: 'T', ...over }
}

/** Fake deps: pass-through lock, in-memory store, controllable refresh response. */
function make(stored: PortalToken | null, refreshResp: unknown = { access_token: 'A2', refresh_token: 'R2', expires_in: 3600, client_endpoint: 'https://new.bitrix24.by/rest/' }) {
  const store: { current: PortalToken | null } = { current: stored }
  const q = (async () => []) as unknown as QueryFn
  const postRefresh = vi.fn(async () => refreshResp)
  // ⚠ Возвращает `true` — «строка была и обновилась». Тип порта это и требует (`Promise<boolean>`),
  // но мок отдавал `undefined`, и пока результат никто не проверял, разницы не было. Как только
  // `ensureAccessToken` стал проверять (#510, паритет с `ensureBankToken`), молчаливый `undefined`
  // начал означать «портал удалён» — то есть мок утверждал бы обратное тому, что описывает тест.
  const saveToken = vi.fn(async (_q: QueryFn, t: PortalToken) => {
    store.current = t
    return true
  })
  const loadToken = vi.fn(async () => store.current)
  const withLock = vi.fn(async <T>(_k: string, fn: (qq: QueryFn) => Promise<T>) => fn(q))
  // ⚠ `withLock` — генерик-порт, а `vi.fn` генерик не переносит: Mock<> от него порту не
  // присваивается. Приведение точное (сигнатура та же), зато `.mock.calls` остаётся типизирован.
  // #574: без этих шпионов шов «наблюдение мёртвого гранта» не проверялся НИЧЕМ — удаление всего
  // блока пометки оставляло весь набор зелёным (замерено мутацией на ревью).
  const markGrantRevoked = vi.fn(async (_m: string, _at: number) => {})
  const clearGrantRevoked = vi.fn(async (_q: QueryFn, _m: string) => {})
  const deps: RefreshDeps = {
    now: () => NOW, withLock: withLock as RefreshDeps['withLock'], loadToken, saveToken, postRefresh,
    markGrantRevoked, clearGrantRevoked
  }
  return { deps, store, postRefresh, saveToken, loadToken, withLock, markGrantRevoked, clearGrantRevoked, q }
}

describe('needsRefresh', () => {
  it('true within the skew, false comfortably before expiry', () => {
    expect(needsRefresh(tok({ expiresAt: NEAR }), NOW)).toBe(true)
    expect(needsRefresh(tok({ expiresAt: FAR }), NOW)).toBe(false)
    expect(needsRefresh(tok({ expiresAt: NOW - 1 }), NOW)).toBe(true) // already expired
  })
  it('is inclusive exactly at now+skew, false one ms past (the <= boundary)', () => {
    expect(needsRefresh(tok({ expiresAt: NOW + 60_000 }), NOW)).toBe(true) // == now + default skew
    expect(needsRefresh(tok({ expiresAt: NOW + 60_001 }), NOW)).toBe(false) // one ms outside
  })
})

describe('ensureAccessToken', () => {
  beforeEach(() => {
    process.env.B24_CLIENT_ID = 'cid'
    process.env.B24_CLIENT_SECRET = 'csecret'
  })
  afterEach(() => {
    delete process.env.B24_CLIENT_ID
    delete process.env.B24_CLIENT_SECRET
  })

  it('returns the token untouched when not near expiry (no lock, no refresh)', async () => {
    const { deps, withLock, postRefresh } = make(tok())
    const out = await ensureAccessToken(tok(), deps)
    expect(out.accessToken).toBe('A')
    expect(withLock).not.toHaveBeenCalled()
    expect(postRefresh).not.toHaveBeenCalled()
  })

  it('cannot refresh without client creds — returns the stored token as-is', async () => {
    delete process.env.B24_CLIENT_ID
    const { deps, withLock } = make(tok({ expiresAt: NEAR }))
    const out = await ensureAccessToken(tok({ expiresAt: NEAR }), deps)
    expect(out.accessToken).toBe('A')
    expect(withLock).not.toHaveBeenCalled()
  })

  it('refreshes under the lock and persists the rotated tokens', async () => {
    const near = tok({ expiresAt: NEAR })
    const { deps, postRefresh, saveToken, withLock } = make(near)
    const out = await ensureAccessToken(near, deps)
    expect(withLock).toHaveBeenCalledWith('b24refresh:M', expect.any(Function))
    expect(postRefresh).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ accessToken: 'A2', refreshToken: 'R2', expiresAt: NOW + 3_600_000, domain: 'new.bitrix24.by' })
    expect(saveToken).toHaveBeenCalledTimes(1)
  })

  it('skips the refresh when a concurrent worker already refreshed (re-read inside lock)', async () => {
    // We were asked to refresh a near-expiry token, but the store now holds a fresh one.
    const winner = tok({ accessToken: 'WINNER', expiresAt: FAR })
    const { deps, postRefresh, saveToken } = make(winner)
    const out = await ensureAccessToken(tok({ expiresAt: NEAR }), deps)
    expect(out.accessToken).toBe('WINNER')
    expect(postRefresh).not.toHaveBeenCalled()
    expect(saveToken).not.toHaveBeenCalled()
  })

  it('keeps the old refresh token and domain when the response omits them', async () => {
    const near = tok({ expiresAt: NEAR })
    const { deps } = make(near, { access_token: 'A2', expires_in: 3600 })
    const out = await ensureAccessToken(near, deps)
    expect(out.accessToken).toBe('A2')
    expect(out.refreshToken).toBe('R') // unchanged
    expect(out.domain).toBe('p.bitrix24.by') // no client_endpoint → keep stored domain
  })

  it('does not resurrect a portal uninstalled while we waited for the lock', async () => {
    // The row was deleted between the pre-lock check and the in-lock re-read.
    const { deps, postRefresh, saveToken } = make(null)
    const out = await ensureAccessToken(tok({ expiresAt: NEAR }), deps)
    expect(out.accessToken).toBe('A') // returns the passed token as-is
    expect(postRefresh).not.toHaveBeenCalled()
    expect(saveToken).not.toHaveBeenCalled() // не дошли до записи вовсе — окно сужено (#510)
  })

  it('деинсталляция ВО ВРЕМЯ рефреша: персист вернул false, и это не ошибка (#510)', async () => {
    // ⚠ Случай, который перечит под локом НЕ ловит и не может поймать. Строка была на месте, когда
    // мы её прочитали; портал удалили, пока шёл POST на OAuth-сервер Bitrix (потолок 15 с). Раньше
    // вернувшийся рефреш пересоздавал строку удалённого портала через upsert — то есть мы
    // оставляли себе его OAuth-токен. Теперь запись UPDATE-only: она честно ничего не находит.
    const near = tok({ expiresAt: NEAR })
    const { deps, postRefresh } = make(near)
    const saveToken = vi.fn(async () => false) // строки уже нет
    // ⚠ `false` НЕ должен бросать: портал удалён — это штатный исход, а не сбой. Вызывающий
    // получает обновлённую пару, его REST-вызов честно упадёт на несуществующем портале, и в БД
    // не осталось ничего, что пришлось бы подчищать.
    const out = await ensureAccessToken(near, { ...deps, saveToken })
    expect(postRefresh).toHaveBeenCalledTimes(1) // в OAuth-сервер сходили — узнать об удалении было негде
    expect(saveToken).toHaveBeenCalledTimes(1) // попытка записи И ЕСТЬ способ узнать, что строки нет
    // ⚠ Возвращается СТАРЫЙ токен, а не свежий, — тот же выбор, что у `ensureBankToken` (#505).
    // Рефреш удался, значит `updated` это РАБОЧИЙ ключ к порталу, который только что нас удалил:
    // отдав его, мы позволили бы ещё одному REST-вызову туда доехать. Старый честно упадёт.
    expect(out.accessToken).toBe('A')
  })

  it('throws on a failed refresh (e.g. dead/invalid refresh token)', async () => {
    const near = tok({ expiresAt: NEAR })
    const { deps } = make(near, { error: 'invalid_grant' })
    await expect(ensureAccessToken(near, deps)).rejects.toThrow(/refresh failed: invalid_grant/)
  })

  describe('force (reactive retry after a rejected token)', () => {
    it('refreshes a CLOCK-FRESH token when force is set (server rejected it early)', async () => {
      const fresh = tok({ expiresAt: FAR }) // not near expiry — non-force would no-op
      const { deps, postRefresh, saveToken, withLock } = make(fresh)
      const out = await ensureAccessToken(fresh, deps, { force: true })
      expect(withLock).toHaveBeenCalledWith('b24refresh:M', expect.any(Function))
      expect(postRefresh).toHaveBeenCalledTimes(1)
      expect(out.accessToken).toBe('A2')
      expect(saveToken).toHaveBeenCalledTimes(1)
    })

    it('force does NOT refresh if a concurrent worker already rotated the token (stored ≠ ours)', async () => {
      // Inside the lock the store holds a DIFFERENT access token → someone already refreshed.
      const winner = tok({ accessToken: 'WINNER', expiresAt: FAR })
      const { deps, postRefresh, saveToken } = make(winner)
      const out = await ensureAccessToken(tok({ accessToken: 'A', expiresAt: FAR }), deps, { force: true })
      expect(out.accessToken).toBe('WINNER') // use theirs, no redundant refresh
      expect(postRefresh).not.toHaveBeenCalled()
      expect(saveToken).not.toHaveBeenCalled()
    })

    it('force still refuses to resurrect an uninstalled portal', async () => {
      const { deps, postRefresh, saveToken } = make(null)
      const out = await ensureAccessToken(tok({ expiresAt: FAR }), deps, { force: true })
      expect(out.accessToken).toBe('A')
      expect(postRefresh).not.toHaveBeenCalled()
      expect(saveToken).not.toHaveBeenCalled()
    })
  })
})

// Шов «наблюдение мёртвого гранта» (#574).
//
// ⚠ Заведён потому, что ревью замерило: удаление ВСЕГО блока пометки (и в одну, и в другую
// сторону) оставляло 71/71 тест зелёным. Единственное место, откуда берётся сигнал для
// НЕОБРАТИМОГО удаления данных клиента, не проверялось ничем: чистое ядро тестировало политику
// над уже готовой меткой, стор — SQL-контракт, а «зовёт ли это вообще кто-нибудь» — никто.
describe('ensureAccessToken: сигнал мёртвого гранта (#574)', () => {
  // Без кредов `ensureAccessToken` выходит раньше рефреша и НИЧЕГО не наблюдает — тесты молча
  // проверяли бы ранний выход, а не шов.
  beforeEach(() => {
    process.env.B24_CLIENT_ID = 'cid'
    process.env.B24_CLIENT_SECRET = 'csecret'
  })
  afterEach(() => {
    delete process.env.B24_CLIENT_ID
    delete process.env.B24_CLIENT_SECRET
  })

  function dead(code: string) {
    return Object.assign(new Error(`refresh rejected: ${code}`), { code })
  }

  it('мёртвый грант ПОМЕЧАЕТСЯ', async () => {
    const h = make(tok({ expiresAt: NEAR }))
    h.deps.postRefresh = vi.fn(async () => {
      throw dead('invalid_grant')
    })
    await expect(ensureAccessToken(tok({ expiresAt: NEAR }), h.deps)).rejects.toThrow()
    expect(h.markGrantRevoked).toHaveBeenCalledWith('M', NOW)
  })

  it('⚠ пометка идёт НЕ на залоченном соединении — иначе её откатывает тот же throw', async () => {
    // ЗАМЕРЕНО на живом Postgres: `withAdvisoryLock` оборачивает колбэк в BEGIN/COMMIT и делает
    // ROLLBACK на исключении. Пометка, записанная на `q` прямо перед `throw`, откатывалась этим
    // же throw — колонка не могла стать ненулевой НИКОГДА, и весь уборщик был мёртв.
    const h = make(tok({ expiresAt: NEAR }))
    h.deps.postRefresh = vi.fn(async () => {
      throw dead('invalid_grant')
    })
    await expect(ensureAccessToken(tok({ expiresAt: NEAR }), h.deps)).rejects.toThrow()
    const args = h.markGrantRevoked.mock.calls[0] ?? []
    expect(args, 'пометка обязана принимать (memberId, atMs), без соединения').toHaveLength(2)
    expect(args).not.toContain(h.q)
  })

  it('НЕ мёртвый отказ метку не ставит', async () => {
    // «Не смогли спросить» ≠ «нам отказали». Ошибка в эту сторону стирает живого клиента.
    for (const code of ['invalid_client', 'wrong_client', 'ETIMEDOUT', 'PAYMENT_REQUIRED']) {
      const h = make(tok({ expiresAt: NEAR }))
      h.deps.postRefresh = vi.fn(async () => {
        throw dead(code)
      })
      await expect(ensureAccessToken(tok({ expiresAt: NEAR }), h.deps)).rejects.toThrow()
      expect(h.markGrantRevoked, code).not.toHaveBeenCalled()
    }
  })

  it('мёртвый грант по-прежнему БРОСАЕТ — пометка не подменяет ошибку', async () => {
    const h = make(tok({ expiresAt: NEAR }))
    h.deps.postRefresh = vi.fn(async () => {
      throw dead('invalid_grant')
    })
    await expect(ensureAccessToken(tok({ expiresAt: NEAR }), h.deps)).rejects.toThrow(/invalid_grant/)
  })

  it('отказ САМОЙ пометки не превращает понятный сбой в загадочный', async () => {
    const h = make(tok({ expiresAt: NEAR }))
    h.deps.postRefresh = vi.fn(async () => {
      throw dead('invalid_grant')
    })
    h.deps.markGrantRevoked = vi.fn(async () => {
      throw new Error('база молчит')
    })
    await expect(ensureAccessToken(tok({ expiresAt: NEAR }), h.deps)).rejects.toThrow(/invalid_grant/)
  })

  it('успех СНИМАЕТ метку — и на залоченном соединении, атомарно с записью токена', async () => {
    // Зеркало предыдущего: снятие обязано откатываться вместе с несостоявшейся записью токена,
    // иначе портал считался бы доказанно живым по транзакции, которой не было.
    const h = make(tok({ expiresAt: NEAR }))
    await ensureAccessToken(tok({ expiresAt: NEAR }), h.deps)
    expect(h.clearGrantRevoked).toHaveBeenCalledWith(h.q, 'M')
  })

  it('метка снимается БЕЗУСЛОВНО, а не «только если была»', async () => {
    // Без этого один транзиентный `invalid_grant` (бывает на гонке ротации) приговаривал бы живой
    // портал навсегда: следующий успех метку бы не тронул.
    const h = make(tok({ expiresAt: NEAR }))
    await ensureAccessToken(tok({ expiresAt: NEAR }), h.deps)
    await ensureAccessToken(tok({ expiresAt: NEAR }), h.deps)
    expect(h.clearGrantRevoked.mock.calls.length).toBeGreaterThanOrEqual(1)
  })
})
