import { describe, expect, it, vi } from 'vitest'
import {
  extractCreatedSpRef,
  extractExistingFieldNames,
  provisionDistributionSp
} from '../server/utils/distributionSpProvision'
import {
  DISTRIBUTION_SP_FIELDS,
  DISTRIBUTION_SP_TITLE,
  PAYMENT_SP_FIELDS,
  PAYMENT_SP_TITLE
} from '../app/config/distributionSp'

// Provisioning transport (#109 §9.1 slice 3): idempotent probe → create-if-absent → add missing UFs.
// DI over a fake RestCall — no network.

describe('extractCreatedSpRef', () => {
  it('reads result.type.entityTypeId + id', () => {
    expect(extractCreatedSpRef({ result: { type: { entityTypeId: 1044, id: 44 } } })).toEqual({ entityTypeId: 1044, id: 44 })
  })
  it('null on malformed / non-positive / either id missing', () => {
    expect(extractCreatedSpRef({ result: {} })).toBeNull()
    expect(extractCreatedSpRef({})).toBeNull()
    expect(extractCreatedSpRef({ result: { type: { entityTypeId: 0, id: 44 } } })).toBeNull()
    expect(extractCreatedSpRef({ result: { type: { entityTypeId: 1044 } } })).toBeNull() // no id
    expect(extractCreatedSpRef({ result: { type: { entityTypeId: 1044, id: 'x' } } })).toBeNull()
  })
})

describe('extractExistingFieldNames', () => {
  it('pulls fieldName strings, tolerant of shape', () => {
    expect(extractExistingFieldNames({ result: { fields: [{ fieldName: 'UF_CRM_1_A' }, { fieldName: 'UF_CRM_1_B' }] } }))
      .toEqual(['UF_CRM_1_A', 'UF_CRM_1_B'])
    expect(extractExistingFieldNames({ result: {} })).toEqual([])
    expect(extractExistingFieldNames({ result: { fields: 'nope' } })).toEqual([])
    expect(extractExistingFieldNames({ result: { fields: [{}, { fieldName: 42 }] } })).toEqual([])
  })
})

/** Build a fake RestCall over a scripted response map keyed by method (+ optional per-call logic). */
function fakeCall(handlers: Record<string, (params: Record<string, unknown>) => Record<string, unknown>>) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    const h = handlers[method]
    if (!h) throw new Error(`unexpected method ${method}`)
    return h(params)
  })
  return { call, calls }
}

