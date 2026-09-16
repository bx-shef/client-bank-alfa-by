import { describe, expect, it, vi } from 'vitest'
import { autoEraseForPortal } from '../server/utils/autoEraseWrite'
import { autoEraseCutoff } from '../app/utils/autoEraseActivities'
import { ACTIVITY_ORIGIN } from '../app/utils/activity'

// Транспорт автоудаления по одному порталу (#722).
//
// ⚠ Главное, что здесь проверяется, — что обход НЕ ЗАЦИКЛИВАЕТСЯ. Мы удаляем то, что прочитали,
// поэтому постраничное смещение уезжает под нами и обход построен на повторном чтении ПЕРВОЙ
// страницы. Такая форма даёт вечный цикл ровно в одном случае: портал отдаёт строки, которые наша
// вторая граница отбрасывает. Это не гипотеза — так ответил живой портал на неэкранированный
// фильтр даты.

const NOW = Date.parse('2026-09-16T12:00:00Z')
const CUTOFF = autoEraseCutoff(NOW, 3) // граница 2026-09-11

const OLD = '2026-09-01T10:00:00+03:00'
const FRESH = '2026-09-16T10:00:00+03:00'

function listResp(rows: { ID: string, CREATED: string, ORIGINATOR_ID?: string }[], total = rows.length) {
  return {
    result: rows.map(r => ({ ORIGINATOR_ID: ACTIVITY_ORIGIN, ...r })),
    total
  } as Record<string, unknown>
}

describe('autoEraseForPortal', () => {
  it('удаляет старые дела и спрашивает остаток у портала', async () => {
    const pages = [listResp([{ ID: '1', CREATED: OLD }, { ID: '2', CREATED: OLD }]), listResp([])]
    let i = 0
    const call = vi.fn(async () => pages[Math.min(i++, pages.length - 1)]!)
    const batch = vi.fn(async () => [])
    const res = await autoEraseForPortal(CUTOFF, call, batch)
    expect(res.deleted).toBe(2)
    expect(res.remaining).toBe(0)
    expect(batch).toHaveBeenCalledTimes(1)
  })

  it('перечитывает ПЕРВУЮ страницу, а не листает смещением', async () => {
    // ⚠ Несущее свойство: удалив первые 50 из 300, мы сдвигаем остаток на 50 назад, и `start=50`
    // пропустил бы ровно столько же строк. Мутация «листать по start» роняет этот тест.
    const pages = [
      listResp([{ ID: '1', CREATED: OLD }], 3),
      listResp([{ ID: '2', CREATED: OLD }], 2),
      listResp([], 0)
    ]
    let i = 0
    const call = vi.fn(async (_m: string, _p: Record<string, unknown>) => pages[Math.min(i++, pages.length - 1)]!)
    await autoEraseForPortal(CUTOFF, call, async () => [])
    const starts = call.mock.calls.map(c => (c[1] as { start?: number }).start)
    expect(starts.every(s => s === 0)).toBe(true)
  })

  it('НЕ ЗАЦИКЛИВАЕТСЯ, когда портал проигнорировал фильтр даты', async () => {
    // Портал отдаёт одни и те же свежие дела на каждый запрос. Без остановки на «нечего удалять»
    // это был бы бесконечный цикл; со второй границей — ноль удалений и выход.
    const call = vi.fn(async () => listResp([{ ID: '9', CREATED: FRESH }], 1))
    const batch = vi.fn(async () => [])
    const res = await autoEraseForPortal(CUTOFF, call, batch)
    expect(res.deleted).toBe(0)
    expect(batch).not.toHaveBeenCalled()
    // Один запрос списка + один на остаток. Не десятки, не бесконечность.
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('чужие дела не удаляются, даже если портал вернул их в нашей выборке', async () => {
    const call = vi.fn(async () => listResp([
      { ID: '1', CREATED: OLD, ORIGINATOR_ID: 'CRM_OTHER_APP' },
      { ID: '2', CREATED: OLD, ORIGINATOR_ID: 'CRM_OTHER_APP' }
    ], 2))
    const batch = vi.fn(async () => [])
    const res = await autoEraseForPortal(CUTOFF, call, batch)
    expect(batch).not.toHaveBeenCalled()
    expect(res.deleted).toBe(0)
  })

  it('упирается в потолок и оставляет хвост следующему прогону', async () => {
    const page = listResp(Array.from({ length: 50 }, (_, n) => ({ ID: String(n + 1), CREATED: OLD })), 500)
    const call = vi.fn(async () => page)
    const batch = vi.fn(async () => [])
    const res = await autoEraseForPortal(CUTOFF, call, batch, 120)
    expect(res.deleted).toBe(120)
    expect(res.remaining).toBe(500)
  })

  it('упавший батч останавливает удаление, но итог берётся у портала', async () => {
    // ⚠ Внутри оборвавшегося чанка часть команд могла примениться — наша арифметика соврала бы
    // именно тогда, когда человеку важнее всего понимать, что произошло.
    const call = vi.fn(async (_m: string, p: Record<string, unknown>) =>
      (p.select as string[]).length === 1
        ? listResp([], 7)
        : listResp([{ ID: '1', CREATED: OLD }], 8))
    const batch = vi.fn(async () => {
      throw new Error('одно дело уже удалили руками')
    })
    const res = await autoEraseForPortal(CUTOFF, call, batch)
    expect(res.deleted).toBe(0)
    expect(res.remaining).toBe(7)
  })

  it('фильтр запроса всегда несёт наш ORIGINATOR_ID и границу по дате создания', async () => {
    // ⚠ Параметры у мока объявлены явно: без них `mock.calls[0]` — пустой кортеж, и проверка
    // того, ЧТО мы отправили в портал, не типизируется вовсе (тот же класс, из-за которого в
    // проект добавили третий проход typecheck).
    const call = vi.fn(async (_m: string, _p: Record<string, unknown>) => listResp([]))
    await autoEraseForPortal(CUTOFF, call, async () => [])
    const filter = (call.mock.calls[0]![1] as { filter: Record<string, unknown> }).filter
    expect(filter.ORIGINATOR_ID).toBe(ACTIVITY_ORIGIN)
    expect(filter['<=CREATED']).toBe('2026-09-11T00:00:00')
  })

  it('описание дела НЕ запрашивается — отбора по счетам здесь нет', async () => {
    // Описание объёмное (назначение, реквизиты); тащить его на каждый прогон по всему флоту
    // незачем. Отличие от ручной «Очистки», где оно нужно под фильтр по счёту контрагента.
    const call = vi.fn(async (_m: string, _p: Record<string, unknown>) => listResp([]))
    await autoEraseForPortal(CUTOFF, call, async () => [])
    const select = (call.mock.calls[0]![1] as { select: string[] }).select
    expect(select).not.toContain('DESCRIPTION')
  })
})
