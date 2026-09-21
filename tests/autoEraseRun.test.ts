import { describe, expect, it, vi } from 'vitest'
import { runAutoErase, type AutoEraseDeps, type AutoEraseVerdict } from '../server/utils/autoEraseRun'
import { MAX_AUTO_ERASE_PORTALS } from '../app/utils/autoEraseActivities'

// Прогон автоудаления по флоту (#722).
//
// ⚠ Половина ценности прогона — в том, чего он НЕ делает: не удаляет у портала, чью настройку не
// смог прочитать, и не бросает обработку флота из-за одного упавшего портала. Оба свойства
// невидимы в «happy path» и проверяются здесь явно.

const NOW = Date.parse('2026-09-16T12:00:00Z')

function deps(over: Partial<AutoEraseDeps> = {}): AutoEraseDeps {
  return {
    now: () => NOW,
    listCandidates: async () => ['M1'],
    isEnabled: async () => 'on' as AutoEraseVerdict,
    erase: async () => ({ deleted: 0, remaining: 0 }),
    ...over
  }
}

describe('runAutoErase', () => {
  it('порталы без импорта до портала вообще не доходят', async () => {
    // Кандидатов даёт НАША база; портал, который ничего не импортировал, не стоит ни одного
    // вызова — ради этого выборка и существует.
    const isEnabled = vi.fn(async () => 'on' as AutoEraseVerdict)
    const f = await runAutoErase(deps({ listCandidates: async () => [], isEnabled }), 3)
    expect(isEnabled).not.toHaveBeenCalled()
    expect(f.considered).toBe(0)
  })

  it('выключенный портал стоит РОВНО одного вызова — списка дел у него не спрашивают', async () => {
    const erase = vi.fn(async () => ({ deleted: 0, remaining: 0 }))
    const f = await runAutoErase(deps({ isEnabled: async () => 'off', erase }), 3)
    expect(erase).not.toHaveBeenCalled()
    expect(f.enabled).toBe(0)
  })

  it('НЕ СМОГЛИ ПРОЧИТАТЬ НАСТРОЙКУ ⇒ НЕ УДАЛЯЕМ', async () => {
    // ⚠ Главный инвариант модуля. «Портал не ответил» и «портал разрешил» обязаны различаться,
    // иначе мёртвый токен или кончившаяся подписка (#614) читались бы как согласие на
    // необратимое действие. Мутация «трактовать unknown как on» роняет этот тест.
    const erase = vi.fn(async () => ({ deleted: 5, remaining: 0 }))
    const f = await runAutoErase(deps({ isEnabled: async () => 'unknown', erase }), 3)
    expect(erase).not.toHaveBeenCalled()
    expect(f.unreadable).toBe(1)
    expect(f.deleted).toBe(0)
  })

  it('БРОСОК при чтении настройки — тоже «не знаем», а не «можно»', async () => {
    const erase = vi.fn(async () => ({ deleted: 5, remaining: 0 }))
    const f = await runAutoErase(deps({
      isEnabled: async () => { throw new Error('portal down') },
      erase
    }), 3)
    expect(erase).not.toHaveBeenCalled()
    expect(f.unreadable).toBe(1)
  })

  it('удаляет у согласившегося и называет портал отдельной строкой', async () => {
    const log: string[] = []
    const f = await runAutoErase(deps({
      erase: async () => ({ deleted: 12, remaining: 0 }),
      log: m => log.push(m)
    }), 3)
    expect(f.deleted).toBe(12)
    expect(f.touched).toBe(1)
    // Портал назван необратимой меткой, а не сырым member_id.
    expect(log.some(l => l.includes('удалено дел 12'))).toBe(true)
    expect(log.join('\n')).not.toContain('M1')
  })

  it('упавший портал не обрывает обход остальных', async () => {
    // ⚠ Изоляция пер-портальных отказов — то же правило, что у keep-alive и уборщиков: один
    // криво настроенный клиент не имеет права остановить работу по всему флоту.
    const erase = vi.fn(async (memberId: string) => {
      if (memberId === 'M2') throw new Error('boom')
      return { deleted: 1, remaining: 0 }
    })
    const f = await runAutoErase(deps({
      listCandidates: async () => ['M1', 'M2', 'M3'],
      erase
    }), 3)
    expect(erase).toHaveBeenCalledTimes(3)
    expect(f.deleted).toBe(2)
    expect(f.failed).toBe(1)
  })

  it('хвост у портала считается отдельно от удалённого', async () => {
    const f = await runAutoErase(deps({ erase: async () => ({ deleted: 300, remaining: 40 }) }), 3)
    expect(f.withRemainder).toBe(1)
  })

  it('флот больше потолка — обрабатываем часть и ГОВОРИМ об этом', async () => {
    const many = Array.from({ length: MAX_AUTO_ERASE_PORTALS + 5 }, (_, i) => `M${i}`)
    const erase = vi.fn(async () => ({ deleted: 1, remaining: 0 }))
    const f = await runAutoErase(deps({ listCandidates: async () => many, erase }), 3)
    expect(erase).toHaveBeenCalledTimes(MAX_AUTO_ERASE_PORTALS)
    expect(f.capped).toBe(true)
  })

  it('порог в итоге — выведенный из окна, а не зашитый', async () => {
    const wide = await runAutoErase(deps(), 10)
    expect(wide.thresholdDays).toBe(12)
    const narrow = await runAutoErase(deps(), 1)
    expect(narrow.thresholdDays).toBe(5)
  })

  it('граница, доезжающая до транспорта, посчитана от ОКНА, а не подставлена вызывающим', async () => {
    // Инвариант проводки: `erase` получает ту же границу, по которой считался порог. Разойдись
    // они — в логе стоял бы один срок, а удалялось бы по другому.
    const seen: string[] = []
    await runAutoErase(deps({
      erase: async (_m, cutoff) => {
        seen.push(cutoff.day)
        return { deleted: 0, remaining: 0 }
      }
    }), 10)
    expect(seen).toEqual(['2026-09-04']) // 16 − (10 + 2)
  })
})
