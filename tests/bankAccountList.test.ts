import { describe, it, expect } from 'vitest'
import { PG_LOCK_TIMEOUT } from '../server/utils/bankRefreshLock'
import { setAccountErrorMessage } from '../app/utils/setAccountError'
import {
  accountsRequestHeaders,
  accountsUrl,
  connectedKeys,
  extractAlfaAccounts,
  hasConnection,
  listBankSideAccounts,
  LISTABLE_PROVIDERS,
  mergeGrantAnswers,
  pickGrantTokens,
  type BankSideListDeps
} from '../server/utils/bankAccountList'
import type { BankToken } from '../server/utils/bankTokenStore'
import type { BankProviderId } from '../app/types/statement'

/** Сравнение близнецов по существу: у клиентского текст — предложение (заглавная, точка), у
 *  серверного — вставка в шаблон алерта. Третьей копии текста здесь НЕТ намеренно: она устаревала
 *  бы при согласованной правке обоих файлов и краснела бы на верном изменении. */
const sameMessage = (a: string, b: string) =>
  a.trim().toLowerCase().replace(/[.\s]+$/, '') === b.trim().toLowerCase().replace(/[.\s]+$/, '')

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

describe('pickGrantTokens', () => {
  it('returns nothing when the provider has no connection', () => {
    expect(pickGrantTokens([token({ provider: 'alfa-by' })], 'prior-by')).toEqual([])
  })

  it('takes the freshest token WITHIN a grant — its rows share one pair', () => {
    const old = token({ accountKey: 'A', grantId: 'G1', expiresAt: 10 })
    const fresh = token({ accountKey: 'B', grantId: 'G1', expiresAt: 99 })
    expect(pickGrantTokens([old, fresh], 'alfa-by').map(t => t.accountKey)).toEqual(['B'])
  })

  // ⚠ Главный случай правки: два юрлица клиента — два ключа API Альфы (или два согласия Приора).
  // Прежний `pickToken` спрашивал банк ОДНИМ токеном, и счета второго подключения не появлялись
  // в сверке никогда — уходили в `crm-only` с советом подключить уже подключённый банк.
  it('asks EVERY grant of the provider, not just the freshest connection', () => {
    const g1 = token({ accountKey: 'A', grantId: 'G1', expiresAt: 10 })
    const g2 = token({ accountKey: 'B', grantId: 'G2', expiresAt: 99 })
    expect(pickGrantTokens([g1, g2], 'alfa-by').map(t => t.accountKey).sort()).toEqual(['A', 'B'])
  })

  // ⚠ Пустой грант — «не размечено», а НЕ «общий»: склеив такие строки, мы спросили бы банк одним
  // токеном за все старые подключения портала (тот же довод, что в `bankTokenStore`).
  it('treats UNMARKED rows as separate grants, never as one shared grant', () => {
    const a = token({ accountKey: 'A', expiresAt: 10 })
    const b = token({ accountKey: 'B', expiresAt: 99 })
    expect(pickGrantTokens([a, b], 'alfa-by').map(t => t.accountKey).sort()).toEqual(['A', 'B'])
    expect(pickGrantTokens([a, b, token({ accountKey: 'C', grantId: '' })], 'alfa-by')).toHaveLength(3)
  })

  it('is willing to use a PENDING connection — that is the common case for this screen', () => {
    const pending = token({ accountKey: '~pending:abc', expiresAt: 50 })
    expect(pickGrantTokens([pending], 'alfa-by').map(t => t.accountKey)).toEqual(['~pending:abc'])
  })
})

