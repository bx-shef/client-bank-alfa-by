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
    loadOperations: async () => [op],
    ...over
  }
}

const input = { accessToken: 't', domain: 'p.bitrix24.by' }

describe('handleRecentOperations', () => {
  it('200 с операциями и configured=true', async () => {
    const res = await handleRecentOperations(deps(), input)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ operations: [op], configured: true })
  })

  it('СП не создан (loadOperations=null) → 200, пусто, configured=false', async () => {
    const res = await handleRecentOperations(deps({ loadOperations: async () => null }), input)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ operations: [], configured: false })
  })

  it('401 без токена/домена', async () => {
    expect((await handleRecentOperations(deps(), { accessToken: '', domain: '' })).status).toBe(401)
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
        return [op]
      }
    })
    await handleRecentOperations(d, input)
    expect(touched).toBe(false)
  })
})
