import { describe, expect, it, vi } from 'vitest'
import { handleActivityBindJob, handleRegistryWriteJob } from '../server/utils/deferredWriteJobs'
import type { ActivityBindJob, RegistryWriteJob } from '../server/queue/topology'
import type { StatementItem } from '../app/types/statement'

// Долговременная дозапись в CRM (#578 реестр / #585 привязки).
//
// ⚠ Единственный способ, которым эти воркеры могут «сломаться незаметно», — тихо отчитаться об
// успехе: очередь опустеет, счётчик потерь не вырастет, а колонок и связей в CRM клиента не
// появится. Поэтому проверяется НЕ «не упало», а что каждый неуспех превращается в бросок.

const ITEM: StatementItem = {
  account: 'BY00OUR',
  docId: 'op-1',
  direction: 'credit',
  amount: 100,
  currency: 'BYN',
  purpose: 'оплата',
  counterparty: { name: 'ООО Тест', unp: '000000000', account: 'BY00CPTY', bank: 'Банк' },
  acceptDate: '2026-08-22T00:00:00+03:00'
}

const REGISTRY_JOB: RegistryWriteJob = {
  memberId: 'M1',
  providerId: 'alfa-by',
  item: ITEM,
  companyId: '7',
  paymentSp: { entityTypeId: 1044, id: 44 }
}

describe('дозапись элемента реестра (#578)', () => {
  it('зовёт того же писателя, что и синхронный путь, с теми же аргументами', async () => {
    // ⚠ Тот же писатель — не мелочь: он дописывает колонки элементу, который НАШЁЛ. К моменту
    // повтора элемент мог быть создан голым (разнесением или упавшим прогоном), и другой,
    // «упрощённый» путь записи молча не сделал бы ничего.
    const call = { tag: 'rest' } as never
    const writePaymentRegistry = vi.fn(async () => '101')
    await handleRegistryWriteJob(REGISTRY_JOB, { resolvePortalCall: async () => call, writePaymentRegistry })
    expect(writePaymentRegistry).toHaveBeenCalledWith(ITEM, '7', 'alfa-by', REGISTRY_JOB.paymentSp, call)
  })

  it('нет токена портала — БРОСАЕТ, а не «успех»', async () => {
    // Приложение могли удалить: тогда попытки честно закончатся (их число ограничено). Тихий
    // выход означал бы очередь, которая всегда успешна и ничего не чинит.
    await expect(handleRegistryWriteJob(REGISTRY_JOB, {
      resolvePortalCall: async () => null,
      writePaymentRegistry: vi.fn()
    })).rejects.toThrow(/no portal token/)
  })

  it('отказ писателя пробрасывается — BullMQ повторит', async () => {
    await expect(handleRegistryWriteJob(REGISTRY_JOB, {
      resolvePortalCall: async () => ({} as never),
      writePaymentRegistry: async () => {
        throw new Error('портал молчит')
      }
    })).rejects.toThrow('портал молчит')
  })
})

const BIND_JOB: ActivityBindJob = {
  memberId: 'M1',
  activityId: '2087',
  refs: [{ entityTypeId: 1044, entityId: 101 }, { entityTypeId: 4, entityId: 9 }]
}

describe('дозапись привязок дела (#585)', () => {
  it('ставит привязки БЕЗ батча', async () => {
    // ⚠ Батч halt-on-error, а сюда мы приходим ровно тогда, когда часть пар уже могла встать:
    // первая же «уже привязано» уронила бы весь батч, и транспорт всё равно свалился бы на
    // поштучный путь — то есть лишний вызов на каждой попытке.
    const seen: unknown[] = []
    const bindActivity = vi.fn(async (...args: unknown[]) => {
      seen.push(args)
      return { bound: 2, failed: 0 }
    })
    await handleActivityBindJob(BIND_JOB, {
      resolvePortalCall: async () => ({} as never),
      bindActivity: bindActivity as never
    })
    expect(bindActivity).toHaveBeenCalledTimes(1)
    expect((seen[0] as unknown[])[3], 'воркеру передали батч').toBeUndefined()
  })

  it('часть пар не встала — БРОСАЕТ, чтобы попробовать снова', async () => {
    await expect(handleActivityBindJob(BIND_JOB, {
      resolvePortalCall: async () => ({} as never),
      bindActivity: async () => ({ bound: 1, failed: 1 })
    })).rejects.toThrow(/not bound/)
  })

  it('нет токена портала — БРОСАЕТ', async () => {
    await expect(handleActivityBindJob(BIND_JOB, {
      resolvePortalCall: async () => null,
      bindActivity: vi.fn()
    })).rejects.toThrow(/no portal token/)
  })

  it('пустой список ссылок завершается тихо и без вызовов', async () => {
    // Это не сбой, а задача, которой нечего делать. Бросок копил бы вечные падения на пустоте.
    const bindActivity = vi.fn()
    const resolvePortalCall = vi.fn()
    await expect(handleActivityBindJob({ ...BIND_JOB, refs: [] }, { resolvePortalCall, bindActivity }))
      .resolves.toBeUndefined()
    expect(resolvePortalCall).not.toHaveBeenCalled()
    expect(bindActivity).not.toHaveBeenCalled()
  })
})
