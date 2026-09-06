import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StatementItem } from '~/types/statement'

// Композабл «Последние операции» (#5/#36). Проверяем шов клиент↔сервер: вне фрейма инертен, в
// фрейме переносит operations/configured из ответа, отказ фиксирует в error (а не роняет витрину).

const op: StatementItem = {
  account: 'BY01ALFA', docId: 'D1', direction: 'credit', amount: 100, currency: 'BYN',
  purpose: 'оплата', acceptDate: '2026-08-21', counterparty: { name: 'A', unp: '', account: 'BY99' }
}

const frame = { value: { token: 'T', domain: 'd.bitrix24.by' } as { token: string, domain: string } | null }
vi.mock('~/composables/useFrameAuth', () => ({
  frameAuth: () => frame.value,
  frameAuthHeaders: () => ({ 'authorization': 'Bearer T', 'x-b24-domain': 'd.bitrix24.by' }),
  frameFetchError: (_e: unknown, f: string) => f
}))

const fetchMock = vi.fn(async (_url: string, _opts?: unknown): Promise<unknown> => ({ operations: [op], configured: true }))
vi.stubGlobal('$fetch', fetchMock)

afterEach(() => {
  frame.value = { token: 'T', domain: 'd.bitrix24.by' }
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ operations: [op], configured: true })
})

async function subject() {
  const { useRecentOperations } = await import('~/composables/useRecentOperations')
  return useRecentOperations()
}

describe('useRecentOperations', () => {
  it('вне фрейма — пусто и инертно, запрос не уходит', async () => {
    frame.value = null
    const s = await subject()
    await s.load()
    expect(s.operations.value).toEqual([])
    expect(s.loaded.value).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('в фрейме переносит operations и configured из ответа', async () => {
    const s = await subject()
    await s.load()
    // ⚠ Границы периода проверяем ЯВНО: с `expect.anything()` мутация «убрать query из $fetch»
    // проходила зелёной, то есть цепочка «UI → query → роут» не была пришпилена нигде (#42).
    expect(fetchMock).toHaveBeenCalledWith('/api/import/operations', expect.objectContaining({
      query: { from: '', to: '' }
    }))
    expect(s.operations.value).toEqual([op])
    expect(s.configured.value).toBe(true)
  })

  it('configured=false, когда СП не создан', async () => {
    fetchMock.mockResolvedValue({ operations: [], configured: false })
    const s = await subject()
    await s.load()
    expect(s.operations.value).toEqual([])
    expect(s.configured.value).toBe(false)
  })

  it('отказ запроса фиксируется в error, витрина не падает', async () => {
    fetchMock.mockRejectedValue(new Error('нет сети'))
    const s = await subject()
    await s.load()
    expect(s.error.value).not.toBe('')
    expect(s.operations.value).toEqual([]) // остаётся пустым, а не бросает
    expect(s.loaded.value).toBe(true)
  })
})

// ── Период (#42) ────────────────────────────────────────────────────────────────────────────────
describe('useRecentOperations: период', () => {
  it('границы периода доезжают до роута строкой запроса', async () => {
    const s = await subject()
    await s.load({ from: '2026-08-01', to: '2026-08-31' })
    expect(fetchMock).toHaveBeenCalledWith('/api/import/operations', expect.objectContaining({
      query: { from: '2026-08-01', to: '2026-08-31' }
    }))
  })

  it('total и truncated переносятся из ответа', async () => {
    fetchMock.mockResolvedValue({ operations: [op], configured: true, total: 137, truncated: true })
    const s = await subject()
    await s.load()
    expect(s.total.value).toBe(137)
    expect(s.truncated.value).toBe(true)
  })

  // ⚠ Отказ ОЧИЩАЕТ список. Оставленные операции прежнего периода под новой подписью читались бы
  // как данные: «за сегодня 50 платежей» вместо «мы не смогли спросить».
  it('отказ очищает список и счётчики — они относились к другому периоду', async () => {
    const s = await subject()
    await s.load({ from: '2026-08-01', to: '2026-08-31' })
    expect(s.operations.value).toEqual([op])
    fetchMock.mockRejectedValue(new Error('нет сети'))
    await s.load({ from: '2026-08-26', to: '2026-08-26' })
    expect(s.operations.value).toEqual([])
    expect(s.total.value).toBeNull()
    expect(s.truncated.value).toBe(false)
    expect(s.error.value).not.toBe('')
  })

  // ⚠ Гонка: период переключают кликами, и медленный ответ ПРЕДЫДУЩЕГО приходил бы после быстрого,
  // оставляя список одного срока под подписью другого.
  it('поздний ответ прошлого периода не затирает свежий', async () => {
    let releaseSlow: (v: unknown) => void = () => {}
    const slow = new Promise((res) => {
      releaseSlow = res
    })
    const oldOp = { ...op, docId: 'СТАРЫЙ' }
    fetchMock.mockImplementationOnce(async () => await slow)
    fetchMock.mockImplementationOnce(async () => ({ operations: [op], configured: true, total: 1 }))

    const s = await subject()
    const first = s.load({ from: '2025-01-01', to: '2025-12-31' })
    const second = s.load({ from: '2026-08-26', to: '2026-08-26' })
    await second
    releaseSlow({ operations: [oldOp], configured: true, total: 999, truncated: true })
    await first

    expect(s.operations.value).toEqual([op])
    expect(s.total.value).toBe(1)
    expect(s.truncated.value).toBe(false)
  })
})
