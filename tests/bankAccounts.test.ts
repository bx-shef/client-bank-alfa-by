import { describe, expect, it } from 'vitest'
import {
  handleDisconnectBankAccount,
  handleListBankAccounts,
  handleSetBankAccount,
  type DisconnectDeps,
  type ListAccountsDeps,
  type SetAccountDeps
} from '../server/utils/bankAccounts'
import { provisionalAccountKey } from '../app/utils/bankAccountKey'
import { classifyProvisionError } from '../server/utils/provisionRequest'
import type { BankAccountInfo } from '../server/utils/bankTokenStore'

// Connected bank accounts (#404). The gate is the interesting part: this endpoint pair reveals and
// revokes portal-wide bank bindings, so it must refuse exactly where /api/bank/connect refuses —
// unknown portal, a frame token that isn't this portal's, and non-admins.

const ROW: BankAccountInfo = {
  memberId: 'M1',
  provider: 'alfa-by',
  accountKey: 'BY01ALFA0001',
  connectedAt: 1_700_000_000_000,
  expiresAt: 1_700_003_600_000,
  hasRefresh: true,
  // ⚠ НЕНУЛЕВОЕ значение принципиально. С `undefined`/дефолтом `toEqual` сравнивает вакуумно:
  // Vitest игнорирует ключи со значением `undefined`, поэтому «точный состав полей» проходил и
  // тогда, когда поле вообще выпилили из ответа (#503, находка ревью).
  consentExpiresAt: 1_700_000_500_000
}

function listDeps(over: Partial<ListAccountsDeps> = {}): ListAccountsDeps {
  return {
    memberIdByDomain: async () => 'M1',
    validateFrame: async () => ({ userId: '7', isAdmin: true }),
    list: async () => [ROW],
    ...over
  }
}

function disconnectDeps(over: Partial<DisconnectDeps> = {}): DisconnectDeps {
  return {
    memberIdByDomain: async () => 'M1',
    validateFrame: async () => ({ userId: '7', isAdmin: true }),
    remove: async () => true,
    ...over
  }
}

const input = { accessToken: 't', domain: 'p.bitrix24.by' }

describe('handleListBankAccounts', () => {
  it('returns the portal accounts without any token material or internal ids', async () => {
    const res = await handleListBankAccounts(listDeps(), input)
    expect(res.status).toBe(200)
    const accounts = res.body.accounts as Record<string, unknown>[]
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toEqual({
      provider: 'alfa-by',
      accountKey: 'BY01ALFA0001',
      connectedAt: ROW.connectedAt,
      expiresAt: ROW.expiresAt,
      hasRefresh: true,
      consentExpiresAt: ROW.consentExpiresAt
    })
    // Отдельной строкой и на КОНКРЕТНОЕ значение: потеря поля по дороге беззвучна — сервер
    // продолжает хранить и считать дату, а предупреждения в интерфейсе просто нет.
    expect(accounts[0]!.consentExpiresAt).toBe(1_700_000_500_000)
    // memberId is an internal identifier — it must not be echoed to the browser.
    expect(JSON.stringify(res.body)).not.toContain('M1')
  })

  it('is 400 without frame auth, 409 for an unknown portal', async () => {
    expect((await handleListBankAccounts(listDeps(), { accessToken: '', domain: '' })).status).toBe(400)
    expect((await handleListBankAccounts(listDeps({ memberIdByDomain: async () => null }), input)).status).toBe(409)
  })

  it('is 403 when the frame token is not valid for that portal (domain spoofing)', async () => {
    const deps = listDeps({
      validateFrame: async () => {
        throw new Error('nope')
      }
    })
    expect((await handleListBankAccounts(deps, input)).status).toBe(403)
  })

  it('is 403 for a non-admin — and never reads the accounts', async () => {
    let read = false
    const deps = listDeps({
      validateFrame: async () => ({ userId: '9', isAdmin: false }),
      list: async () => {
        read = true
        return [ROW]
      }
    })
    expect((await handleListBankAccounts(deps, input)).status).toBe(403)
    expect(read).toBe(false)
  })

  it('answers with an empty list for a portal that connected nothing', async () => {
    const res = await handleListBankAccounts(listDeps({ list: async () => [] }), input)
    expect(res.status).toBe(200)
    expect(res.body.accounts).toEqual([])
  })
})

describe('classifyProvisionError', () => {
  it('recognises the SDK-shaped scope error, not just the machine code', () => {
    // The SDK surfaces getErrorMessages() only, so the usual text is the human description with
    // «higher privileges» and NO `insufficient_scope` — the branch must catch that shape (#408).
    for (const raw of [
      'insufficient_scope',
      'The request requires higher privileges than provided by the access token',
      'ACCESS DENIED: userfieldconfig.add'
    ]) {
      expect(classifyProvisionError(raw)).toContain('userfieldconfig')
    }
  })

  it('does NOT read a plain field conflict as «reinstall the app»', () => {
    // The method name alone must not trigger the scope advice — a duplicate fieldName also echoes
    // `userfieldconfig`, and sending the admin to reinstall would be actively wrong.
    const msg = classifyProvisionError('userfieldconfig: field with this name already exists')
    expect(msg).not.toContain('Переустановите')
  })

  it('separates rights, expired auth and network from the generic case', () => {
    expect(classifyProvisionError('ACCESS_DENIED')).toContain('администратор')
    expect(classifyProvisionError('expired_token')).toContain('авторизация')
    expect(classifyProvisionError('fetch failed')).toContain('не ответил вовремя')
    expect(classifyProvisionError('some unknown portal burp')).toContain('Повторите попытку')
  })

  it('never promises the admin a message they cannot see', () => {
    // The raw text goes to the server log only, so «пришлите этот текст» sent them hunting for
    // something that is not on screen.
    expect(classifyProvisionError('whatever')).not.toContain('этот текст')
  })
})