describe('provisionDistributionSp', () => {
  it('creates both SPs when absent and adds every user field', async () => {
    let nextEtid = 1044
    const { call, calls } = fakeCall({
      'crm.type.list': () => ({ result: { types: [] } }),
      'crm.type.add': () => {
        const e = nextEtid++
        return { result: { type: { entityTypeId: e, id: e } } }
      },
      'userfieldconfig.list': () => ({ result: { fields: [] } }),
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call)
    expect(res.paymentSpEtid).toBe(1044)
    expect(res.distributionSpEtid).toBe(1045)
    expect(res.createdPaymentSp).toBe(true)
    expect(res.createdDistributionSp).toBe(true)
    const totalFields = Object.values(PAYMENT_SP_FIELDS).length + Object.values(DISTRIBUTION_SP_FIELDS).length
    expect(res.addedFields).toBe(totalFields)
    expect(calls.filter(c => c.method === 'userfieldconfig.add')).toHaveLength(totalFields)
  })

  it('recovers existing SPs by title (no create) and adds only missing fields', async () => {
    const paymentEtid = 1044
    const distributionEtid = 1046
    const { call, calls } = fakeCall({
      'crm.type.list': () => ({ result: { types: [
        { entityTypeId: paymentEtid, id: paymentEtid, title: PAYMENT_SP_TITLE },
        { entityTypeId: distributionEtid, id: distributionEtid, title: DISTRIBUTION_SP_TITLE }
      ] } }),
      'userfieldconfig.list': (params) => {
        // payment SP already has ALL its fields; distribution SP has none
        const entityId = (params.filter as Record<string, unknown>).entityId
        if (entityId === `CRM_${paymentEtid}`) {
          return { result: { fields: Object.values(PAYMENT_SP_FIELDS).map(f => ({ fieldName: `UF_CRM_${paymentEtid}_${f.postfix}` })) } }
        }
        return { result: { fields: [] } }
      },
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call)
    expect(res.createdPaymentSp).toBe(false)
    expect(res.createdDistributionSp).toBe(false)
    expect(res.paymentSpEtid).toBe(paymentEtid)
    expect(res.distributionSpEtid).toBe(distributionEtid)
    expect(res.addedFields).toBe(Object.values(DISTRIBUTION_SP_FIELDS).length)
    expect(calls.some(c => c.method === 'crm.type.add')).toBe(false)
  })

  it('skips the probe entirely when both ids are known (only ensures fields)', async () => {
    const { call, calls } = fakeCall({
      'userfieldconfig.list': () => ({ result: { fields: [] } }),
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call, { payment: { entityTypeId: 100, id: 100 }, distribution: { entityTypeId: 200, id: 200 } })
    expect(res.paymentSpEtid).toBe(100)
    expect(res.distributionSpEtid).toBe(200)
    expect(res.createdPaymentSp).toBe(false)
    expect(calls.some(c => c.method === 'crm.type.list')).toBe(false)
  })

  it('is idempotent — a re-run after full provisioning adds nothing', async () => {
    const paymentEtid = 100
    const distributionEtid = 200
    const { call } = fakeCall({
      'userfieldconfig.list': (params) => {
        const entityId = (params.filter as Record<string, unknown>).entityId
        const fields = entityId === `CRM_${paymentEtid}`
          ? Object.values(PAYMENT_SP_FIELDS)
          : Object.values(DISTRIBUTION_SP_FIELDS)
        const etid = entityId === `CRM_${paymentEtid}` ? paymentEtid : distributionEtid
        return { result: { fields: fields.map(f => ({ fieldName: `UF_CRM_${etid}_${f.postfix}` })) } }
      }
    })
    const res = await provisionDistributionSp(call, { payment: { entityTypeId: paymentEtid, id: paymentEtid }, distribution: { entityTypeId: distributionEtid, id: distributionEtid } })
    expect(res.addedFields).toBe(0)
  })

  it('throws when crm.type.add returns no entityTypeId', async () => {
    const { call } = fakeCall({
      'crm.type.list': () => ({ result: { types: [] } }),
      'crm.type.add': () => ({ result: { type: {} } })
    })
    await expect(provisionDistributionSp(call)).rejects.toThrow(/entityTypeId/)
  })

  it('self-heals a PARTIALLY-provisioned SP: adds exactly the missing fields (by name)', async () => {
    const paymentEtid = 100
    const distributionEtid = 200
    const { call, calls } = fakeCall({
      'userfieldconfig.list': (params) => {
        const entityId = (params.filter as Record<string, unknown>).entityId
        // payment SP has ONLY the marker; distribution SP has all → payment must gain the other two
        if (entityId === `CRM_${paymentEtid}`) {
          return { result: { fields: [{ fieldName: `UF_CRM_${paymentEtid}_${PAYMENT_SP_FIELDS.marker.postfix}` }] } }
        }
        return { result: { fields: Object.values(DISTRIBUTION_SP_FIELDS).map(f => ({ fieldName: `UF_CRM_${distributionEtid}_${f.postfix}` })) } }
      },
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call, { payment: { entityTypeId: paymentEtid, id: paymentEtid }, distribution: { entityTypeId: distributionEtid, id: distributionEtid } })
    const addedNames = calls
      .filter(c => c.method === 'userfieldconfig.add')
      .map(c => (c.params.field as Record<string, unknown>).fieldName)
    // ⚠ Ожидание ВЫВОДИТСЯ из объявленного набора, а не переписывается руками списком имён. Здесь
    // нет решения, которое стоило бы принимать поштучно: любое объявленное поле обязано довозиться
    // на уже существующий СП, иначе портал, где смарт-процесс создан прежней версией, молча живёт
    // без новых колонок. Ручной список ловил бы это как «поправь тест» — то есть предлагал бы
    // ослабить проверку ровно там, где она сработала. Порядок тоже проверяется: он совпадает с
    // порядком объявления, потому что провижининг идёт по `Object.values`.
    const expectedAdds = Object.entries(PAYMENT_SP_FIELDS)
      .filter(([key]) => key !== 'marker')
      .map(([, f]) => `UF_CRM_${paymentEtid}_${f.postfix}`)
    expect(addedNames).toEqual(expectedAdds)
    expect(addedNames).not.toContain(`UF_CRM_${paymentEtid}_${PAYMENT_SP_FIELDS.marker.postfix}`)
    expect(res.addedFields).toBe(expectedAdds.length)
    // #575: поля реестра — не «просто ещё поля». Смарт-процесс на боевом портале уже создан, и
    // единственный путь, которым они там появятся, это самолечение при повторном провижининге.
    expect(addedNames).toContain(`UF_CRM_${paymentEtid}_${PAYMENT_SP_FIELDS.purpose.postfix}`)
    expect(addedNames).toContain(`UF_CRM_${paymentEtid}_${PAYMENT_SP_FIELDS.counterpartyAccount.postfix}`)
  })

  it('mixed known/unknown ids: skips probe for the known SP, recovers the other by title', async () => {
    const distributionEtid = 1046
    const { call, calls } = fakeCall({
      'crm.type.list': () => ({ result: { types: [{ entityTypeId: distributionEtid, id: distributionEtid, title: DISTRIBUTION_SP_TITLE }] } }),
      'userfieldconfig.list': () => ({ result: { fields: [] } }),
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call, { payment: { entityTypeId: 500, id: 500 } })
    expect(res.paymentSpEtid).toBe(500) // known → used as-is
    expect(res.distributionSpEtid).toBe(distributionEtid) // recovered by title
    expect(res.createdPaymentSp).toBe(false)
    expect(res.createdDistributionSp).toBe(false)
    expect(calls.some(c => c.method === 'crm.type.add')).toBe(false) // recovered, not created
  })

  it('falls back to probe/create when a known id is non-positive (0 / NaN)', async () => {
    const { call, calls } = fakeCall({
      'crm.type.list': () => ({ result: { types: [] } }),
      'crm.type.add': () => ({ result: { type: { entityTypeId: 1044, id: 1044 } } }),
      'userfieldconfig.list': () => ({ result: { fields: [] } }),
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call, { payment: { entityTypeId: 0, id: 0 }, distribution: { entityTypeId: 1046, id: 1046 } })
    expect(res.paymentSpEtid).toBe(1044) // 0 rejected → probed/created
    expect(res.distributionSpEtid).toBe(1046)
    expect(calls.some(c => c.method === 'crm.type.list')).toBe(true) // 0 forced a probe
  })

  it('paginates crm.type.list — finds our SP on a later page (no duplicate create)', async () => {
    const paymentEtid = 1044
    let typePage = 0
    const { call, calls } = fakeCall({
      'crm.type.list': (params) => {
        // page 0: 50 unrelated types + next; page 1: our payment SP by title
        if (!params.start) {
          typePage = 1
          return { result: { types: [{ entityTypeId: 900, id: 900, title: 'Прочее' }] }, next: 50 }
        }
        return { result: { types: [{ entityTypeId: paymentEtid, id: paymentEtid, title: PAYMENT_SP_TITLE }] } }
      },
      'userfieldconfig.list': () => ({ result: { fields: [] } }),
      'userfieldconfig.add': () => ({ result: { field: {} } })
    })
    const res = await provisionDistributionSp(call, { distribution: { entityTypeId: 200, id: 200 } })
    expect(typePage).toBe(1)
    expect(res.paymentSpEtid).toBe(paymentEtid) // found on page 2
    expect(calls.some(c => c.method === 'crm.type.add')).toBe(false) // not duplicated
  })

  it('paginates userfieldconfig.list — a field present on page 2 is not re-added', async () => {
    const paymentEtid = 100
    const distributionEtid = 200
    const { call, calls } = fakeCall({
      'userfieldconfig.list': (params) => {
        const entityId = (params.filter as Record<string, unknown>).entityId
        const etid = entityId === `CRM_${paymentEtid}` ? paymentEtid : distributionEtid
        const fields = etid === paymentEtid ? Object.values(PAYMENT_SP_FIELDS) : Object.values(DISTRIBUTION_SP_FIELDS)
        // split fields across two pages
        if (!params.start) {
          return { result: { fields: fields.slice(0, 1).map(f => ({ fieldName: `UF_CRM_${etid}_${f.postfix}` })) }, next: 1 }
        }
        return { result: { fields: fields.slice(1).map(f => ({ fieldName: `UF_CRM_${etid}_${f.postfix}` })) } }
      }
    })
    const res = await provisionDistributionSp(call, { payment: { entityTypeId: paymentEtid, id: paymentEtid }, distribution: { entityTypeId: distributionEtid, id: distributionEtid } })
    expect(res.addedFields).toBe(0) // all fields seen across both pages → nothing re-added
    expect(calls.some(c => c.method === 'userfieldconfig.add')).toBe(false)
  })
})

describe('раскладка карточки реестра (#27)', () => {
  it('после создания полей выставляется ОБЩАЯ настройка карточки', async () => {
    // ⚠ Поля на элементе были и были подписаны по-русски, но карточка их не показывала: портал
    // рисует раскладку по умолчанию, и клиент, моя компания, сумма, дата и назначение в неё не
    // попадали. То есть реестр держал данные, которых человек не видел.
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    const call = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'crm.type.add') return { result: { type: { entityTypeId: 1038, id: 7 } } }
      return { result: {} }
    }
    const res = await provisionDistributionSp(call as never, {
      payment: { entityTypeId: 1038, id: 7 },
      distribution: { entityTypeId: 1040, id: 8 }
    })
    const cfg = calls.find(c => c.method === 'crm.item.details.configuration.set')
    expect(cfg, 'раскладка карточки не выставляется').toBeTruthy()
    expect(cfg!.params.scope, 'личная настройка вместо общей — бухгалтер увидит прежнюю карточку').toBe('C')
    expect(res.cardConfigured).toBe(true)

    // Имена полей — в той форме, в какой их ХРАНИТ портал: `UF_CRM7_…`, без подчёркивания после
    // CRM. С формой создания (`UF_CRM_7_…`) настройка полей просто не найдёт и покажет пустой
    // раздел (замерено на живом портале).
    const names = (cfg!.params.data as Array<{ elements: Array<{ name: string }> }>)
      .flatMap(s => s.elements.map(e => e.name))
    expect(names).toContain('UF_CRM7_OP_DATE')
    expect(names).toContain('UF_CRM7_PURPOSE')
    expect(names, 'клиент не попал в карточку').toContain('COMPANY_ID')
    expect(names, 'моя компания не попала в карточку').toContain('MYCOMPANY_ID')
    expect(names.some(n => n.startsWith('UF_CRM_7_')), 'форма СОЗДАНИЯ поля вместо хранимой').toBe(false)
  })

  it('отказ настройки карточки НЕ роняет провижининг', async () => {
    // ⚠ Провижининг создаёт смарт-процессы в CRM клиента, отката нет. Карточка без раскладки —
    // неудобство (поля на месте, видны в списке и фильтрах), а падение здесь оставило бы портал с
    // наполовину созданными сущностями.
    const call = async (method: string) => {
      if (method === 'crm.item.details.configuration.set') throw new Error('нет прав')
      return { result: {} }
    }
    const res = await provisionDistributionSp(call as never, {
      payment: { entityTypeId: 1038, id: 7 },
      distribution: { entityTypeId: 1040, id: 8 }
    })
    expect(res.cardConfigured).toBe(false)
    expect(res.payment.entityTypeId).toBe(1038)
  })
})
