import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import {
  ACTIVITY_DELETE_METHOD, ACTIVITY_UPDATE_METHOD, TODO_ACTIVITY_ADD_METHOD
} from '../app/utils/todoActivity'
import { ACTIVITY_LIST_METHOD } from '../server/utils/activityMarkerLookup'
import { extractTodoActivityId, resetMarkerProof, writeTodoActivityViaRest } from '../server/utils/todoActivityWrite'

// Универсальное дело не принимает маркер в том же вызове, которым создаётся (#495) — маркер и
// тип описания живут только в `crm.activity.update`. Значит между вызовами есть окно, в котором
// дело существует БЕЗ маркера, а такое дело невидимо для дедупа навсегда: повтор заведёт второе,
// а первое останется висеть. Здесь закреплена компенсация — упавший update сносит сироту.

function item(over: Partial<StatementItem> = {}): StatementItem {
  return {
    account: 'A', docId: 'D1', direction: 'credit', amount: 10, currency: 'BYN',
    purpose: 'p', counterparty: { name: 'C', unp: '1', account: 'BY1' },
    acceptDate: '2026-08-15T00:00:00.000Z', ...over
  }
}

describe('extractTodoActivityId', () => {
  it('читает обе формы ответа портала', () => {
    // Ошибиться тут — тихо: null читается как «ничего не записано», маркер не ставится,
    // и каждый опрос создаёт дело заново.
    expect(extractTodoActivityId({ result: { id: 55 } })).toBe('55')
    expect(extractTodoActivityId({ result: 55 })).toBe('55')
  })

  it('нечисловой/пустой id — null, а не «успех»', () => {
    expect(extractTodoActivityId({ result: {} })).toBeNull()
    expect(extractTodoActivityId({ result: '' })).toBeNull()
    expect(extractTodoActivityId({ result: { id: 'abc' } })).toBeNull()
    expect(extractTodoActivityId({})).toBeNull()
  })
})

