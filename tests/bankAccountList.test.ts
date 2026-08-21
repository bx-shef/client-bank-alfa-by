import { describe, it, expect } from 'vitest'
import { PG_LOCK_TIMEOUT } from '../server/utils/bankRefreshLock'
import {
  accountsUrl,
  connectedKeys,
  extractAlfaAccounts,
  hasConnection,
  listBankSideAccounts,
  LISTABLE_PROVIDERS,
  pickToken,
  type BankSideListDeps
} from '../server/utils/bankAccountList'
import type { BankToken } from '../server/utils/bankTokenStore'
import type { BankProviderId } from '../app/types/statement'

function token(over: Partial<BankToken> = {}): BankToken {
  return {
    memberId: 'M1',
    provider: 'alfa-by',
    accountKey: 'BY11ALFA00000001',
    accessToken: 'AT',
    refreshToken: 'RT',
    expiresAt: 1000,
    ...over
  }
}

function deps(over: Partial<BankSideListDeps> = {}): BankSideListDeps {
  return {
    tokens: async () => [token()],
    ensureFresh: async t => t,
    apiBase: () => 'https://bank.test',
    getJson: async () => ({ accounts: [] }),
    ...over
  }
}

describe('extractAlfaAccounts', () => {
  it('maps number + currIso', () => {
    expect(extractAlfaAccounts({
      accounts: [
        { number: 'BY11ALFA0001', currIso: 'BYN', amount: 5 },
        { number: 'BY11ALFA0002', currIso: 'USD' }
      ]
    })).toEqual([
      { number: 'BY11ALFA0001', currency: 'BYN' },
      { number: 'BY11ALFA0002', currency: 'USD' }
    ])
  })

  it('drops rows with no number — an account we cannot name is not a matrix row', () => {
    expect(extractAlfaAccounts({ accounts: [{ currIso: 'BYN' }, { number: '   ' }] })).toEqual([])
  })

  it('tolerates a missing/!array envelope', () => {
    expect(extractAlfaAccounts(null)).toEqual([])
    expect(extractAlfaAccounts({})).toEqual([])
    expect(extractAlfaAccounts({ accounts: 'nope' })).toEqual([])
  })

  it('keeps the number VERBATIM apart from edge trim — the matrix must see the difference', () => {
    // A bank that pads its IBAN with spaces INSIDE is exactly the case `looks-same` exists for.
    expect(extractAlfaAccounts({ accounts: [{ number: ' BY11 ALFA 0001 ' }] }))
      .toEqual([{ number: 'BY11 ALFA 0001' }])
  })

  it('omits currency when the bank did not send one', () => {
    expect(extractAlfaAccounts({ accounts: [{ number: 'BY1' }] })).toEqual([{ number: 'BY1' }])
  })
})

describe('accountsUrl', () => {
  it('uses the Alfa partner prefix', () => {
    expect(accountsUrl('alfa-by', 'https://a.test')).toBe('https://a.test/partner/1.2.0/accounts/')
  })

  it('honours ALFA_OAUTH_API_PREFIX, normalising slashes', () => {
    const prev = process.env.ALFA_OAUTH_API_PREFIX
    process.env.ALFA_OAUTH_API_PREFIX = 'partner/2.0/'
    try {
      expect(accountsUrl('alfa-by', 'https://a.test')).toBe('https://a.test/partner/2.0/accounts/')
    } finally {
      if (prev === undefined) delete process.env.ALFA_OAUTH_API_PREFIX
      else process.env.ALFA_OAUTH_API_PREFIX = prev
    }
  })

  it('uses the fixed OB prefix for Prior', () => {
    expect(accountsUrl('prior-by', 'https://p.test')).toMatch(/\/accounts$/)
    expect(accountsUrl('prior-by', 'https://p.test')).toContain('https://p.test/')
  })
})

describe('pickToken', () => {
  it('returns null when the provider has no connection', () => {
    expect(pickToken([token({ provider: 'alfa-by' })], 'prior-by')).toBeNull()
  })

  it('takes the freshest token of the provider', () => {
    const old = token({ accountKey: 'A', expiresAt: 10 })
    const fresh = token({ accountKey: 'B', expiresAt: 99 })
    expect(pickToken([old, fresh], 'alfa-by')?.accountKey).toBe('B')
  })

  it('is willing to use a PENDING connection — that is the common case for this screen', () => {
    const pending = token({ accountKey: '~pending:abc', expiresAt: 50 })
    expect(pickToken([pending], 'alfa-by')?.accountKey).toBe('~pending:abc')
  })
})