describe('mergeGrantAnswers', () => {
  it('joins the accounts of several connections to one bank and counts them', () => {
    const out = mergeGrantAnswers([
      { provider: 'alfa-by', accounts: [{ number: 'BY1', provider: 'alfa-by' }] },
      { provider: 'alfa-by', accounts: [{ number: 'BY2', provider: 'alfa-by' }] }
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.accounts.map(a => a.number)).toEqual(['BY1', 'BY2'])
    expect(out[0]!.asked).toBe(2)
    expect(out[0]!.failed).toBe(0)
    expect(out[0]!.error).toBeUndefined()
  })

  // ⚠ Положительное знание отказ соседа НЕ отменяет: счёт, названный живым подключением, остаётся.
  // Но `error` выставляется — иначе `bankSideIncomplete` объявил бы картину полной, и реквизит,
  // который никто не проверял, получил бы уверенное «банк его не отдаёт».
  it('keeps what one connection answered while marking the side incomplete', () => {
    const out = mergeGrantAnswers([
      { provider: 'alfa-by', accounts: [{ number: 'BY1', provider: 'alfa-by' }] },
      { provider: 'alfa-by', accounts: [], error: 'банк не ответил' }
    ])
    expect(out[0]!.accounts.map(a => a.number)).toEqual(['BY1'])
    expect(out[0]!.error).toBe('банк не ответил')
    expect(out[0]!.asked).toBe(2)
    expect(out[0]!.failed).toBe(1)
  })

  it('dedupes a number both connections named — one account, one row', () => {
    const out = mergeGrantAnswers([
      { provider: 'alfa-by', accounts: [{ number: 'BY1', provider: 'alfa-by' }] },
      { provider: 'alfa-by', accounts: [{ number: 'BY1', provider: 'alfa-by' }] }
    ])
    expect(out[0]!.accounts).toHaveLength(1)
  })

  it('keeps the banks apart and in order', () => {
    const out = mergeGrantAnswers([
      { provider: 'alfa-by', accounts: [] },
      { provider: 'prior-by', accounts: [] },
      { provider: 'alfa-by', accounts: [] }
    ])
    expect(out.map(p => p.provider)).toEqual(['alfa-by', 'prior-by'])
    expect(out[0]!.asked).toBe(2)
    expect(out[1]!.asked).toBe(1)
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
    expect(out).toEqual([{
      provider: 'alfa-by',
      accounts: [{ number: 'BY11ALFA0001', currency: 'BYN', provider: 'alfa-by' }],
      asked: 1,
      failed: 0
    }])
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
    expect(out).toEqual([{
      provider: 'prior-by',
      accounts: [{ number: 'BY11PJCB0001', currency: 'BYN', provider: 'prior-by' }],
      asked: 1,
      failed: 0
    }])
  })

  it('fails SOFT per provider: a bank error does not blank the other bank', async () => {
    const calls: BankProviderId[] = []
    const out = await listBankSideAccounts('M1', deps({
      tokens: async () => [token({ provider: 'alfa-by' }), token({ provider: 'prior-by' })],
      getJson: async (provider, _url) => {
        calls.push(provider)
        if (provider === 'alfa-by') throw new Error('банк не ответил (503)')
        return { data: { account: [{ accountId: 'x', accountDetails: { identification: 'BY11PJCB0001' } }] } }
      }
    }))
    // Оба банка спрошены; порядок в `calls` не утверждаем — запросы идут параллельно.
    expect([...calls].sort()).toEqual(['alfa-by', 'prior-by'])
    expect(out[0]).toEqual({ provider: 'alfa-by', accounts: [], error: 'банк не ответил (503)', asked: 1, failed: 1 })
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
      getJson: async (_provider, _url, at) => {
        seen.push(at)
        return { accounts: [] }
      }
    }))
    expect(seen).toEqual(['FRESH'])
  })

  // ⚠ ОДИН запрос на ПОДКЛЮЧЕНИЕ, а не на счёт. Согласие банк выдаёт на набор счетов клиента, и
  // все строки одного гранта живут на общей паре токенов — спрашивать по строке значило бы задать
  // один и тот же вопрос столько раз, сколько у клиента счетов.
  it('asks ONCE per grant, however many accounts that grant covers', async () => {
    let n = 0
    await listBankSideAccounts('M1', deps({
      tokens: async () => [
        token({ accountKey: 'A', grantId: 'G1' }),
        token({ accountKey: 'B', grantId: 'G1' }),
        token({ accountKey: 'C', grantId: 'G1' })
      ],
      getJson: async () => {
        n += 1
        return { accounts: [] }
      }
    }))
    expect(n).toBe(1)
  })

  // ⚠ А вот РАЗНЫЕ подключения к одному банку (два юрлица клиента — два ключа API Альфы) обязаны
  // быть спрошены каждое: их счета знает только их собственный токен. Прежний код спрашивал один
  // раз, и счета второго подключения не появлялись в сверке никогда.
  it('asks EVERY connection of the same bank and merges what they answered', async () => {
    const out = await listBankSideAccounts('M1', deps({
      tokens: async () => [
        token({ accountKey: 'A', grantId: 'G1', accessToken: 'AT1' }),
        token({ accountKey: 'B', grantId: 'G2', accessToken: 'AT2' })
      ],
      // Каждое подключение отвечает СВОИМ счётом — так видно, что спрошены оба токена, а не один.
      getJson: async (_p, _url, at) => ({ accounts: [{ number: at === 'AT1' ? 'BY1' : 'BY2' }] })
    }))
    expect(out).toHaveLength(1)
    expect(out[0]!.accounts.map(a => a.number).sort()).toEqual(['BY1', 'BY2'])
    expect(out[0]!.asked).toBe(2)
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
    expect(sameMessage(out[0]?.error ?? '', setAccountErrorMessage({ statusCode: 503 }))).toBe(true)
    // ⚠ Текста исключения на экране быть не должно: сообщение pg несёт имена таблиц.
    expect(out[0]?.error).not.toContain('lock timeout')
  })

  it('обычная ошибка банка НЕ выдаётся за «занято»', () => {
    // Иначе проверка выше стала бы бессодержательной: совпасть с близнецом мог бы любой текст.
    expect(sameMessage('invalid_grant', setAccountErrorMessage({ statusCode: 503 }))).toBe(false)
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

describe('#20 Приор отдаёт счета, а сверка их не показывала', () => {
  it('банк передаётся транспорту — он собирает СВОИ заголовки', async () => {
    // ⚠ Корень дефекта. Приор проверяет заголовок взаимодействия FAPI на ЛЮБОМ вызове и делает это
    // ДО тела (#461), поэтому запрос с одним `Authorization` он отвергает. Транспорт сверки слал
    // ровно его, а отказ здесь fail-soft по провайдеру — значит счета Приора не появлялись в
    // сверке НИКОГДА, и выглядело это как «банк их не отдаёт», то есть указывало не на ту сторону.
    const seen: string[] = []
    await listBankSideAccounts('M1', deps({
      tokens: async () => [token({ provider: 'alfa-by' }), token({ provider: 'prior-by' })],
      getJson: async (provider) => {
        seen.push(provider)
        return { accounts: [] }
      }
    }))
    expect([...seen].sort()).toEqual(['alfa-by', 'prior-by'])
  })

  it('банк ответил, но НИ У ОДНОГО счёта нет номера — это состояние, а не молчание', async () => {
    // ⚠ Молча отбросив все строки, экран выглядел бы как отказ связи, и админ искал бы причину в
    // банке или в подключении — тогда как чинится это на стороне банка: у счёта не заполнен IBAN.
    const out = await listBankSideAccounts('M1', deps({
      tokens: async () => [token({ provider: 'prior-by' })],
      getJson: async () => ({ data: { account: [{ accountId: 'x' }, { accountId: 'y' }] } })
    }))
    expect(out[0]?.accounts).toEqual([])
    expect(String(out[0]?.error)).toContain('без номера')
    expect(String(out[0]?.error)).toContain('2')
  })

  it('часть счетов без номера — показываем остальные и НЕ жалуемся', async () => {
    // Пустая строка сверять не с чем, но остальные вполне рабочие: жалоба тут была бы ложной.
    const out = await listBankSideAccounts('M1', deps({
      tokens: async () => [token({ provider: 'prior-by' })],
      getJson: async () => ({
        data: { account: [{ accountId: 'x' }, { accountId: 'y', accountDetails: { identification: 'BY11PJCB0001' } }] }
      })
    }))
    expect(out[0]?.accounts).toEqual([{ number: 'BY11PJCB0001', currency: undefined, provider: 'prior-by' }])
    expect(out[0]?.error).toBeUndefined()
  })

  it('банк вернул ПУСТОЙ список — это не «без номера», а честный ноль', async () => {
    const out = await listBankSideAccounts('M1', deps({
      tokens: async () => [token({ provider: 'prior-by' })],
      getJson: async () => ({ data: { account: [] } })
    }))
    expect(out[0]?.accounts).toEqual([])
    expect(out[0]?.error).toBeUndefined()
  })
})

describe('#20 заголовки списка счетов зависят от банка', () => {
  it('Приору идут ЕГО заголовки, а не один Authorization', async () => {
    // ⚠ Ровно та мутация, что жила на проде: транспорт слал один `Authorization`, банк отвергал
    // запрос ДО тела, отказ глотался fail-soft по провайдеру — и счета Приора не появлялись в
    // сверке никогда. Проверять это в роуте нельзя: там `defineEventHandler` поверх живого fetch.
    const h = accountsRequestHeaders('prior-by', 'AT', 'I-1')
    expect(Object.keys(h).length).toBeGreaterThan(1)
    expect(Object.values(h)).toContain('I-1')
    expect(h.authorization).toBe('Bearer AT')
  })

  it('Альфе — только Bearer: лишние заголовки ей не нужны', async () => {
    expect(accountsRequestHeaders('alfa-by', 'AT', 'I-1')).toEqual({ authorization: 'Bearer AT' })
  })

  it('идентификатор взаимодействия ИНЪЕКТИРУЕТСЯ — у чистой функции нет своей случайности', async () => {
    expect(accountsRequestHeaders('prior-by', 'AT', 'A')).not.toEqual(accountsRequestHeaders('prior-by', 'AT', 'B'))
  })
})

// ⚠ ЖИВОЙ ЭКРАН 2026-09-09. Портал показывал «Альфа-Банк: банк не ответил (401). Список счетов
// этого банка сейчас неизвестен» — в ту же минуту, когда забор выписки по этому же подключению
// работал. Разница была ровно одна: у забора реактивное переспрашивание токена уже стояло (#488),
// а здесь `ensureFresh` решал ПО ЧАСАМ, и «свежий по часам, но отвергнутый банком» токен не
// обновлял никто.
//
// ⚠ Цена не косметическая: без стороны банка КАЖДЫЙ счёт «моей компании» уходит в состояние «не
// спрашивали», и выбор счёта кликом — то, ради чего экран сделан, — пропадает. Админ возвращается
// к ручному вводу 28 знаков, где сравнение посимвольное.
describe('#488 сверка: отказ банка в токене — переспрашиваем и повторяем', () => {
  function unauthorized(): Error {
    return Object.assign(new Error('банк не ответил (401)'), { status: 401 })
  }

  it('401 → force-переиздание → повтор проходит, счета собраны', async () => {
    const forced: (boolean | undefined)[] = []
    const used: string[] = []
    let first = true
    const res = await listBankSideAccounts('M1', deps({
      ensureFresh: async (t, opts) => {
        forced.push(opts?.force)
        return { ...t, accessToken: opts?.force ? 'REISSUED' : 'FRESH' }
      },
      getJson: async (_p, _url, accessToken) => {
        used.push(accessToken)
        if (first) {
          first = false
          throw unauthorized()
        }
        return { accounts: [{ number: 'BY11ALFA0001', currIso: 'BYN' }] }
      }
    }))
    const alfa = res.find(r => r.provider === 'alfa-by')
    expect(alfa?.error).toBeUndefined()
    expect(alfa?.accounts.map(a => a.number)).toEqual(['BY11ALFA0001'])
    expect(used).toEqual(['FRESH', 'REISSUED'])
    // ⚠ Второй вызов обязан быть force: без флага решение снова принимается по часам и вернулся бы
    // тот же отвергнутый токен — починка была бы мёртвой.
    expect(forced).toEqual([undefined, true])
  })

  it('переспрашиваем ТЕКУЩИЙ токен, а не исходный из базы', async () => {
    const seen: string[] = []
    let first = true
    await listBankSideAccounts('M1', deps({
      ensureFresh: async (t, opts) => {
        seen.push(t.accessToken)
        return { ...t, accessToken: opts?.force ? 'REISSUED' : 'FRESH' }
      },
      getJson: async () => {
        if (first) {
          first = false
          throw unauthorized()
        }
        return { accounts: [] }
      }
    }))
    // Первый заход — токеном из базы, второй — тем, который только что получил отказ.
    expect(seen[1]).toBe('FRESH')
  })

  it('переспрашиваем РОВНО ОДИН раз — мёртвый грант не жжёт лимит банка на каждом открытии', async () => {
    let ensured = 0
    const res = await listBankSideAccounts('M1', deps({
      ensureFresh: async (t, opts) => {
        ensured++
        return { ...t, accessToken: opts?.force ? 'REISSUED' : 'FRESH' }
      },
      getJson: async () => {
        throw unauthorized()
      }
    }))
    expect(ensured).toBe(2)
    // Не помогло — честный отказ по провайдеру, а не исключение: соседний банк гаснуть не должен.
    expect(res.find(r => r.provider === 'alfa-by')?.error).toMatch(/401/)
  })

  it('ДРУГОЙ отказ банка переспрашивания НЕ вызывает', async () => {
    let ensured = 0
    await listBankSideAccounts('M1', deps({
      ensureFresh: async (t) => {
        ensured++
        return { ...t, accessToken: 'FRESH' }
      },
      getJson: async () => {
        throw Object.assign(new Error('банк не ответил (500)'), { status: 500 })
      }
    }))
    expect(ensured).toBe(1)
  })
})