describe('writeTodoActivityViaRest', () => {
  it('создаёт дело и СРАЗУ ставит маркер — ровно два вызова', async () => {
    const calls: string[] = []
    const call = vi.fn(async (method: string) => {
      calls.push(method)
      return method === TODO_ACTIVITY_ADD_METHOD ? { result: { id: 7 } } : { result: true }
    })
    await expect(writeTodoActivityViaRest(item(), '42', call)).resolves.toBe('7')
    expect(calls).toEqual([TODO_ACTIVITY_ADD_METHOD, ACTIVITY_UPDATE_METHOD])
  })

  it('маркер ставится на СОЗДАННОЕ дело и несёт тип описания', async () => {
    const seen: Record<string, unknown>[] = []
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      seen.push({ method, params })
      return method === TODO_ACTIVITY_ADD_METHOD ? { result: { id: 9 } } : { result: true }
    })
    await writeTodoActivityViaRest(item(), '42', call)
    const update = seen[1] as { params: { id: number, fields: Record<string, unknown> } }
    expect(update.params.id).toBe(9)
    expect(update.params.fields).toMatchObject({ ORIGIN_ID: 'A|D1', DESCRIPTION_TYPE: 3 })
  })

  it('⚠ упавший update СНОСИТ сироту и пробрасывает ИСХОДНУЮ ошибку', async () => {
    // Дело без маркера хуже отсутствующего: дедуп его не найдёт никогда, и повтор задачи
    // положит рядом второе. Поэтому откатываем и падаем — BullMQ повторит с чистого места.
    const calls: string[] = []
    const call = vi.fn(async (method: string) => {
      calls.push(method)
      if (method === TODO_ACTIVITY_ADD_METHOD) return { result: { id: 11 } }
      if (method === ACTIVITY_UPDATE_METHOD) throw new Error('update boom')
      return { result: true }
    })
    await expect(writeTodoActivityViaRest(item(), '42', call)).rejects.toThrow('update boom')
    expect(calls).toEqual([TODO_ACTIVITY_ADD_METHOD, ACTIVITY_UPDATE_METHOD, ACTIVITY_DELETE_METHOD])
  })

  it('если и удаление не вышло — всё равно виден ИСХОДНЫЙ отказ, а сирота названа в логе', async () => {
    // Ошибка удаления не объясняет, что произошло; объясняет первая. Но про сироту сказать надо,
    // иначе дубль появится «сам по себе» через сутки.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const call = vi.fn(async (method: string) => {
      if (method === TODO_ACTIVITY_ADD_METHOD) return { result: { id: 12 } }
      throw new Error(method === ACTIVITY_UPDATE_METHOD ? 'update boom' : 'delete boom')
    })
    await expect(writeTodoActivityViaRest(item(), '42', call)).rejects.toThrow('update boom')
    expect(err.mock.calls.flat().join(' ')).toContain('12')
    err.mockRestore()
  })

  it('портал не вернул id → null и НИКАКИХ дальнейших вызовов', async () => {
    // Ставить маркер не на что, сносить нечего. Вызывающий посчитает операцию незаписанной
    // и повторит на следующем опросе — прежний контракт.
    const calls: string[] = []
    const call = vi.fn(async (method: string) => {
      calls.push(method)
      return { result: {} }
    })
    await expect(writeTodoActivityViaRest(item(), '42', call)).resolves.toBeNull()
    expect(calls).toEqual([TODO_ACTIVITY_ADD_METHOD])
  })

  it('отказ САМОГО создания пробрасывается без попытки чистки', async () => {
    const call = vi.fn(async () => {
      throw new Error('add boom')
    })
    await expect(writeTodoActivityViaRest(item(), '42', call)).rejects.toThrow('add boom')
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe('маркер проверяется на деле, а не на слово (#495)', () => {
  // Компенсирующее удаление закрывает update, который УПАЛ. Оно не закрывает update, который
  // отчитался успехом, а поле не поставил — и это отказ молчаливый, полный и неограниченный:
  // следующий прогон не найдёт маркер, и каждая операция будет записываться заново, каждый опрос,
  // вечно, в CRM клиента. Юнит-тесты этого исключить не могут (они не знают, что реальный портал
  // делает с этими полями), поэтому код проверяет сам — один раз на портал на процесс.
  beforeEach(resetMarkerProof)

  const subject = item({ docId: 'v1' })

  function calls(markerFound: boolean) {
    const seen: string[] = []
    const call = async (method: string) => {
      seen.push(method)
      if (method === TODO_ACTIVITY_ADD_METHOD) return { result: { id: 77 } }
      if (method === ACTIVITY_LIST_METHOD) return { result: markerFound ? [{ ID: 77 }] : [] }
      return { result: true }
    }
    return { call, seen }
  }

  it('маркер находится — запись успешна, проверка больше не повторяется', async () => {
    const { call, seen } = calls(true)
    expect(await writeTodoActivityViaRest(subject, '5', call, undefined, 'M1')).toBe('77')
    expect(seen.filter(m => m === ACTIVITY_LIST_METHOD)).toHaveLength(1)

    // Второй платёж того же портала проверку уже не платит.
    await writeTodoActivityViaRest(item({ docId: 'v2' }), '5', call, undefined, 'M1')
    expect(seen.filter(m => m === ACTIVITY_LIST_METHOD)).toHaveLength(1)
  })

  it('маркер НЕ находится — падаем громко, а не копим дубли молча', async () => {
    const { call } = calls(false)
    await expect(writeTodoActivityViaRest(subject, '5', call, undefined, 'M1'))
      .rejects.toThrow(/маркер|marker/i)
  })

  it('каждый портал проверяется отдельно — поведение может отличаться', async () => {
    const { call, seen } = calls(true)
    await writeTodoActivityViaRest(subject, '5', call, undefined, 'M1')
    await writeTodoActivityViaRest(subject, '5', call, undefined, 'M2')
    expect(seen.filter(m => m === ACTIVITY_LIST_METHOD)).toHaveLength(2)
  })

  it('без portalId проверки нет — смоук-скрипт и старые вызовы работают как раньше', async () => {
    const { call, seen } = calls(false)
    expect(await writeTodoActivityViaRest(subject, '5', call)).toBe('77')
    expect(seen).not.toContain(ACTIVITY_LIST_METHOD)
  })
})
