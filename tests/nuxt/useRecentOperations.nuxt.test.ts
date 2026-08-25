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

const fetchMock = vi.fn(async () => ({ operations: [op], configured: true }))
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
    expect(fetchMock).toHaveBeenCalledWith('/api/import/operations', expect.anything())
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
