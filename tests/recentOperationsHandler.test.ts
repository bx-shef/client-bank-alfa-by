import { describe, expect, it } from 'vitest'
import { handleRecentOperations, type RecentOperationsDeps } from '../server/utils/recentOperationsHandler'
import type { StatementItem } from '../app/types/statement'

// Хендлер GET /api/import/operations (#5/#36). Та же модель авторизации, что у /api/import/status:
// портал по домену → фрейм-токен валиден для ЭТОГО домена → отдаём операции. НЕ admin (витрина).

const op: StatementItem = {
  account: 'BY01ALFA', docId: 'D1', direction: 'credit', amount: 100, currency: 'BYN',
  purpose: 'оплата', acceptDate: '2026-08-21', counterparty: { name: 'A', unp: '', account: 'BY99' }
}

function deps(over: Partial<RecentOperationsDeps> = {}): RecentOperationsDeps {
  return {
    memberIdByDomain: async () => 'M1',
    validateFrame: async () => '7',
    loadOperations: async () => ({ operations: [op], total: 1 }),
    ...over
  }
}

const input = { accessToken: 't', domain: 'p.bitrix24.by', range: { from: '', to: '' } }

describe('handleRecentOperations', () => {
  it('200 с операциями и configured=true', async () => {
    const res = await handleRecentOperations(deps(), input)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ operations: [op], configured: true, total: 1 })
  })

  it('СП не создан (loadOperations=null) → 200, пусто, configured=false', async () => {
    const res = await handleRecentOperations(deps({ loadOperations: async () => null }), input)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ operations: [], configured: false, total: 0 })
  })

  it('401 без токена/домена', async () => {
    expect((await handleRecentOperations(deps(), { ...input, accessToken: '', domain: '' })).status).toBe(401)
  })

  it('409 если портал не установлен', async () => {
    expect((await handleRecentOperations(deps({ memberIdByDomain: async () => null }), input)).status).toBe(409)
  })

  it('403 при отвергнутом/чужом фрейм-токене (бросок или пустой userId)', async () => {
    const thrown = deps({ validateFrame: async () => {
      throw new Error('nope')
    } })
    expect((await handleRecentOperations(thrown, input)).status).toBe(403)
    const empty = deps({ validateFrame: async () => '' })
    expect((await handleRecentOperations(empty, input)).status).toBe(403)
  })

  it('НЕ читает операции, пока токен не подтверждён (порядок гейтов)', async () => {
    let touched = false
    const d = deps({
      validateFrame: async () => { throw new Error('bad') },
      loadOperations: async () => {
        touched = true
        return { operations: [op], total: 1 }
      }
    })
    await handleRecentOperations(d, input)
    expect(touched).toBe(false)
  })
})

// ── Период (#42) ────────────────────────────────────────────────────────────────────────────────
describe('handleRecentOperations: период', () => {
  it('диапазон доезжает до чтения реестра', async () => {
    let seen = { from: '', to: '' }
    const d = deps({
      loadOperations: async (_m, range) => {
        seen = range
        return { operations: [], total: 0 }
      }
    })
    await handleRecentOperations(d, { ...input, range: { from: '2026-08-01', to: '2026-08-31' } })
    expect(seen).toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  // ⚠ Кривая граница ОТКАЗЫВАЕТ, а не отбрасывается: молча отброшенное условие РАСШИРЯЕТ период,
  // и человек увидел бы чужой срок под подписью своего. Проверяем ещё и что до реестра не дошли.
  it('400 на несуществующий день, реестр не читается', async () => {
    let called = false
    const d = deps({
      loadOperations: async () => {
        called = true
        return { operations: [], total: 0 }
      }
    })
    const res = await handleRecentOperations(d, { ...input, range: { from: '2026-02-31', to: '' } })
    expect(res.status).toBe(400)
    expect(called).toBe(false)
  })

  it('400 на перевёрнутый период', async () => {
    const res = await handleRecentOperations(deps(), { ...input, range: { from: '2026-08-31', to: '2026-08-01' } })
    expect(res.status).toBe(400)
  })

  // `total` больше длины списка — портал отдал только первую страницу; витрина обязана это знать,
  // иначе сводка над списком выдаёт обрезок за весь период.
  it('total пробрасывается как есть, включая null', async () => {
    const many = await handleRecentOperations(deps({ loadOperations: async () => ({ operations: [op], total: 120 }) }), input)
    expect((many.body as { total: number | null }).total).toBe(120)
    const unknown = await handleRecentOperations(deps({ loadOperations: async () => ({ operations: [op], total: null }) }), input)
    expect((unknown.body as { total: number | null }).total).toBeNull()
  })
})
