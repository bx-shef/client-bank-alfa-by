import { describe, expect, it } from 'vitest'
import type { StatementItem } from '../app/types/statement'
import {
  LEGACY_ACTIVITY_ADD_METHOD, LEGACY_ACTIVITY_TYPE_MEETING,
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
    expect(fields.TYPE_ID).toBe(LEGACY_ACTIVITY_TYPE_MEETING)
    expect(fields.RESPONSIBLE_ID).toBe(7)
    expect(fields.OWNER_ID).toBe(42)
    expect(fields.COMPLETED).toBe('N') // дело не закрывается — платёж ждёт человека
    expect(LEGACY_ACTIVITY_ADD_METHOD).toBe('crm.activity.add')
  })

  it('тип дела — из двух, которые портал ПРИНЯЛ на замере, а не из документации', () => {
    // ⚠ Замер 2026-09-16 отверг все шесть типов подряд, и выбранная по документации «Задача» (3)
    // была среди отвергнутых — первая редакция модуля была мертва целиком. Годными оказались
    // ровно 1 и 2, и только с непустым COMMUNICATIONS. Список закрыт намеренно: вернуть сюда
    // «осмысленную» Задачу — первое, что придёт в голову следующему читателю.
    expect([1, 2]).toContain(buildLegacyActivity(ITEM, COMPANY, 7).fields.TYPE_ID)
  })

  it('COMMUNICATIONS непустой и БЕЗ выдуманного контакта', () => {
    // ⚠ Пустой массив портал отвергает наравне с отсутствующим полем — поэтому одна привязка
    // обязана быть. ⚠ И ровно одна, без TYPE/VALUE: очевидная форма «подставить телефон» записала
    // бы в CRM клиента контакт, которого у нас нет и быть не может (в выписке его нет вовсе).
    const comm = buildLegacyActivity(ITEM, COMPANY, 7).fields.COMMUNICATIONS
    expect(comm).toHaveLength(1)
    expect(comm[0]).toEqual({ ENTITY_ID: 42, ENTITY_TYPE_ID: 4 })
    expect(Object.keys(comm[0]!).sort()).toEqual(['ENTITY_ID', 'ENTITY_TYPE_ID'])
  })

  it('привязка коммуникации — ТОТ ЖЕ владелец, а не чужая сущность', () => {
    // Платёж в карточке того, кто его не делал, — худший исход из возможных.
    const fields = buildLegacyActivity(ITEM, COMPANY, 7).fields
    expect(fields.COMMUNICATIONS[0]!.ENTITY_ID).toBe(fields.OWNER_ID)
    expect(fields.COMMUNICATIONS[0]!.ENTITY_TYPE_ID).toBe(fields.OWNER_TYPE_ID)
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
