import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  admitDeferredClaim, applicationTokenHash, applySystemUserClaim, MAX_DEFERRED_CLAIMS_PER_MINUTE,
  resetSystemUserRefusals, SYSTEM_USER_REFUSAL_TTL_MS, SystemUserPendingError, withElementResponsible
} from '../server/utils/systemUser'
import { resetTokenOwnerCache } from '../server/utils/portalTokenOwner'
import { PortalRestError } from '../server/utils/portalError'

// Служебный пользователь приложения (ONAPPUSERREADY): сверка в воркере и выбор ответственного
// элемента смарт-процесса (решение владельца 2026-09-29).

const TOKEN = '51856fefc120afa4b628cc82d3935cce'
const HASH = createHash('sha256').update(TOKEN, 'utf8').digest('hex')

function deps(stored: string, rowExists = true) {
  return {
    loadApplicationToken: vi.fn(async () => stored),
    setSystemUserId: vi.fn(async () => rowExists)
  }
}

afterEach(() => {
  resetTokenOwnerCache()
  resetSystemUserRefusals()
})

describe('applicationTokenHash', () => {
  it('sha256 в hex — то, с чем сверяет воркер, и не сам токен', () => {
    expect(applicationTokenHash(TOKEN)).toBe(HASH)
    expect(applicationTokenHash(TOKEN)).not.toContain(TOKEN)
  })
})

describe('applySystemUserClaim — сверка ВСЕГДА по токену, который лежит в базе сейчас', () => {
  it('отпечаток совпал с токеном установки — пишем', async () => {
    const d = deps(TOKEN)
    expect(await applySystemUserClaim({ memberId: 'M', userId: 512, appTokenHash: HASH }, d, { finalAttempt: false })).toBe('saved')
    expect(d.setSystemUserId).toHaveBeenCalledWith('M', 512)
  })

  it('отпечаток НЕ совпал — событие не от портала: отброшено, ничего не пишем', async () => {
    const d = deps('другой-токен')
    expect(await applySystemUserClaim({ memberId: 'M', userId: 512, appTokenHash: HASH }, d, { finalAttempt: false })).toBe('mismatch')
    expect(d.setSystemUserId).not.toHaveBeenCalled()
  })

  it('установка ещё не записана — ПОВТОРИТЬ (исключение), а не отказать', async () => {
    // Событие приходит вместе с установкой и часто раньше её записи; онлайн-события портал не
    // повторяет, так что отказ здесь терял бы служебного пользователя навсегда. Тот же путь чинит и
    // удаление с мгновенной переустановкой: строки на миг нет, потом она есть с тем же токеном.
    const d = deps('')
    await expect(applySystemUserClaim({ memberId: 'M', userId: 512, appTokenHash: HASH }, d, { finalAttempt: false }))
      .rejects.toBeInstanceOf(SystemUserPendingError)
    expect(d.setSystemUserId).not.toHaveBeenCalled()
  })

  it('на ПОСЛЕДНЕЙ попытке — тихий отказ (expired), а не исключение', async () => {
    // Исчерпанная задача легла бы в счёт падений очереди и будила бы владельца «очередь падает»,
    // хотя это не наша поломка, а недошедшая установка или подделка.
    const d = deps('')
    expect(await applySystemUserClaim({ memberId: 'M', userId: 512, appTokenHash: HASH }, d, { finalAttempt: true })).toBe('expired')
    expect(d.setSystemUserId).not.toHaveBeenCalled()
  })

  it('портала у нас уже нет — gone, без ошибки', async () => {
    const d = deps(TOKEN, false)
    expect(await applySystemUserClaim({ memberId: 'M', userId: 512, appTokenHash: HASH }, d, { finalAttempt: false })).toBe('gone')
  })
})

