import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  admitDeferredClaim, applySystemUserClaim, MAX_DEFERRED_CLAIMS_PER_MINUTE,
  resetSystemUserRefusals, SYSTEM_USER_REFUSAL_TTL_MS, SystemUserPendingError, withElementResponsible
} from '../server/utils/systemUser'
import { applicationTokenHash } from '../server/utils/appTokenHash'
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
    // Событие приходит по завершении установки и может опередить её запись; онлайн-события портал не
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

describe('withElementResponsible — служебный пользователь, иначе установивший (поле не передаём)', () => {
  const refusal = (code: string) => new PortalRestError('portal said no', code, 'crm.item.add')
  type R = () => Promise<number | null>

  it('служебный пользователь известен — он', async () => {
    expect(await withElementResponsible('M', { loadSystemUserId: async () => 512 }, r => r())).toBe(512)
  })

  it('не известен — null: поле не передаём, и по документации crm.item.add ответственным станет вызывающий, то есть установивший', async () => {
    expect(await withElementResponsible('M', { loadSystemUserId: async () => null }, r => r())).toBeNull()
  })

  it('ЛЕНИВО: запись, которой не пришлось создавать элемент, базу не читает', async () => {
    const loadSystemUserId = vi.fn(async () => 512)
    expect(await withElementResponsible('M', { loadSystemUserId }, async () => 'found')).toBe('found')
    expect(loadSystemUserId).not.toHaveBeenCalled()
  })

  it('на одну запись — одно чтение, сколько бы элементов она ни создала', async () => {
    const loadSystemUserId = vi.fn(async () => 512)
    const ids = await withElementResponsible('M', { loadSystemUserId }, async r => [await r(), await r()])
    expect(ids).toEqual([512, 512])
    expect(loadSystemUserId).toHaveBeenCalledTimes(1)
  })

  it('портал ОТКАЗАЛ служебному пользователю — та же запись повторяется без поля, то есть на установившем', async () => {
    // «Там, где нет такой поддержки, — установивший»: второй вид «нет поддержки» ловится только ответом.
    const seen: (number | null)[] = []
    const write = async (r: R) => {
      const id = await r()
      seen.push(id)
      if (id === 512) throw refusal('CRM_FIELD_ERROR_VALUE_NOT_VALID')
      return 'ok'
    }
    expect(await withElementResponsible('M', { loadSystemUserId: async () => 512 }, write)).toBe('ok')
    expect(seen).toEqual([512, null])
  })

  it('служебного пользователя НЕ БЫЛО, а портал отказал — повтора нет: запись и так шла на установившего', async () => {
    const write = vi.fn(async (r: R) => {
      await r()
      throw refusal('ACCESS_DENIED')
    })
    await expect(withElementResponsible('M', { loadSystemUserId: async () => null }, write)).rejects.toThrow('portal said no')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('после удачного повтора портал помнится недолго: следующие записи сразу на установившего', async () => {
    let t = 1_000_000
    const now = () => t
    const loadSystemUserId = vi.fn(async () => 512)
    const write = async (r: R) => {
      const id = await r()
      if (id === 512) throw refusal('ACCESS_DENIED')
      return id
    }
    await withElementResponsible('M', { loadSystemUserId, now }, write)
    expect(await withElementResponsible('M', { loadSystemUserId, now }, r => r())).toBeNull()
    t += SYSTEM_USER_REFUSAL_TTL_MS + 1
    expect(await withElementResponsible('M', { loadSystemUserId, now }, r => r())).toBe(512)
  })

  it('память об отказе — на ПОРТАЛ: соседний портал по-прежнему идёт на своего служебного пользователя', async () => {
    const write = async (r: R) => {
      const id = await r()
      if (id === 512) throw refusal('ACCESS_DENIED')
      return id
    }
    await withElementResponsible('M', { loadSystemUserId: async () => 512 }, write)
    expect(await withElementResponsible('OTHER', { loadSystemUserId: async () => 512 }, r => r())).toBe(512)
  })

  it('повтор на установившем ТОЖЕ упал — значит мешал не ответственный: ошибка наружу, отказ не помним', async () => {
    const write = async (r: R) => {
      await r()
      throw refusal('CRM_FIELD_ERROR_VALUE_NOT_VALID')
    }
    await expect(withElementResponsible('M', { loadSystemUserId: async () => 512 }, write)).rejects.toThrow('portal said no')
    expect(await withElementResponsible('M', { loadSystemUserId: async () => 512 }, r => r())).toBe(512)
  })

  it.each([
    ['QUERY_LIMIT_EXCEEDED'], ['INTERNAL_SERVER_ERROR'], ['expired_token'],
    // Коды, которые SDK ставит на сбой ТРАНСПОРТА, и отказы не про ответственного (находка ревью #783):
    // прежний список «временных» их пропускал, и один сетевой сбой переводил портал на установившего.
    ['NETWORK_ERROR'], ['REQUEST_TIMEOUT'], ['ECONNRESET'], ['invalid_grant'], ['PAYMENT_REQUIRED'], ['INVALID_ARG_VALUE']
  ])('отказ не про ответственного (%s) — не повод ставить на установившего: повторит сама задача', async (code) => {
    const write = vi.fn(async (r: R) => {
      await r()
      throw refusal(code)
    })
    await expect(withElementResponsible('M', { loadSystemUserId: async () => 512 }, write)).rejects.toThrow()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('сетевой сбой (кода нет) — тоже без повтора на установившем', async () => {
    const write = vi.fn(async (r: R) => {
      await r()
      throw new Error('ECONNRESET')
    })
    await expect(withElementResponsible('M', { loadSystemUserId: async () => 512 }, write)).rejects.toThrow('ECONNRESET')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('отказ ДО выбора ответственного (например, на поиске) — повтора нет: ответственный тут ни при чём', async () => {
    const write = vi.fn(async () => {
      throw refusal('ACCESS_DENIED')
    })
    await expect(withElementResponsible('M', { loadSystemUserId: async () => 512 }, write)).rejects.toThrow()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('память об отказе — на ПАРУ портал+пользователь: новый служебный пользователь идёт сразу, без всякого сброса', async () => {
    // Сброс по событию чистил бы карту НЕ того процесса: событие пишет `backend`, элементы — `worker`.
    const write = async (r: R) => {
      const id = await r()
      if (id === 512) throw refusal('ACCESS_DENIED')
      return id
    }
    await withElementResponsible('M', { loadSystemUserId: async () => 512 }, write)
    expect(await withElementResponsible('M', { loadSystemUserId: async () => 512 }, r => r())).toBeNull()
    expect(await withElementResponsible('M', { loadSystemUserId: async () => 600 }, r => r())).toBe(600)
  })

  it('тот же код, но отказал НЕ вызов создания (поиск, пересчёт) — повтора нет: там ответственного не было', async () => {
    for (const method of ['crm.item.list', 'crm.item.update']) {
      const write = vi.fn(async (r: R) => {
        await r()
        throw new PortalRestError('portal said no', 'ACCESS_DENIED', method)
      })
      await expect(withElementResponsible('M', { loadSystemUserId: async () => 512 }, write)).rejects.toThrow()
      expect(write).toHaveBeenCalledTimes(1)
    }
  })

  it('отказ пришёл голой ошибкой SDK (код и метод в её полях, не наш PortalRestError) — распознан', async () => {
    // Жёсткие коды SDK бросает сам, мимо нашего транспорта; метод у такой ошибки — в `requestInfo`.
    const seen: (number | null)[] = []
    const write = async (r: R) => {
      const id = await r()
      seen.push(id)
      if (id === 512) throw Object.assign(new Error('Доступ запрещён'), { code: 'ACCESS_DENIED', requestInfo: { method: 'crm.item.add' } })
      return 'ok'
    }
    expect(await withElementResponsible('M', { loadSystemUserId: async () => 512 }, write)).toBe('ok')
    expect(seen).toEqual([512, null])
  })

  it('отказ завёрнут SDK в JSSDK_UNKNOWN_ERROR — код и метод берутся из вложенной ошибки', async () => {
    const seen: (number | null)[] = []
    const write = async (r: R) => {
      const id = await r()
      seen.push(id)
      if (id === 512) {
        throw Object.assign(new Error('wrapped'), {
          code: 'JSSDK_UNKNOWN_ERROR',
          originalError: new PortalRestError('portal said no', 'CRM_FIELD_ERROR_VALUE_NOT_VALID', 'crm.item.add')
        })
      }
      return 'ok'
    }
    expect(await withElementResponsible('M', { loadSystemUserId: async () => 512 }, write)).toBe('ok')
    expect(seen).toEqual([512, null])
  })
})

describe('SystemUserPendingError — в тексте хеш портала, а не member_id', () => {
  it('непроверенный member_id не попадает в строку лога падений задачи', () => {
    const e = new SystemUserPendingError('abc123member')
    expect(e.message).not.toContain('abc123member')
  })
})

describe('admitDeferredClaim — потолок несверенных заявок на весь сервис', () => {
  it('Redis не отвечает (ждёт, а не отказывает) — ДЕДЛАЙН, а не висящий запрос', async () => {
    const never = () => new Promise<number>(() => {})
    await expect(admitDeferredClaim(never, 0, 20)).rejects.toThrow(/deadline/)
  })

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