describe('handleDisconnectBankAccount', () => {
  it('removes the named account of the CALLER portal', async () => {
    const seen: string[] = []
    const deps = disconnectDeps({
      remove: async (memberId, provider, accountKey) => {
        seen.push(`${memberId}|${provider}|${accountKey}`)
        return true
      }
    })
    const res = await handleDisconnectBankAccount(deps, { ...input, provider: 'alfa-by', accountKey: ' BY01ALFA0001 ' })
    expect(res.status).toBe(200)
    expect(res.body.removed).toBe(true)
    // memberId comes from OUR domain lookup, never from the request body.
    expect(seen).toEqual(['M1|alfa-by|BY01ALFA0001'])
  })

  it('is idempotent — removing an already-gone account is 200 {removed:false}', async () => {
    const deps = disconnectDeps({ remove: async () => false })
    const res = await handleDisconnectBankAccount(deps, { ...input, provider: 'alfa-by', accountKey: 'BY01ALFA0001' })
    expect(res.status).toBe(200)
    expect(res.body.removed).toBe(false)
  })

  it('rejects a blank or unknown provider before touching the store', async () => {
    let touched = false
    const deps = disconnectDeps({
      remove: async () => {
        touched = true
        return true
      }
    })
    expect((await handleDisconnectBankAccount(deps, { ...input, provider: '', accountKey: 'A' })).status).toBe(400)
    expect((await handleDisconnectBankAccount(deps, { ...input, provider: 'alfa-by', accountKey: '' })).status).toBe(400)
    expect((await handleDisconnectBankAccount(deps, { ...input, provider: 'evil-bank', accountKey: 'A' })).status).toBe(400)
    expect(touched).toBe(false)
  })

  it('is 403 for a non-admin — and never deletes', async () => {
    let touched = false
    const deps = disconnectDeps({
      validateFrame: async () => ({ userId: '9', isAdmin: false }),
      remove: async () => {
        touched = true
        return true
      }
    })
    expect((await handleDisconnectBankAccount(deps, { ...input, provider: 'alfa-by', accountKey: 'A' })).status).toBe(403)
    expect(touched).toBe(false)
  })
})

describe('handleSetBankAccount', () => {
  const PENDING = provisionalAccountKey('n1')

  function deps(over: Partial<SetAccountDeps> = {}): SetAccountDeps {
    return {
      memberIdByDomain: async () => 'M1',
      validateFrame: async () => ({ userId: '7', isAdmin: true }),
      rename: async () => 'renamed',
      ...over
    }
  }
  const body = { ...input, provider: 'alfa-by', pendingKey: PENDING, accountKey: 'BY01ALFA0001' }

  it('назначает счёт подключению, которое ждало выбора', async () => {
    const seen: string[] = []
    const d = deps({
      rename: async (memberId, provider, from, to) => {
        seen.push(`${memberId}|${provider}|${from}|${to}`)
        return 'renamed'
      }
    })
    const res = await handleSetBankAccount(d, body)
    expect(res.status).toBe(200)
    // memberId берётся из проверенного домена, а не из тела запроса.
    expect(seen).toEqual([`M1|alfa-by|${PENDING}|BY01ALFA0001`])
  })

  it('НЕ даёт подменить счёт у живого подключения — только временный ключ', async () => {
    // Иначе это был бы способ увести операции чужого счёта на другой номер.
    let touched = false
    const d = deps({
      rename: async () => {
        touched = true
        return 'renamed'
      }
    })
    const res = await handleSetBankAccount(d, { ...body, pendingKey: 'BY01ALFA9999' })
    expect(res.status).toBe(400)
    expect(touched).toBe(false)
  })

  it('409, если такой счёт уже подключён — не затираем живой токен', async () => {
    const res = await handleSetBankAccount(deps({ rename: async () => 'conflict' }), body)
    expect(res.status).toBe(409)
  })

  it('404, если ожидающего подключения нет', async () => {
    const res = await handleSetBankAccount(deps({ rename: async () => 'not-found' }), body)
    expect(res.status).toBe(404)
  })

  it('503 «занято», когда строку держит обновление токена — и это НЕ 409', async () => {
    // ⚠ Разные смыслы, которые легко слить в один: 409 — «так не будет никогда» (номер занят,
    // нужен другой), 503 — «сейчас занято, через несколько секунд пройдёт» (#509). Слив приучил бы
    // либо повторять там, где повтор бесполезен, либо сдаваться там, где хватило бы второго клика.
    const res = await handleSetBankAccount(deps({ rename: async () => 'busy' }), body)
    expect(res.status).toBe(503)
    expect(res.status).not.toBe(409)
  })

  it('отвергает пустые и кривые значения до обращения к хранилищу', async () => {
    let touched = false
    const d = deps({
      rename: async () => {
        touched = true
        return 'renamed'
      }
    })
    expect((await handleSetBankAccount(d, { ...body, accountKey: '' })).status).toBe(400)
    expect((await handleSetBankAccount(d, { ...body, accountKey: 'BY 01/ALFA' })).status).toBe(400)
    expect((await handleSetBankAccount(d, { ...body, provider: 'evil' })).status).toBe(400)
    expect(touched).toBe(false)
  })

  it('403 не-админу — и ничего не переименовывает', async () => {
    let touched = false
    const d = deps({
      validateFrame: async () => ({ userId: '9', isAdmin: false }),
      rename: async () => {
        touched = true
        return 'renamed'
      }
    })
    expect((await handleSetBankAccount(d, body)).status).toBe(403)
    expect(touched).toBe(false)
  })
})