describe('withElementResponsible — служебный пользователь, иначе установивший', () => {
  const profileCall = (id = '7') => vi.fn(async (method: string) => (method === 'profile' ? { result: { ID: id } } : {}))
  const refusal = (code: string) => new PortalRestError('portal said no', code, 'crm.item.add')

  it('служебный пользователь известен — он, и profile не спрашиваем вовсе', async () => {
    const call = profileCall()
    expect(await withElementResponsible('M', call, { loadSystemUserId: async () => 512 }, r => r())).toBe(512)
    expect(call).not.toHaveBeenCalled()
  })

  it('не известен — владелец сохранённого токена (profile → ID), один вызов на портал', async () => {
    const call = profileCall('7')
    const load = { loadSystemUserId: async () => null }
    expect(await withElementResponsible('M', call, load, r => r())).toBe(7)
    expect(await withElementResponsible('M', call, load, r => r())).toBe(7)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('ЛЕНИВО: запись, которой не пришлось создавать элемент, не читает ни базу, ни profile', async () => {
    const loadSystemUserId = vi.fn(async () => 512)
    const call = profileCall()
    expect(await withElementResponsible('M', call, { loadSystemUserId }, async () => 'found')).toBe('found')
    expect(loadSystemUserId).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })

  it('на одну запись — одно чтение, сколько бы элементов она ни создала', async () => {
    const loadSystemUserId = vi.fn(async () => 512)
    const ids = await withElementResponsible('M', profileCall(), { loadSystemUserId }, async r => [await r(), await r()])
    expect(ids).toEqual([512, 512])
    expect(loadSystemUserId).toHaveBeenCalledTimes(1)
  })

  it('портал ОТКАЗАЛ служебному пользователю — та же запись повторяется на установившем', async () => {
    // «Там, где нет такой поддержки, — установивший»: второй вид «нет поддержки» ловится только ответом.
    const seen: number[] = []
    const write = async (r: () => Promise<number>) => {
      const id = await r()
      seen.push(id)
      if (id === 512) throw refusal('INVALID_ARG_VALUE')
      return 'ok'
    }
    expect(await withElementResponsible('M', profileCall('7'), { loadSystemUserId: async () => 512 }, write)).toBe('ok')
    expect(seen).toEqual([512, 7])
  })

  it('после удачного повтора портал помнится недолго: следующие записи сразу на установившего', async () => {
    let t = 1_000_000
    const now = () => t
    const loadSystemUserId = vi.fn(async () => 512)
    const write = async (r: () => Promise<number>) => {
      const id = await r()
      if (id === 512) throw refusal('ACCESS_DENIED')
      return id
    }
    await withElementResponsible('M', profileCall('7'), { loadSystemUserId, now }, write)
    expect(await withElementResponsible('M', profileCall('7'), { loadSystemUserId, now }, r => r())).toBe(7)
    t += SYSTEM_USER_REFUSAL_TTL_MS + 1
    expect(await withElementResponsible('M', profileCall('7'), { loadSystemUserId, now }, r => r())).toBe(512)
  })

  it('повтор на установившем ТОЖЕ упал — значит мешал не ответственный: ошибка наружу, отказ не помним', async () => {
    const write = async (r: () => Promise<number>) => {
      await r()
      throw refusal('INVALID_ARG_VALUE')
    }
    await expect(withElementResponsible('M', profileCall('7'), { loadSystemUserId: async () => 512 }, write)).rejects.toThrow('portal said no')
    expect(await withElementResponsible('M', profileCall('7'), { loadSystemUserId: async () => 512 }, r => r())).toBe(512)
  })

  it.each([['QUERY_LIMIT_EXCEEDED'], ['INTERNAL_SERVER_ERROR'], ['expired_token']])(
    'временный отказ портала (%s) — не повод ставить на установившего: повторит сама задача', async (code) => {
      const write = vi.fn(async (r: () => Promise<number>) => {
        await r()
        throw refusal(code)
      })
      await expect(withElementResponsible('M', profileCall(), { loadSystemUserId: async () => 512 }, write)).rejects.toThrow()
      expect(write).toHaveBeenCalledTimes(1)
    })

  it('сетевой сбой (кода нет) — тоже без повтора на установившем', async () => {
    const write = vi.fn(async (r: () => Promise<number>) => {
      await r()
      throw new Error('ECONNRESET')
    })
    await expect(withElementResponsible('M', profileCall(), { loadSystemUserId: async () => 512 }, write)).rejects.toThrow('ECONNRESET')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('отказ ДО выбора ответственного (например, на поиске) — повтора нет: ответственный тут ни при чём', async () => {
    const write = vi.fn(async () => {
      throw refusal('ACCESS_DENIED')
    })
    await expect(withElementResponsible('M', profileCall(), { loadSystemUserId: async () => 512 }, write)).rejects.toThrow()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('портал не назвал владельца — БРОСАЕТ, а не ставит элемент «на кого придётся»', async () => {
    const call = vi.fn(async () => ({ result: {} }))
    await expect(withElementResponsible('M', call, { loadSystemUserId: async () => null }, r => r()))
      .rejects.toThrow(/assignedById of a smart-process element/)
  })

  it('записанный новый служебный пользователь снимает память об отказе', async () => {
    const write = async (r: () => Promise<number>) => {
      const id = await r()
      if (id === 512) throw refusal('ACCESS_DENIED')
      return id
    }
    await withElementResponsible('M', profileCall('7'), { loadSystemUserId: async () => 512 }, write)
    await applySystemUserClaim({ memberId: 'M', userId: 600, appTokenHash: HASH }, deps(TOKEN), { finalAttempt: false })
    expect(await withElementResponsible('M', profileCall('7'), { loadSystemUserId: async () => 600 }, r => r())).toBe(600)
  })
})

describe('admitDeferredClaim — потолок несверенных заявок на весь сервис', () => {
  function counter() {
    const counts = new Map<string, number>()
    const calls: Array<[string, number]> = []
    const incr = vi.fn(async (key: string, ttl: number) => {
      calls.push([key, ttl])
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      return n
    })
    return { incr, calls }
  }

  it('пускает до потолка включительно, дальше — нет', async () => {
    const { incr } = counter()
    const verdicts: boolean[] = []
    for (let i = 0; i < MAX_DEFERRED_CLAIMS_PER_MINUTE + 2; i++) verdicts.push(await admitDeferredClaim(incr, 60_000 * 100))
    expect(verdicts.filter(Boolean)).toHaveLength(MAX_DEFERRED_CLAIMS_PER_MINUTE)
    expect(verdicts.at(-1)).toBe(false)
  })

  it('окно — минута: в следующую счёт идёт заново, а ключ живёт дольше окна', async () => {
    const { incr, calls } = counter()
    for (let i = 0; i < MAX_DEFERRED_CLAIMS_PER_MINUTE; i++) await admitDeferredClaim(incr, 60_000 * 100)
    expect(await admitDeferredClaim(incr, 60_000 * 101)).toBe(true)
    expect(new Set(calls.map(c => c[0])).size).toBe(2)
    expect(calls.every(([, ttl]) => ttl > 60)).toBe(true) // ключ переживает своё окно, иначе счёт сбросился бы раньше
  })
})
