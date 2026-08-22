import { describe, expect, it, vi } from 'vitest'
import { bindActivityViaRest } from '../server/utils/activityBindingsWrite'
import { ACTIVITY_BINDING_ADD_METHOD, ACTIVITY_BINDING_LIST_METHOD } from '../app/utils/activityBindings'
import type { BatchCommand } from '../server/utils/companyLookup'

// Транспорт привязок (#579). Проверяется ровно то, что замерено на живом портале и потому не
// выводится из документации: повторная привязка — ОШИБКА, поэтому «поставить ещё раз на всякий
// случай» нельзя, и после упавшего батча транспорт обязан сперва прочитать список.

const REFS = [
  { entityTypeId: 1038, entityId: 39 },
  { entityTypeId: 2, entityId: 35 },
  { entityTypeId: 4, entityId: 15 }
]

/** `binding.list`-ответ портала. Регистр ключей ВЕРХНИЙ — как отвечает реальный портал. */
function listResponse(pairs: Array<[number, number]>) {
  return { result: pairs.map(([t, i]) => ({ ENTITY_TYPE_ID: t, ENTITY_ID: i })) }
}

describe('запись привязок', () => {
  it('пустой список — ни одного вызова', async () => {
    const call = vi.fn()
    expect(await bindActivityViaRest('1', [], call)).toEqual({ bound: 0, failed: 0 })
    expect(call).not.toHaveBeenCalled()
  })

  it('батч ставит все привязки одним походом', async () => {
    // ⚠ Не оптимизация ради красоты: на выписке в сотни строк это разница между одним вызовом на
    // операцию и четырьмя, то есть заметная доля бюджета портала.
    const call = vi.fn()
    const batch = vi.fn(async (_cmds: BatchCommand[]) => [])
    expect(await bindActivityViaRest('7', REFS, call, batch)).toEqual({ bound: 3, failed: 0 })
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0]![0]).toEqual(REFS.map(r => ({
      method: ACTIVITY_BINDING_ADD_METHOD,
      params: { activityId: 7, entityTypeId: r.entityTypeId, entityId: r.entityId }
    })))
    expect(call).not.toHaveBeenCalled()
  })

  it('упавший батч: читаем список и ставим ТОЛЬКО недостающее', async () => {
    // ⚠ Это и есть смысл модуля. Батч halt-on-error: часть команд могла примениться, и портал не
    // говорит какая. Повторить их вслепую нельзя — повторная привязка отвечает
    // `ACTIVITY_IS_ALREADY_BOUND` (замерено), и успешная половина вернулась бы сюда как «отказ».
    const applied: Array<[number, number]> = [[1038, 39]]
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === ACTIVITY_BINDING_LIST_METHOD) return listResponse(applied)
      if ((params.entityTypeId as number) === 1038) throw new Error('Дело уже привязано к этой сущности')
      return { result: true }
    })
    const batch = vi.fn(async () => {
      throw new Error('batch halted')
    })
    expect(await bindActivityViaRest('7', REFS, call, batch)).toEqual({ bound: 3, failed: 0 })
    const added = call.mock.calls.filter(c => c[0] === ACTIVITY_BINDING_ADD_METHOD).map(c => c[1]!.entityTypeId)
    expect(added, 'уже привязанную пару звали второй раз').toEqual([2, 4])
  })

  it('нечитаемый список не отменяет попытку', async () => {
    // «Не смогли спросить» не равно «нечего ставить»: худшее, что случится, — часть пар ответит
    // «уже привязано», и это посчитается отказом. Молчание было бы хуже: связь не появилась бы.
    const call = vi.fn(async (method: string) => {
      if (method === ACTIVITY_BINDING_LIST_METHOD) throw new Error('list failed')
      return { result: true }
    })
    const batch = vi.fn(async () => {
      throw new Error('batch halted')
    })
    expect(await bindActivityViaRest('7', REFS, call, batch)).toEqual({ bound: 3, failed: 0 })
  })

  it('без батча ставит поштучно и считает отказы, не бросая', async () => {
    // ⚠ Контракт «никогда не бросает» — несущий: дело уже записано и промаркировано, поэтому
    // исключение отсюда отменило бы обработку всех оставшихся операций пачки, ничего не починив.
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === ACTIVITY_BINDING_LIST_METHOD) return listResponse([])
      if ((params.entityTypeId as number) === 2) throw new Error('нет доступа')
      return { result: true }
    })
    const out = await bindActivityViaRest('7', REFS, call)
    expect(out).toEqual({ bound: 2, failed: 1 })
  })

  it('непригодный id дела не превращается в вызов', async () => {
    const call = vi.fn()
    expect(await bindActivityViaRest('', REFS, call)).toEqual({ bound: 0, failed: 0 })
    expect(call).not.toHaveBeenCalled()
  })
})
