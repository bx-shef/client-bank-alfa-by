import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_BINDING_ADD_METHOD, CRM_ENTITY_TYPE_DEAL, MAX_ACTIVITY_BINDINGS, allocationTargetRef,
  buildBindingCall, companyRef, itemRef, planActivityBindings,
  isDynamicEntityType
} from '~/utils/activityBindings'
import { CRM_OWNER_TYPE_COMPANY } from '~/utils/activity'
import { SMART_INVOICE_ENTITY_TYPE_ID } from '~/config/b24'

// Отбор привязок дела (#579, шаг 3 согласованного процесса).
//
// ⚠ Всё, что здесь проверяется, отказывает ТИХО. Привязка к несуществующей сущности принимается
// порталом с `{result:true}` (замерено живым прогоном), повторная привязка той же пары — ошибка,
// а владелец уже привязан сам. То есть ни один промах этого модуля не виден по ответу REST: цена
// ошибки — либо мусорная связь в карточке клиента, либо шум «уже привязано» в логе.

describe('ссылки на сущности', () => {
  it('id принимается и строкой, и числом', () => {
    expect(companyRef('42')).toEqual({ entityTypeId: CRM_OWNER_TYPE_COMPANY, entityId: 42 })
    expect(companyRef(42)).toEqual({ entityTypeId: CRM_OWNER_TYPE_COMPANY, entityId: 42 })
  })

  it.each([null, undefined, '', '0', '-1', 'abc', '12abc', '1.5'])('непригодный id (%s) → null', (bad) => {
    // ⚠ Не педантизм: портал принимает ЛЮБОЙ entityId молча, поэтому «12abc», превращённое в 12,
    // повесило бы платёж на чужую компанию, а нулевой id — на несуществующую. Отбраковка здесь
    // единственное место, где это ещё можно поймать.
    expect(companyRef(bad as string)).toBeNull()
    expect(itemRef(1038, bad as string)).toBeNull()
  })

  it('элемент смарт-процесса требует и тип, и id', () => {
    expect(itemRef(1038, '7')).toEqual({ entityTypeId: 1038, entityId: 7 })
    expect(itemRef(0, '7')).toBeNull()
    expect(itemRef(undefined, '7')).toBeNull()
  })
})

describe('сущность списания по цели разнесения', () => {
  it('счёт → смарт-счёт, сделка → сделка', () => {
    expect(allocationTargetRef({ kind: 'invoice', id: '5' }))
      .toEqual({ entityTypeId: SMART_INVOICE_ENTITY_TYPE_ID, entityId: 5 })
    expect(allocationTargetRef({ kind: 'deal', id: '9' }))
      .toEqual({ entityTypeId: CRM_ENTITY_TYPE_DEAL, entityId: 9 })
  })

  it('оплата сделки ведёт на САМУ СДЕЛКУ, а не на запись оплаты', () => {
    // ⚠ У оплаты нет своей ленты — привязывать дело к ней некуда. И id-пространства разные:
    // взять `id` записи оплаты как id сделки значит показать платёж в ЧУЖОЙ карточке.
    expect(allocationTargetRef({ kind: 'deal-payment', id: '3', dealId: '77' }))
      .toEqual({ entityTypeId: CRM_ENTITY_TYPE_DEAL, entityId: 77 })
    expect(allocationTargetRef({ kind: 'deal-payment', id: '3' })).toBeNull()
  })

  it('смарт-процесс без своего entityTypeId неадресуем', () => {
    expect(allocationTargetRef({ kind: 'smart-process', id: '4', entityTypeId: 1044 }))
      .toEqual({ entityTypeId: 1044, entityId: 4 })
    expect(allocationTargetRef({ kind: 'smart-process', id: '4' })).toBeNull()
  })
})

