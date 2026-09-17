import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import { PortalRestError } from '../server/utils/portalError'
import {
  isMethodNotFound, resetCarrierProbe, resetCurrencyCache, resetMarkerProof, resetResponsibleCache,
  writeTodoActivityViaRest
} from '../server/utils/todoActivityWrite'

// Выбор носителя дела (#722): портал без `crm.activity.todo.add` обязан получить системное
// `crm.activity.add`, а портал с ним — не заметить, что запасной путь вообще существует.

const ITEM: StatementItem = {
  account: 'BY00ALFA30120000000000000001',
  docId: 'D-77',
  docNum: '77',
  acceptDate: '2026-09-10',
  direction: 'credit',
  amount: 1840,
  currency: 'BYN',
  purpose: 'Оплата по счёту',
  counterparty: { name: 'ООО Ромашка', unp: '191000001', account: 'BY00PJCB30120000000000000002' }
}

const noSleep = async () => {}

/** Портал, у которого нового метода нет: он отвечает кодом, а всё остальное работает. */
function legacyPortalCall(seen: string[]) {
  return vi.fn(async (method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    seen.push(method)
    if (method === 'crm.activity.todo.add') {
      throw new PortalRestError('Method not found!', 'ERROR_METHOD_NOT_FOUND', method)
    }
    if (method === 'profile') return { result: { ID: 5 } }
    if (method === 'crm.activity.add') return { result: 999 }
    if (method === 'crm.activity.list') return { result: [{ ID: 999 }] }
    return {}
  })
}

afterEach(() => {
  resetCarrierProbe()
  resetMarkerProof()
  resetResponsibleCache()
  resetCurrencyCache()
})

