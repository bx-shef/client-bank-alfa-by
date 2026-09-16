import { describe, expect, it } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import {
  LEGACY_ACTIVITY_ADD_METHOD, LEGACY_ACTIVITY_TYPE_TASK,
  buildLegacyActivity, extractLegacyActivityId
} from '../app/utils/legacyActivity'
import { ACTIVITY_ORIGINATOR_ID, activityOriginId, buildActivityMarkerUpdate, buildTodoActivity } from '../app/utils/todoActivity'
import { ACTIVITY_ORIGIN } from '../app/utils/activity'
import { counterpartyAccountOf } from '../app/utils/eraseActivities'

// Запасной носитель операции — системное дело `crm.activity.add` (#722), для порталов без
// `crm.activity.todo.add`. Проверяется не «собрались ли поля», а три вещи, которые ломаются молча:
// маркер дедупа, читаемость направления без цвета и разбор ответа.

const ITEM: StatementItem = {
  account: 'BY00ALFA30120000000000000001',
  docId: 'D-77',
  docNum: '77',
  acceptDate: '2026-09-10',
  direction: 'credit',
  amount: 1840,
  currency: 'BYN',
  purpose: 'Оплата по счёту СЧ-1',
  counterparty: { name: 'ООО Ромашка', unp: '191000001', account: 'BY00PJCB30120000000000000002' }
}

const COMPANY = { id: 42 }

describe('запасное системное дело (#722)', () => {
  it('МАРКЕР ТОТ ЖЕ, что у основного носителя', () => {
    // ⚠ Главный инвариант правки. По паре (ORIGINATOR_ID, ORIGIN_ID) ищут ЧЕТЫРЕ места: дедуп
    // перед записью, дозапись реестра и привязок, «Очистка» и самопроверка маркера. Свой namespace
    // на запасном пути означал бы, что портал не находит СВОИХ ЖЕ дел: каждый опрос писал бы
    // операцию заново, а стирание не нашло бы ни одного созданного дела.
    const legacy = buildLegacyActivity(ITEM, COMPANY, 7).fields
    const todoMarker = buildActivityMarkerUpdate(ITEM)

    expect(legacy.ORIGINATOR_ID).toBe(todoMarker.ORIGINATOR_ID)
    expect(legacy.ORIGIN_ID).toBe(todoMarker.ORIGIN_ID)
    // И то же самое — против единственного источника, а не против соседнего билдера.
    expect(legacy.ORIGINATOR_ID).toBe(ACTIVITY_ORIGINATOR_ID)
    expect(legacy.ORIGINATOR_ID).toBe(ACTIVITY_ORIGIN)
    expect(legacy.ORIGIN_ID).toBe(activityOriginId(ITEM))
  })

  it('ГАРД: «Очистка» найдёт такое дело и прочитает счёт контрагента', () => {
    // Стирание дел (#576 п.4 / #591) отбирает по нашему ORIGINATOR_ID и читает счёт плательщика из
    // строки `[B]Счёт:[/B]` в ОПИСАНИИ. Оба свойства обязаны сохраниться и на запасном носителе —
    // иначе созданные им дела стали бы неудаляемыми.
    const fields = buildLegacyActivity(ITEM, COMPANY, 7).fields
    expect(fields.ORIGINATOR_ID).toBe(ACTIVITY_ORIGIN)
    expect(counterpartyAccountOf(fields.DESCRIPTION)).toBe(ITEM.counterparty.account)
  })

  it('направление читается текстом — цвета у системного дела нет', () => {
    const credit = buildLegacyActivity(ITEM, COMPANY, 7).fields
    const debit = buildLegacyActivity({ ...ITEM, direction: 'debit' }, COMPANY, 7).fields

    expect(credit.SUBJECT.startsWith('Приход')).toBe(true)
    expect(credit.DESCRIPTION).toContain('[B]Приход:[/B]')
    expect(debit.SUBJECT.startsWith('Расход')).toBe(true)
    expect(debit.DESCRIPTION).toContain('[B]Расход:[/B]')
    // Поля цвета у системного дела нет вовсе — если оно появится, это осознанная правка.
    expect('colorId' in credit).toBe(false)
  })

  it('описание — ТО ЖЕ, что у основного носителя (две копии разошлись бы молча)', () => {
    const legacy = buildLegacyActivity(ITEM, COMPANY, 7).fields
    const todo = buildTodoActivity(ITEM, COMPANY)
    expect(legacy.DESCRIPTION).toBe(todo.description)
    expect(legacy.SUBJECT).toBe(todo.title)
    expect(legacy.DESCRIPTION_TYPE).toBe(3) // BB, иначе разметка читается буквально
  })

  it('обязательные поля системного дела заполнены', () => {
    const fields = buildLegacyActivity(ITEM, COMPANY, 7).fields
    expect(fields.TYPE_ID).toBe(LEGACY_ACTIVITY_TYPE_TASK)
    expect(fields.RESPONSIBLE_ID).toBe(7)
    expect(fields.OWNER_ID).toBe(42)
    expect(fields.COMPLETED).toBe('N') // дело не закрывается — платёж ждёт человека
    expect(LEGACY_ACTIVITY_ADD_METHOD).toBe('crm.activity.add')
  })

  it('время операции, а не время импорта', () => {
    // Не задай мы START_TIME/END_TIME, портал поставит момент импорта, и выписка за прошлую неделю
    // легла бы в ленту сегодняшним днём.
    const fields = buildLegacyActivity(ITEM, COMPANY, 7).fields
    expect(fields.DEADLINE.startsWith('2026-09-10')).toBe(true)
    expect(fields.START_TIME).toBe(fields.DEADLINE)
    expect(fields.END_TIME).toBe(fields.DEADLINE)
  })

  it('конверт ответа ПЛОСКИЙ, чужим разбором его не прочесть', () => {
    expect(extractLegacyActivityId({ result: 999 })).toBe('999')
    expect(extractLegacyActivityId({ result: '999' })).toBe('999')
    // Вложенный конверт `todo.add` — не наш: принять его за успех значит пометить не то.
    expect(extractLegacyActivityId({ result: { id: 999 } })).toBeNull()
    expect(extractLegacyActivityId({ result: 'abc' })).toBeNull()
    expect(extractLegacyActivityId({})).toBeNull()
  })
})
