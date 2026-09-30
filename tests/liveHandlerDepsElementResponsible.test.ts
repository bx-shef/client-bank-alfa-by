import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import type { AllocationCandidate } from '../app/utils/allocation'
import type { HandlerDeps } from '../server/queue/handlers'
import { handleRegistryWriteJob, type RegistryWriteJobDeps } from '../server/utils/deferredWriteJobs'
import { resetSystemUserRefusals } from '../server/utils/systemUser'
import { applicationTokenHash } from '../server/utils/appTokenHash'

// Ответственный элементов смарт-процессов в НАСТОЯЩЕМ воркере (решение владельца 2026-09-29):
// служебный пользователь приложения, а где его нет — установивший, то есть поле НЕ передаём
// (умолчание `crm.item.add` — вызывающий, а вызываем мы его токеном). Писатели и выбор покрыты своими
// тестами; здесь — шов между ними. Все четыре пути создания элемента (реестр, дозапись истории,
// разнесение, отметка триггера) и отложенная дозапись обязаны спрашивать ОДНОГО и того же
// ответственного: разойдись они — элементы одного портала лежали бы на разных людях в зависимости
// от того, каким путём записались. Подменяются резолвер портала и хранилище (без базы), не писатели.

const h = vi.hoisted(() => {
  const flags = { foundExisting: false }
  const sent: Array<{ method: string, params: Record<string, unknown> }> = []
  const call = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    sent.push({ method, params })
    if (method === 'crm.item.list') return { result: { items: flags.foundExisting ? [{ id: 42 }] : [] } }
    if (method === 'crm.item.add') return { result: { item: { id: 700 } } }
    return { result: { item: {} } }
  }
  const resolver = Object.assign(async () => call, { evict: () => {}, batch: async () => null })
  // Токены приложения — ПО ПОРТАЛУ: фейк, отдающий один токен на любой member_id, не заметил бы
  // сверку не с тем порталом (находка QA-ревью #783).
  const store = { tokens: {} as Record<string, string>, written: [] as Array<[string, number]>, reads: [] as string[] }
  const captured: { processor?: (job: unknown) => Promise<unknown> } = {}
  return { sent, resolver, store, flags, captured }
})

vi.mock('../server/utils/portalSdkResolver', async orig => ({
  ...(await orig<typeof import('../server/utils/portalSdkResolver')>()),
  createPortalSdkResolver: () => h.resolver
}))

vi.mock('../server/utils/tokenStore', async orig => ({
  ...(await orig<typeof import('../server/utils/tokenStore')>()),
  // Портал 'SYS' прислал служебного пользователя 512, остальные — нет.
  getSystemUserId: async (_q: unknown, memberId: string) => {
    h.store.reads.push(memberId)
    return memberId === 'SYS' ? 512 : null
  },
  getApplicationToken: async (_q: unknown, memberId: string) => h.store.tokens[memberId] ?? '',
  setSystemUserId: async (_q: unknown, memberId: string, userId: number) => {
    h.store.written.push([memberId, userId])
    return true
  }
}))

// Обработчик событий — настоящий, BullMQ — нет: ловим сам процессор, который воркер отдал бы очереди.
vi.mock('bullmq', async orig => ({
  ...(await orig<typeof import('bullmq')>()),
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      h.captured.processor = processor
    }

    on() {
      return this
    }
  }
}))