describe('hasConnection / connectedKeys', () => {
  it('hasConnection counts pending rows too', () => {
    expect(hasConnection([token({ accountKey: '~pending:x' })], 'alfa-by')).toBe(true)
    expect(hasConnection([token()], 'prior-by')).toBe(false)
  })

  it('connectedKeys EXCLUDES pending — a pending row has no account number to light up', () => {
    expect(connectedKeys([token({ accountKey: 'BY1' }), token({ accountKey: '~pending:x' })]))
      .toEqual(['BY1'])
  })
})

describe('listBankSideAccounts', () => {
  it('skips providers with no connection entirely (no row, no error)', async () => {
    const out = await listBankSideAccounts('M1', deps({ tokens: async () => [] }))
    expect(out).toEqual([])
  })

  it('returns the Alfa account list', async () => {
    const out = await listBankSideAccounts('M1', deps({
      getJson: async () => ({ accounts: [{ number: 'BY11ALFA0001', currIso: 'BYN' }] })
    }))
    expect(out).toEqual([{ provider: 'alfa-by', accounts: [{ number: 'BY11ALFA0001', currency: 'BYN', provider: 'alfa-by' }] }])
  })

  it('maps Prior rows through `identification`, dropping ones without an IBAN', async () => {
    const out = await listBankSideAccounts('M1', deps({
      tokens: async () => [token({ provider: 'prior-by' })],
      getJson: async () => ({
        data: {
          account: [
            { accountId: 'op-1', currency: 'BYN', accountDetails: { identification: 'BY11PJCB0001' } },
            { accountId: 'op-2', currency: 'USD' }
          ]
        }
      })
    }))
    expect(out).toEqual([{ provider: 'prior-by', accounts: [{ number: 'BY11PJCB0001', currency: 'BYN', provider: 'prior-by' }] }])
  })

  it('fails SOFT per provider: a bank error does not blank the other bank', async () => {
    const calls: BankProviderId[] = []
    const out = await listBankSideAccounts('M1', deps({
      tokens: async () => [token({ provider: 'alfa-by' }), token({ provider: 'prior-by' })],
      getJson: async (url) => {
        const provider: BankProviderId = url.includes('partner') ? 'alfa-by' : 'prior-by'
        calls.push(provider)
        if (provider === 'alfa-by') throw new Error('банк не ответил (503)')
        return { data: { account: [{ accountId: 'x', accountDetails: { identification: 'BY11PJCB0001' } }] } }
      }
    }))
    // Оба банка спрошены; порядок в `calls` не утверждаем — запросы идут параллельно.
    expect([...calls].sort()).toEqual(['alfa-by', 'prior-by'])
    expect(out[0]).toEqual({ provider: 'alfa-by', accounts: [], error: 'банк не ответил (503)' })
    expect(out[1]?.accounts).toEqual([{ number: 'BY11PJCB0001', currency: undefined, provider: 'prior-by' }])
  })

  it('reports an unconfigured provider without touching the network', async () => {
    let called = false
    const out = await listBankSideAccounts('M1', deps({
      apiBase: () => null,
      getJson: async () => {
        called = true
        return {}
      }
    }))
    expect(called).toBe(false)
    expect(out[0]?.error).toBe('банк не настроен на этом сервере')
  })

  it('sanitises the bank error text — it reaches an admin screen', async () => {
    const out = await listBankSideAccounts('M1', deps({
      getJson: async () => { throw new Error('bad\r\ninjected: header') }
    }))
    expect(out[0]?.error).not.toContain('\n')
    expect(out[0]?.error).not.toContain('\r')
  })

  it('refreshes the token before asking, and uses the refreshed access token', async () => {
    const seen: string[] = []
    await listBankSideAccounts('M1', deps({
      ensureFresh: async t => ({ ...t, accessToken: 'FRESH' }),
      getJson: async (_url, at) => {
        seen.push(at)
        return { accounts: [] }
      }
    }))
    expect(seen).toEqual(['FRESH'])
  })

  it('asks each listable provider at most once even with many stored accounts', async () => {
    let n = 0
    await listBankSideAccounts('M1', deps({
      tokens: async () => [token({ accountKey: 'A' }), token({ accountKey: 'B' }), token({ accountKey: 'C' })],
      getJson: async () => {
        n += 1
        return { accounts: [] }
      }
    }))
    expect(n).toBe(1)
  })

  it('never lists `manual` — it has no API', () => {
    expect(LISTABLE_PROVIDERS).not.toContain('manual')
  })
})