describe('план привязок', () => {
  const owner = { entityTypeId: CRM_OWNER_TYPE_COMPANY, entityId: 13 }

  it('владелец не привязывается повторно', () => {
    // ⚠ Портал держит пару владельца САМ (замерено: `binding.list` показывает её без нашего
    // вызова), а повторная привязка — ошибка `ACTIVITY_IS_ALREADY_BOUND`. То есть промах здесь
    // выглядел бы как отказ на исправном портале.
    const plan = planActivityBindings({ owner, refs: [companyRef(13), companyRef(15)] })
    expect(plan).toEqual([{ entityTypeId: CRM_OWNER_TYPE_COMPANY, entityId: 15 }])
  })

  it('дубли схлопываются, пустые пропускаются, порядок сохраняется', () => {
    // ⚠ Тип 1038 в этом наборе больше не проходит — смарт-процессы отбрасываются целиком
    // (перехватывают владельца дела, замерено на живом портале). Дубли проверяем на сделке.
    const plan = planActivityBindings({
      refs: [itemRef(CRM_ENTITY_TYPE_DEAL, '7'), null, companyRef(15), itemRef(CRM_ENTITY_TYPE_DEAL, '7'), undefined, companyRef(15)]
    })
    expect(plan).toEqual([
      { entityTypeId: CRM_ENTITY_TYPE_DEAL, entityId: 7 },
      { entityTypeId: CRM_OWNER_TYPE_COMPANY, entityId: 15 }
    ])
  })

  it('одинаковый id разных ТИПОВ — это разные сущности', () => {
    const plan = planActivityBindings({ refs: [companyRef(7), itemRef(CRM_ENTITY_TYPE_DEAL, 7)] })
    expect(plan).toHaveLength(2)
  })

  it('потолок отсекает хвост, а не начало', () => {
    // ⚠ Каждая привязка — отдельный вызов, а у неоднозначного платежа целей бывает много. Резать
    // надо хвост: вызывающий подаёт сперва то, без чего связь бессмысленна.
    const many = Array.from({ length: MAX_ACTIVITY_BINDINGS + 3 }, (_, i) => itemRef(CRM_ENTITY_TYPE_DEAL, i + 1))
    const plan = planActivityBindings({ refs: many })
    expect(plan).toHaveLength(MAX_ACTIVITY_BINDINGS)
    expect(plan[0]).toEqual({ entityTypeId: CRM_ENTITY_TYPE_DEAL, entityId: 1 })
  })

  it('свой потолок уважается', () => {
    expect(planActivityBindings({ refs: [companyRef(1), companyRef(2), companyRef(3)], limit: 2 })).toHaveLength(2)
  })
})

describe('вызов привязки', () => {
  it('метод и параметры — ровно те, что принимает портал', () => {
    expect(buildBindingCall('2087', { entityTypeId: 1038, entityId: 39 })).toEqual({
      method: ACTIVITY_BINDING_ADD_METHOD,
      params: { activityId: 2087, entityTypeId: 1038, entityId: 39 }
    })
  })

  it('непригодный id дела → вызова нет', () => {
    expect(buildBindingCall('', { entityTypeId: 4, entityId: 1 })).toBeNull()
    expect(buildBindingCall('abc', { entityTypeId: 4, entityId: 1 })).toBeNull()
  })
})

describe('смарт-процессы в привязки НЕ попадают (#26, замерено на живом портале)', () => {
  it('элемент реестра платежей отбрасывается', () => {
    // ⚠ Привязка динамического типа ПЕРЕХВАТЫВАЕТ владельца дела: мы создаём дело с
    // `ownerTypeId: 4` (компания), а после привязки элемента `crm.activity.get` отдаёт
    // `OWNER_TYPE_ID: 1038`. Наружу — «Клиент» в списке дел показывает «Импорт выписки: платежи
    // #45» вместо плательщика. Вернуть владельца нечем: `crm.activity.update` отвечает
    // «Fields is not specified». Замерено на живом портале 2026-08-23.
    const refs = planActivityBindings({
      owner: { entityTypeId: 4, entityId: 7 },
      refs: [{ entityTypeId: 1038, entityId: 45 }, { entityTypeId: 4, entityId: 9 }]
    })
    expect(refs, 'смарт-процесс снова привязывается — владелец дела будет перехвачен')
      .toEqual([{ entityTypeId: 4, entityId: 9 }])
  })

  it('системные сущности проходят: сделка, счёт, компания, контакт', () => {
    // ⚠ Отбрасываем ровно динамические типы, а не «всё кроме компании»: связь со сделкой и счётом
    // — то, ради чего привязки и заводились (#579), и она владельца не трогает.
    const refs = planActivityBindings({
      refs: [
        { entityTypeId: 2, entityId: 1 },
        { entityTypeId: 31, entityId: 2 },
        { entityTypeId: 3, entityId: 3 },
        { entityTypeId: 4, entityId: 4 }
      ]
    })
    expect(refs.map(r => r.entityTypeId)).toEqual([2, 31, 3, 4])
  })

  it('граница динамических типов — 128', () => {
    expect(isDynamicEntityType(127)).toBe(false)
    expect(isDynamicEntityType(128)).toBe(true)
    expect(isDynamicEntityType(1038)).toBe(true)
  })
})