let worker: typeof import('../server/queue/worker')
let deps: HandlerDeps
let registry: RegistryWriteJobDeps
// ⚠ Срок 60 с, а не умолчание проекта unit в 10: импорт графа воркера под нагрузкой занимает секунды,
// и умолчание давало ложное «Hook timed out» (замер QA-ревью #783; у проекта nuxt срок поднят так же).
beforeAll(async () => {
  worker = await import('../server/queue/worker')
  deps = worker.liveHandlerDeps()
  registry = worker.liveRegistryWriteDeps()
}, 60_000)
beforeEach(() => {
  h.sent.length = 0
  h.store.written.length = 0
  h.store.reads.length = 0
  h.store.tokens = {}
  resetSystemUserRefusals()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const ITEM: StatementItem = {
  account: 'BY00REAL0000000000000000001', docId: 'D1', direction: 'credit', amount: 100, currency: 'BYN',
  purpose: 'тест', counterparty: { name: 'X', unp: '', account: 'BY00X' }, acceptDate: '2026-07-16'
}
const SPS = { paymentSp: { entityTypeId: 1044, id: 44 }, distributionSp: { entityTypeId: 1046, id: 46 } }
const INVOICE: AllocationCandidate = { kind: 'invoice', id: '39', amount: 100, currency: 'BYN' }
const DEAL: AllocationCandidate = { kind: 'deal', id: '77', amount: 0, currency: 'BYN' }
const addFields = () => h.sent.filter(s => s.method === 'crm.item.add').map(s => s.params.fields as Record<string, unknown>)
const responsibles = () => addFields().map(f => f.assignedById)

describe('ответственный новых элементов в liveHandlerDeps', () => {
  it('служебный пользователь известен — на него все четыре пути', async () => {
    await deps.writePaymentRegistry!(ITEM, null, 'SYS', 'alfa-by', SPS.paymentSp)
    await deps.backfillRegistry!({ ...ITEM, docId: 'D2' }, null, 'SYS', 'alfa-by', SPS.paymentSp)
    await deps.writeLedger!({ ...ITEM, docId: 'D3' }, INVOICE, '12', 'SYS', SPS)
    await deps.writeTriggerFact!({ ...ITEM, docId: 'D4' }, DEAL, '12', 'SYS', SPS)
    // реестр 1 + дозапись 1 + разнесение 2 (элемент + строка) + триггер 2
    expect(responsibles()).toEqual([512, 512, 512, 512, 512, 512])
  })

  it('служебного пользователя нет — поле НЕ передаём (портал ставит вызывающего, то есть установившего), лишних вызовов нет', async () => {
    await deps.writePaymentRegistry!(ITEM, null, 'NOSYS', 'alfa-by', SPS.paymentSp)
    await deps.writeLedger!({ ...ITEM, docId: 'D3' }, INVOICE, '12', 'NOSYS', SPS)
    expect(addFields()).toHaveLength(3)
    expect(addFields().every(f => !('assignedById' in f))).toBe(true)
    // «Установивший» — умолчание портала, а не наш запрос: ни profile, ни иного вызова ради него.
    expect(h.sent.map(s => s.method).filter(m => m !== 'crm.item.list' && m !== 'crm.item.add' && m !== 'crm.item.update')).toEqual([])
  })

  it('отложенная дозапись реестра спрашивает того же ответственного', async () => {
    expect(await registry.withResponsible('SYS', r => r())).toBe(512)
    expect(await registry.withResponsible('NOSYS', r => r())).toBeNull()
  })

  it('элемент уже есть — ответственного не спрашиваем вовсе (базу не читаем)', async () => {
    h.flags.foundExisting = true
    try {
      await deps.writePaymentRegistry!(ITEM, null, 'NOSYS', 'alfa-by', SPS.paymentSp)
    } finally {
      h.flags.foundExisting = false
    }
    expect(h.store.reads).toEqual([])
    expect(h.sent.some(s => s.method === 'crm.item.add')).toBe(false)
  })
})

describe('запись служебного пользователя в liveHandlerDeps', () => {
  it('заявка сверяется с токеном из базы и пишется', async () => {
    h.store.tokens.M = 'app-token'
    expect(await deps.saveSystemUser({ memberId: 'M', userId: 512, appTokenHash: applicationTokenHash('app-token') }, { finalAttempt: false })).toBe('saved')
    expect(h.store.written).toEqual([['M', 512]])
  })

  it('сверка — с токеном ИМЕННО портала заявки: у чужого портала токена нет, и заявка ждёт установку', async () => {
    h.store.tokens.M = 'app-token'
    const claim = { memberId: 'OTHER', userId: 512, appTokenHash: applicationTokenHash('app-token') }
    await expect(deps.saveSystemUser(claim, { finalAttempt: false })).rejects.toThrow(/ещё не записана/)
    expect(h.store.written).toEqual([])
  })

  it('установки ещё нет — повтор, а на последней попытке тихий отказ; в базу ничего', async () => {
    const claim = { memberId: 'M', userId: 512, appTokenHash: 'deadbeef' }
    await expect(deps.saveSystemUser(claim, { finalAttempt: false })).rejects.toThrow(/ещё не записана/)
    expect(await deps.saveSystemUser(claim, { finalAttempt: true })).toBe('expired')
    expect(h.store.written).toEqual([])
  })
})

describe('обработчик событий и отложенная дозапись — настоящая проводка воркера', () => {
  it('признак последней попытки берётся из самой задачи: на ней заявка отказывает тихо, а не падает', async () => {
    // Без признака исчерпанная задача легла бы в счёт падений очереди и будила бы оператора.
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379') // процессор не ходит в Redis — адрес нужен конструктору
    const saveSystemUser = vi.fn(async () => 'saved' as const)
    worker.startEventWorker({ ...deps, saveSystemUser })
    const job = (attemptsMade: number) => ({
      data: { memberId: 'M', domain: 'd', kind: 'ONAPPUSERREADY', ts: '1', systemUser: { userId: 7, appTokenHash: 'h' } },
      attemptsMade,
      opts: { attempts: 6 }
    })
    await h.captured.processor!(job(5))
    await h.captured.processor!(job(0))
    expect(saveSystemUser.mock.calls.map(c => (c as unknown[])[1])).toEqual([{ finalAttempt: true }, { finalAttempt: false }])
  })

  it('отложенная дозапись реестра целиком, от задачи до портала, кладёт новый элемент на служебного пользователя', async () => {
    await handleRegistryWriteJob({
      memberId: 'SYS', companyId: null, providerId: 'alfa-by', item: ITEM, paymentSp: SPS.paymentSp
    }, registry)
    expect(responsibles()).toEqual([512])
  })
})
