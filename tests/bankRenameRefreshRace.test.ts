import { describe, expect, it, vi } from 'vitest'
import { ensureBankToken, type BankRefreshDeps } from '../server/utils/ensureBankToken'
import { bankRefreshLockKey } from '../server/utils/bankRefreshLock'
import type { BankToken } from '../server/utils/bankTokenStore'
import type { QueryFn } from '../server/utils/tokenStore'

// Гонка «выбор счёта против обновления токена» (#509).
//
// Обе операции пишут в ОДНУ строку `bank_tokens`, но по-разному: обновление меняет секреты, а
// переименование — сам `account_key`, то есть ключ, по которому обновление свою строку и находит.
// Проигрыш не выглядит проигрышем: `updateBankTokenSecrets` честно возвращает `false` и ничего не
// создаёт (#505), в списке подключение на месте, счёт выбран, ошибок нет. Но банк refresh УЖЕ
// ротировал, а у нас лежит потраченный — подключение умрёт на следующем обновлении, и лечится это
// только повторным входом владельца счёта в интернет-банк.
//
// ⚠ Здесь проверяется НЕ «функция возвращает правильное значение», а то, что лок реально сериализует
// две стороны. Поэтому первый тест намеренно воспроизводит ПРЕЖНЕЕ поведение (переименование мимо
// лока) и показывает потерю: без него «зелено» достигалось бы и тогда, когда лок ничего не держит.

type Row = BankToken

/** Мини-модель хранилища: ключ строки — тот самый, который переименование и меняет. */
function makeStore(initial: Row) {
  const rows = new Map<string, Row>()
  const k = (m: string, p: string, a: string): string => `${m}|${p}|${a}`
  rows.set(k(initial.memberId, initial.provider, initial.accountKey), { ...initial })
  return {
    rows,
    load: async (_q: QueryFn, m: string, p: string, a: string): Promise<Row | null> =>
      rows.get(k(m, p, a)) ?? null,
    /** UPDATE-only, как в проде: строки нет — `false`, и НИЧЕГО не создаётся (#505). */
    save: async (_q: QueryFn, t: Row): Promise<boolean> => {
      const key = k(t.memberId, t.provider, t.accountKey)
      if (!rows.has(key)) return false
      rows.set(key, { ...t })
      return true
    },
    /** То, что делает `renameBankTokenAccount`: переносит строку на новый ключ. */
    rename: (m: string, p: string, from: string, to: string): boolean => {
      const row = rows.get(k(m, p, from))
      if (!row) return false
      rows.delete(k(m, p, from))
      rows.set(k(m, p, to), { ...row, accountKey: to })
      return true
    },
    only: (): Row => {
      const all = [...rows.values()]
      expect(all).toHaveLength(1)
      return all[0]!
    }
  }
}

/** Настоящий мьютекс по строковому ключу — иначе тест не проверял бы сериализацию. */
function makeLocks() {
  const held = new Map<string, Promise<unknown>>()
  const q: QueryFn = async () => []
  return async function withLock<T>(key: string, fn: (q: QueryFn) => Promise<T>): Promise<T> {
    const prev = held.get(key) ?? Promise.resolve()
    let release!: () => void
    held.set(key, new Promise<void>((r) => {
      release = r
    }))
    await prev
    try {
      return await fn(q)
    } finally {
      release()
    }
  }
}

const TOKEN: BankToken = {
  memberId: 'm1',
  provider: 'alfa-by',
  accountKey: '~pending:n1',
  accessToken: 'access-old',
  refreshToken: 'refresh-old',
  // Просрочен ⇒ обновление точно сработает.
  expiresAt: 1_000,
  consentExpiresAt: 0
}

function makeDeps(store: ReturnType<typeof makeStore>, over: Partial<BankRefreshDeps> = {}): BankRefreshDeps {
  return {
    now: () => 100_000,
    withLock: makeLocks(),
    loadToken: store.load,
    saveToken: store.save,
    creds: () => ({ clientId: 'id', clientSecret: 'secret', tokenUrl: 'https://bank.example/token' }),
    postRefresh: async () => ({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }),
    ...over
  } as BankRefreshDeps
}

describe('выбор счёта во время обновления токена (#509)', () => {
  it('БЕЗ общего лока ротированный refresh теряется — воспроизведение дефекта', async () => {
    const store = makeStore(TOKEN)
    const deps = makeDeps(store, {
      // Переименование происходит, пока мы «в банке», и НЕ берёт лока — прежнее поведение.
      postRefresh: async () => {
        store.rename('m1', 'alfa-by', '~pending:n1', 'BY01')
        return { access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }
      }
    })

    await ensureBankToken({ ...TOKEN }, deps)

    // Банк ротировал refresh, а у нас остался старый: подключение выглядит живым и мертво.
    expect(store.only().accountKey).toBe('BY01')
    expect(store.only().refreshToken).toBe('refresh-old')
  })

  it('под общим локом переименование ждёт — новая пара сохраняется, потом меняется ключ', async () => {
    const store = makeStore(TOKEN)
    const withLock = makeLocks()
    const order: string[] = []
    let renameDone!: Promise<void>

    const deps = makeDeps(store, {
      withLock,
      postRefresh: async () => {
        // Админ жмёт «выбрать счёт» ровно в это мгновение — но идёт через ТОТ ЖЕ лок.
        renameDone = withLock(bankRefreshLockKey('m1', 'alfa-by', '~pending:n1'), async () => {
          order.push('rename')
          store.rename('m1', 'alfa-by', '~pending:n1', 'BY01')
        })
        order.push('bank')
        return { access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }
      }
    })

    await ensureBankToken({ ...TOKEN }, deps)
    await renameDone

    // Порядок обязан быть именно таким: сначала мы дописали токен, и только потом сменился ключ.
    expect(order).toEqual(['bank', 'rename'])
    expect(store.only().accountKey).toBe('BY01')
    expect(store.only().refreshToken).toBe('refresh-new')
  })

  it('если переименование успело первым — в банк не идём вовсе, тратить нечего', async () => {
    // Обратный порядок: часовой скан прочитал ключ, а к моменту лока строки под ним уже нет.
    // Перечит внутри лока обязан это увидеть ДО обращения к банку — иначе refresh был бы потрачен
    // и записан в никуда, то есть ровно тот же дефект с другого конца.
    const store = makeStore(TOKEN)
    store.rename('m1', 'alfa-by', '~pending:n1', 'BY01')
    const postRefresh = vi.fn(async () => ({ access_token: 'x', refresh_token: 'y', expires_in: 3600 }))

    const got = await ensureBankToken({ ...TOKEN }, makeDeps(store, { postRefresh }))

    expect(postRefresh).not.toHaveBeenCalled()
    expect(got.refreshToken).toBe('refresh-old')
    expect(store.only().refreshToken).toBe('refresh-old')
  })
})