describe('#722 выбор носителя дела', () => {
  it('нет метода ⇒ пишем системное дело и отдаём его id', async () => {
    const seen: string[] = []
    const call = legacyPortalCall(seen)
    const id = await writeTodoActivityViaRest(ITEM, '42', call, undefined, 'M1', noSleep)

    expect(id).toBe('999')
    expect(seen).toContain('crm.activity.add')
    // Маркер уже внутри создающего вызова — второго вызова на маркировку быть не должно.
    expect(seen).not.toContain('crm.activity.update')
  })

  it('ЗАГОЛОВОК системного дела тоже подписан справочником портала (#729)', async () => {
    // ⚠ Блоков на старом портале не будет НИКОГДА (замерено), поэтому заголовок — единственное
    // место, где там видна сумма; печатать её иначе, чем на всех остальных порталах, незачем.
    let subject = ''
    const call = vi.fn(async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (method === 'crm.activity.todo.add') {
        throw new PortalRestError('Method not found!', 'ERROR_METHOD_NOT_FOUND', method)
      }
      if (method === 'profile') return { result: { ID: 5 } }
      if (method === 'crm.currency.list') {
        return { result: [{ CURRENCY: 'BYN', FORMAT_STRING: '# руб.', DECIMALS: 2 }] }
      }
      if (method === 'crm.activity.add') {
        subject = String(((params as { fields?: Record<string, unknown> }).fields ?? {}).SUBJECT ?? '')
        return { result: 999 }
      }
      if (method === 'crm.activity.list') return { result: [{ ID: 999 }] }
      return {}
    })
    await writeTodoActivityViaRest(ITEM, '42', call, undefined, 'M-CUR', noSleep)
    expect(subject).toContain('1\u00A0840,00 руб.')
    expect(subject).not.toContain('BYN')
  })

  it('ГАРД: повторно портал не переспрашиваем — кэш на процесс', async () => {
    const seen: string[] = []
    const call = legacyPortalCall(seen)
    await writeTodoActivityViaRest(ITEM, '42', call, undefined, 'M1', noSleep)
    const first = seen.filter(m => m === 'crm.activity.todo.add').length
    await writeTodoActivityViaRest({ ...ITEM, docId: 'D-78' }, '42', call, undefined, 'M1', noSleep)

    expect(first).toBe(1)
    expect(seen.filter(m => m === 'crm.activity.todo.add')).toHaveLength(1)
    // И ответственного тоже спрашиваем один раз на портал.
    expect(seen.filter(m => m === 'profile')).toHaveLength(1)
  })

  it('ГАРД: ЛЮБОЙ другой отказ роняет джобу, а не уводит на устаревший метод', async () => {
    // Иначе разовая ошибка («нет прав», портал лёг) навсегда переключила бы здоровый портал на
    // устаревший носитель — молча и без пути обратно в пределах процесса.
    const seen: string[] = []
    const call = vi.fn(async (method: string): Promise<Record<string, unknown>> => {
      seen.push(method)
      throw new PortalRestError('Access denied', 'ACCESS_DENIED', method)
    })

    await expect(writeTodoActivityViaRest(ITEM, '42', call, undefined, 'M1', noSleep)).rejects.toThrow('Access denied')
    // ⚠ Сверяем ВЕСЬ список вызовов, а не отсутствие одного: первая редакция проверяла только
    // `not.toContain('crm.activity.add')` и пережила мутацию «снять узость условия» — запасной путь
    // начинался, падал на `profile` с тем же текстом, и тест этого не видел.
    // ⚠ Справочник валют идёт ПЕРЕД созданием (#729, один вызов на портал на процесс) — список
    // остаётся ТОЧНЫМ, а не «содержит»: иначе мутация «уйти на запасной путь» его пережила бы.
    expect(seen).toEqual(['crm.currency.list', 'crm.activity.todo.add'])
  })

  it('здоровый портал запасного пути не касается', async () => {
    const seen: string[] = []
    const call = vi.fn(async (method: string): Promise<Record<string, unknown>> => {
      seen.push(method)
      if (method === 'crm.activity.todo.add') return { result: { id: 100 } }
      if (method === 'crm.activity.list') return { result: [{ ID: 100 }] }
      return {}
    })
    const id = await writeTodoActivityViaRest(ITEM, '42', call, undefined, 'M1', noSleep)

    expect(id).toBe('100')
    expect(seen).toContain('crm.activity.update') // маркер вторым вызовом, как и было
    expect(seen).not.toContain('crm.activity.add')
    expect(seen).not.toContain('profile') // ответственный нужен только запасному пути
  })

  it('маркер не находится ⇒ дело удаляется и джоба падает (и на запасном пути тоже)', async () => {
    const seen: string[] = []
    const call = vi.fn(async (method: string): Promise<Record<string, unknown>> => {
      seen.push(method)
      if (method === 'crm.activity.todo.add') {
        throw new PortalRestError('Method not found!', 'ERROR_METHOD_NOT_FOUND', method)
      }
      if (method === 'profile') return { result: { ID: 5 } }
      if (method === 'crm.activity.add') return { result: 999 }
      if (method === 'crm.activity.list') return { result: [] } // маркер не нашёлся
      return {}
    })

    await expect(writeTodoActivityViaRest(ITEM, '42', call, undefined, 'M1', noSleep)).rejects.toThrow(/marker did not stick/)
    expect(seen).toContain('crm.activity.delete')
  })

  it('портал без ответственного — честный отказ, а не выдуманный id', async () => {
    const call = vi.fn(async (method: string): Promise<Record<string, unknown>> => {
      if (method === 'crm.activity.todo.add') {
        throw new PortalRestError('Method not found!', 'ERROR_METHOD_NOT_FOUND', method)
      }
      if (method === 'profile') return { result: {} }
      return {}
    })
    await expect(writeTodoActivityViaRest(ITEM, '42', call, undefined, 'M1', noSleep)).rejects.toThrow(/RESPONSIBLE_ID/)
  })
})

describe('isMethodNotFound', () => {
  it('узнаёт код, в том числе внутри обёртки SDK', () => {
    expect(isMethodNotFound(new PortalRestError('x', 'ERROR_METHOD_NOT_FOUND', 'm'))).toBe(true)
    expect(isMethodNotFound({ code: 'error_method_not_found' })).toBe(true)
    expect(isMethodNotFound({ code: 'JSSDK_UNKNOWN_ERROR', originalError: { code: 'ERROR_METHOD_NOT_FOUND' } })).toBe(true)
  })

  it('не путает с другими отказами', () => {
    expect(isMethodNotFound(new PortalRestError('x', 'ACCESS_DENIED', 'm'))).toBe(false)
    expect(isMethodNotFound(new Error('Method not found!'))).toBe(false) // текст — не доказательство
    expect(isMethodNotFound(null)).toBe(false)
  })
})
