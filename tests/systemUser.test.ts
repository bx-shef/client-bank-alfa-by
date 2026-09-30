import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applicationTokenHash, applySystemUserClaim, elementResponsibleId, SystemUserPendingError
} from '../server/utils/systemUser'
import { resetTokenOwnerCache } from '../server/utils/portalTokenOwner'

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

afterEach(() => resetTokenOwnerCache())

describe('applicationTokenHash', () => {
  it('sha256 в hex — то, с чем сверяет воркер, и не сам токен', () => {
    expect(applicationTokenHash(TOKEN)).toBe(HASH)
    expect(applicationTokenHash(TOKEN)).not.toContain(TOKEN)
  })
})

describe('applySystemUserClaim', () => {
  it('сверенная роутом заявка пишется сразу, токен не читаем', async () => {
    const d = deps('')
    expect(await applySystemUserClaim({ memberId: 'M', userId: 512 }, d, { finalAttempt: false })).toBe('saved')
    expect(d.loadApplicationToken).not.toHaveBeenCalled()
    expect(d.setSystemUserId).toHaveBeenCalledWith('M', 512)
  })

  it('отложенная заявка: отпечаток совпал с токеном установки — пишем', async () => {
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
    // повторяет, так что отказ здесь терял бы служебного пользователя навсегда.
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

describe('elementResponsibleId — служебный пользователь, иначе установивший', () => {
  it('служебный пользователь известен — он, и портал не спрашиваем вовсе', async () => {
    const call = vi.fn(async () => ({ result: { ID: 1 } }))
    expect(await elementResponsibleId('M', call, { loadSystemUserId: async () => 512 })).toBe(512)
    expect(call).not.toHaveBeenCalled()
  })

  it('не известен — владелец сохранённого токена (profile → ID), один вызов на портал', async () => {
    const call = vi.fn(async () => ({ result: { ID: '7' } }))
    const load = { loadSystemUserId: async () => null }
    expect(await elementResponsibleId('M', call, load)).toBe(7)
    expect(await elementResponsibleId('M', call, load)).toBe(7)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('profile', {})
  })

  it('портал не назвал владельца — БРОСАЕТ, а не ставит элемент «на кого придётся»', async () => {
    const call = vi.fn(async () => ({ result: {} }))
    await expect(elementResponsibleId('M', call, { loadSystemUserId: async () => null }))
      .rejects.toThrow(/assignedById of a smart-process element/)
  })
})
