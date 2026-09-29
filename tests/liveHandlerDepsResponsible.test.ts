import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import type { HandlerDeps } from '../server/queue/handlers'
import { PortalRestError } from '../server/utils/portalError'

// Проводка ответственного в НАСТОЯЩЕМ `liveHandlerDeps` (решение владельца 2026-09-29) — находка QA
// панели #780. Обработчик и транспорт покрыты своими тестами, а шов между ними — нет: не передай
// воркер `responsibleId` дальше или перепутай он аргументы (обе строки — `string`, `tsc` молчит),
// правка молча превратилась бы в ничто, и дела снова ложились бы на владельца токена. Мешала база:
// без неё настоящий резолвер портала бросает. Поэтому подменяется РЕЗОЛВЕР, а не транспорт.
// Отдельный файл — чтобы подмена не задела `liveHandlerDeps.test.ts` с настоящим воркером.

const h = vi.hoisted(() => {
  const sent: Array<{ method: string, params: Record<string, unknown> }> = []
  const call = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    sent.push({ method, params })
    if (method === 'crm.item.get' && params.id === 13) throw new Error('QUERY_LIMIT_EXCEEDED')
    if (method === 'crm.item.get' && params.id === 14) throw new PortalRestError('Access denied', 'ACCESS_DENIED', method)
    if (method === 'crm.item.get') return { result: { item: { id: params.id, assignedById: 17 } } }
    if (method === 'crm.activity.todo.add') return { result: { id: 900 } }
    if (method === 'crm.activity.list') return { result: [{ ID: 900 }] }
    if (method === 'crm.currency.list') return { result: [] }
    return { result: true }
  }
  const resolver = Object.assign(
    async (memberId: string) => (memberId === 'NO-TOKEN' ? null : call),
    { evict: () => {}, batch: async () => null }
  )
  return { sent, resolver }
})

vi.mock('../server/utils/portalSdkResolver', async orig => ({
  ...(await orig<typeof import('../server/utils/portalSdkResolver')>()),
  createPortalSdkResolver: () => h.resolver
}))

let deps: HandlerDeps
beforeAll(async () => {
  deps = (await import('../server/queue/worker')).liveHandlerDeps()
})

const REAL: StatementItem = {
  account: 'BY00REAL0000000000000000001', docId: 'D1', direction: 'credit', amount: 100, currency: 'BYN',
  purpose: 'тест', counterparty: { name: 'X', unp: '', account: 'BY00X' }, acceptDate: '2026-07-16'
}

describe('проводка ответственного в liveHandlerDeps', () => {
  it('findCompanyResponsible спрашивает crm.item.get ПО ID КОМПАНИИ, а не по memberId', async () => {
    h.sent.length = 0
    expect(await deps.findCompanyResponsible(REAL, '42', 'M1')).toBe(17)
    expect(h.sent.map(s => [s.method, s.params.id])).toEqual([['crm.item.get', 42]])
  })

  it('нет токена портала ⇒ null и ни одного вызова', async () => {
    h.sent.length = 0
    expect(await deps.findCompanyResponsible(REAL, '42', 'NO-TOKEN')).toBeNull()
    expect(h.sent).toEqual([])
  })

  it('временный сбой ПРОБРАСЫВАЕТСЯ — повтор джобы, а не дело «на кого придётся»', async () => {
    await expect(deps.findCompanyResponsible(REAL, '13', 'M1')).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })

  it('постоянный отказ портала ⇒ null: пачка не встаёт из-за одной компании', async () => {
    await expect(deps.findCompanyResponsible(REAL, '14', 'M1')).resolves.toBeNull()
  })

  it('writeActivity доносит responsibleId до todo.add', async () => {
    h.sent.length = 0
    await deps.writeActivity(REAL, '42', 'M1', undefined, 'alfa-by', 17)
    const add = h.sent.find(s => s.method === 'crm.activity.todo.add')
    expect(add?.params.responsibleId).toBe(17)
  })

  it('writeActivity без ответственного шлёт todo.add без responsibleId', async () => {
    h.sent.length = 0
    await deps.writeActivity({ ...REAL, docId: 'D2' }, '42', 'M1', undefined, 'alfa-by')
    const add = h.sent.find(s => s.method === 'crm.activity.todo.add')
    expect(add && 'responsibleId' in add.params).toBe(false)
  })
})
