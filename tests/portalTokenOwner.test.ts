import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetTokenOwner, resetTokenOwnerCache, tokenOwnerId } from '../server/utils/portalTokenOwner'

// «Человек, который всё установил» — владелец сохранённого токена портала. Один кэш на оба запасных
// пути (системное дело и элементы смарт-процессов), иначе портал спрашивали бы дважды о том же.

afterEach(() => resetTokenOwnerCache())

describe('tokenOwnerId', () => {
  it('берёт ID из profile и помнит его по порталу', async () => {
    const call = vi.fn(async () => ({ result: { ID: '15' } }))
    expect(await tokenOwnerId(call, 'M', 'x')).toBe(15)
    expect(await tokenOwnerId(call, 'M', 'y')).toBe(15)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('кэш — по порталу: чужой портал спрашивается отдельно', async () => {
    const call = vi.fn(async () => ({ result: { ID: '15' } }))
    await tokenOwnerId(call, 'M1', 'x')
    await tokenOwnerId(call, 'M2', 'x')
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('без портала не кэширует — иначе один ответ достался бы всем', async () => {
    const call = vi.fn(async () => ({ result: { ID: '15' } }))
    await tokenOwnerId(call, undefined, 'x')
    await tokenOwnerId(call, undefined, 'x')
    expect(call).toHaveBeenCalledTimes(2)
  })

  it.each([[{}], [{ ID: '0' }], [{ ID: '0x11' }], [{ ID: true }]])('не id — отказ, в тексте назван путь: %j', async (result) => {
    const call = vi.fn(async () => ({ result }))
    await expect(tokenOwnerId(call, 'M', 'RESPONSIBLE_ID for crm.activity.add')).rejects.toThrow(/RESPONSIBLE_ID for crm\.activity\.add/)
  })

  it('отказ портала пробрасывается и не кэшируется', async () => {
    let n = 0
    const call = vi.fn(async () => {
      n++
      if (n === 1) throw new Error('timeout')
      return { result: { ID: '9' } }
    })
    await expect(tokenOwnerId(call, 'M', 'x')).rejects.toThrow('timeout')
    expect(await tokenOwnerId(call, 'M', 'x')).toBe(9)
  })

  it('forgetTokenOwner: после переустановки другим администратором спрашиваем заново', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ result: { ID: '15' } })
      .mockResolvedValueOnce({ result: { ID: '16' } })
    expect(await tokenOwnerId(call, 'M', 'x')).toBe(15)
    forgetTokenOwner('M')
    expect(await tokenOwnerId(call, 'M', 'x')).toBe(16)
  })
})