describe('listBankSideAccounts — банк на каждой строке и параллельный опрос (ревью #494)', () => {
  it('каждая строка помечена своим банком', async () => {
    const out = await listBankSideAccounts('M1', deps({
      getJson: async () => ({ accounts: [{ number: 'BY11ALFA0001' }] })
    }))
    expect(out[0]?.accounts[0]?.provider).toBe('alfa-by')
  })

  it('метка банка ставится и для Приора — без неё его счёт предложили бы к подключению Альфы', async () => {
    const out = await listBankSideAccounts('M1', deps({
      tokens: async () => [token({ provider: 'prior-by' })],
      getJson: async () => ({ data: { account: [{ accountId: 'x', accountDetails: { identification: 'BY11PJCB0001' } }] } })
    }))
    expect(out[0]?.accounts[0]?.provider).toBe('prior-by')
  })

  it('банки опрашиваются ПАРАЛЛЕЛЬНО — последовательно два таймаута перевалили бы за потолок nginx', async () => {
    let inFlight = 0
    let peak = 0
    await listBankSideAccounts('M1', deps({
      tokens: async () => [token({ provider: 'alfa-by' }), token({ provider: 'prior-by' })],
      getJson: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise(r => setTimeout(r, 5))
        inFlight -= 1
        return { accounts: [] }
      }
    }))
    expect(peak).toBe(2)
  })

  it('порядок провайдеров стабилен, несмотря на параллельность — экран не должен прыгать', async () => {
    const out = await listBankSideAccounts('M1', deps({
      tokens: async () => [token({ provider: 'prior-by' }), token({ provider: 'alfa-by' })],
      getJson: async (url) => {
        // Приор отвечает медленнее — порядок всё равно обязан идти по LISTABLE_PROVIDERS.
        if (!url.includes('partner')) await new Promise(r => setTimeout(r, 10))
        return { accounts: [] }
      }
    }))
    expect(out.map(p => p.provider)).toEqual(['alfa-by', 'prior-by'])
  })

  it('падение обновления токена (протухший грант) тоже мягкое — самый вероятный отказ этого экрана', async () => {
    const out = await listBankSideAccounts('M1', deps({
      ensureFresh: async () => {
        throw new Error('invalid_grant')
      }
    }))
    expect(out[0]).toMatchObject({ provider: 'alfa-by', accounts: [], error: 'invalid_grant' })
  })
})

describe('сверка счетов: занятый лок обновления токена (#539)', () => {
  it('говорит человеческим текстом, а не исключением Postgres', async () => {
    // Держатель того же лока — плановое продление токена, у которого потолок POST к банку 15 с.
    // Значит «не дождались» — штатный исход, и он обязан читаться как состояние, а не как поломка.
    const out = await listBankSideAccounts('M1', deps({
      ensureFresh: async () => {
        throw Object.assign(new Error('canceling statement due to lock timeout'), { code: PG_LOCK_TIMEOUT })
      }
    }))
    expect(out[0]?.error).toBe('банк опрашивается прямо сейчас — обновите страницу через несколько секунд')
    // ⚠ Текста исключения на экране быть не должно: сообщение pg несёт имена таблиц.
    expect(out[0]?.error).not.toContain('lock timeout')
  })

  it('обычная ошибка банка по-прежнему показывается как есть', async () => {
    // Иначе «человеческий текст» съел бы диагностику: протухший грант и занятый лок чинятся
    // по-разному, и подменять первый вторым значило бы врать админу.
    const out = await listBankSideAccounts('M1', deps({
      ensureFresh: async () => {
        throw new Error('invalid_grant')
      }
    }))
    expect(out[0]?.error).toBe('invalid_grant')
  })
})
