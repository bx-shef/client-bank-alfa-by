import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import type { AllocationCandidate } from '../app/utils/allocation'
import type { HandlerDeps } from '../server/queue/handlers'
import type { RegistryWriteJobDeps } from '../server/utils/deferredWriteJobs'
import { resetTokenOwnerCache } from '../server/utils/portalTokenOwner'
import { applicationTokenHash, resetSystemUserRefusals } from '../server/utils/systemUser'

// Ответственный элементов смарт-процессов в НАСТОЯЩЕМ воркере (решение владельца 2026-09-29):
// служебный пользователь приложения, а где его нет — установивший. Писатели и выбор покрыты своими
// тестами; здесь — шов между ними. Все четыре пути создания элемента (реестр, дозапись истории,
// разнесение, отметка триггера) и отложенная дозапись обязаны спрашивать ОДНОГО и того же
// ответственного: разойдись они — элементы одного портала лежали бы на разных людях в зависимости
// от того, каким путём записались. Подменяются резолвер портала и хранилище (без базы), не писатели.

const h = vi.hoisted(() => {
  const flags = { foundExisting: false }
  const sent: Array<{ method: string, params: Record<string, unknown> }> = []
  const call = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    sent.push({ method, params })
    if (method === 'profile') return { result: { ID: '3' } }
    if (method === 'crm.item.list') return { result: { items: flags.foundExisting ? [{ id: 42 }] : [] } }
    if (method === 'crm.item.add') return { result: { item: { id: 700 } } }
    return { result: { item: {} } }
  }
  const resolver = Object.assign(async () => call, { evict: () => {}, batch: async () => null })
  const store = { stored: '', written: [] as Array<[string, number]> }
  return { sent, resolver, store, flags }
})

vi.mock('../server/utils/portalSdkResolver', async orig => ({
  ...(await orig<typeof import('../server/utils/portalSdkResolver')>()),
  createPortalSdkResolver: () => h.resolver
}))

vi.mock('../server/utils/tokenStore', async orig => ({
  ...(await orig<typeof import('../server/utils/tokenStore')>()),
  // Портал 'SYS' прислал служебного пользователя 512, остальные — нет.
  getSystemUserId: async (_q: unknown, memberId: string) => (memberId === 'SYS' ? 512 : null),
  getApplicationToken: async () => h.store.stored,
  setSystemUserId: async (_q: unknown, memberId: string, userId: number) => {
    h.store.written.push([memberId, userId])
    return true
  }
}))

let deps: HandlerDeps
let registry: RegistryWriteJobDeps
beforeAll(async () => {
  const worker = await import('../server/queue/worker')
  deps = worker.liveHandlerDeps()
  registry = worker.liveRegistryWriteDeps()
})
beforeEach(() => {
  h.sent.length = 0
  h.store.written.length = 0
  resetTokenOwnerCache()
  resetSystemUserRefusals()
})

const ITEM: StatementItem = {
  account: 'BY00REAL0000000000000000001', docId: 'D1', direction: 'credit', amount: 100, currency: 'BYN',
  purpose: 'тест', counterparty: { name: 'X', unp: '', account: 'BY00X' }, acceptDate: '2026-07-16'
}
const SPS = { paymentSp: { entityTypeId: 1044, id: 44 }, distributionSp: { entityTypeId: 1046, id: 46 } }
const INVOICE: AllocationCandidate = { kind: 'invoice', id: '39', amount: 100, currency: 'BYN' }
const DEAL: AllocationCandidate = { kind: 'deal', id: '77', amount: 0, currency: 'BYN' }
const responsibles = () => h.sent.filter(s => s.method === 'crm.item.add').map(s => (s.params.fields as Record<string, unknown>).assignedById)

describe('ответственный новых элементов в liveHandlerDeps', () => {
  it('служебный пользователь известен — на него все четыре пути, portal profile не спрашиваем', async () => {
    await deps.writePaymentRegistry!(ITEM, null, 'SYS', 'alfa-by', SPS.paymentSp)
    await deps.backfillRegistry!({ ...ITEM, docId: 'D2' }, null, 'SYS', 'alfa-by', SPS.paymentSp)
    await deps.writeLedger!({ ...ITEM, docId: 'D3' }, INVOICE, '12', 'SYS', SPS)
    await deps.writeTriggerFact!({ ...ITEM, docId: 'D4' }, DEAL, '12', 'SYS', SPS)
    // реестр 1 + дозапись 1 + разнесение 2 (элемент + строка) + триггер 2
    expect(responsibles()).toEqual([512, 512, 512, 512, 512, 512])
    expect(h.sent.some(s => s.method === 'profile')).toBe(false)
  })

  it('служебного пользователя нет — установивший (владелец токена), один profile на портал', async () => {
    await deps.writePaymentRegistry!(ITEM, null, 'NOSYS', 'alfa-by', SPS.paymentSp)
    await deps.writeLedger!({ ...ITEM, docId: 'D3' }, INVOICE, '12', 'NOSYS', SPS)
    expect(responsibles()).toEqual([3, 3, 3])
    expect(h.sent.filter(s => s.method === 'profile')).toHaveLength(1)
  })

  it('отложенная дозапись реестра спрашивает того же ответственного', async () => {
    const call = await h.resolver()
    expect(await registry.withResponsible('SYS', call, r => r())).toBe(512)
    expect(await registry.withResponsible('NOSYS', call, r => r())).toBe(3)
  })

  it('элемент уже есть — ответственного не спрашиваем вовсе (ни базы, ни profile)', async () => {
    h.flags.foundExisting = true
    try {
      await deps.writePaymentRegistry!(ITEM, null, 'NOSYS', 'alfa-by', SPS.paymentSp)
    } finally {
      h.flags.foundExisting = false
    }
    expect(h.sent.some(s => s.method === 'profile')).toBe(false)
    expect(h.sent.some(s => s.method === 'crm.item.add')).toBe(false)
  })
})

describe('запись служебного пользователя в liveHandlerDeps', () => {
  it('заявка сверяется с токеном из базы и пишется', async () => {
    h.store.stored = 'app-token'
    try {
      expect(await deps.saveSystemUser({ memberId: 'M', userId: 512, appTokenHash: applicationTokenHash('app-token') }, { finalAttempt: false })).toBe('saved')
    } finally {
      h.store.stored = ''
    }
    expect(h.store.written).toEqual([['M', 512]])
  })

  it('установки ещё нет — повтор, а на последней попытке тихий отказ; в базу ничего', async () => {
    h.store.stored = ''
    const claim = { memberId: 'M', userId: 512, appTokenHash: 'deadbeef' }
    await expect(deps.saveSystemUser(claim, { finalAttempt: false })).rejects.toThrow(/ещё не записана/)
    expect(await deps.saveSystemUser(claim, { finalAttempt: true })).toBe('expired')
    expect(h.store.written).toEqual([])
  })
})
