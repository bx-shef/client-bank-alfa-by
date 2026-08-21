import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_FIELDS,
  CRM_ENTITY_TYPE_COMPANY,
  bankDetailFilter,
  extractEntityIds,
  extractItemIds,
  findCompanyByAccount,
  findMyCompanyByAccount,
  matchingEntityIds,
  myCompanyFilter,
  normalizeAccount,
  requisiteFilter,
  type RestCall
} from '../server/utils/companyLookup'

describe('normalizeAccount', () => {
  it('trims and drops internal whitespace', () => {
    expect(normalizeAccount('  BY13 ALFA 3012 3456 7890  ')).toBe('BY13ALFA301234567890')
  })
  it('empty stays empty', () => {
    expect(normalizeAccount('   ')).toBe('')
  })
})

describe('extractEntityIds', () => {
  it('collects ENTITY_ID as strings, skipping empties', () => {
    const resp = { result: [{ ENTITY_ID: 27 }, { ENTITY_ID: '30' }, { ENTITY_ID: '' }, { ENTITY_ID: null }, {}] }
    expect(extractEntityIds(resp)).toEqual(['27', '30'])
  })
  it('tolerates a missing / non-array result', () => {
    expect(extractEntityIds({})).toEqual([])
    expect(extractEntityIds({ result: 'nope' } as unknown as Record<string, unknown>)).toEqual([])
  })
})

describe('filters', () => {
  it('bankDetailFilter targets one account field', () => {
    // ⚠ Поле выбирается вместе с ENTITY_ID: по нему пост-проверка (`matchingEntityIds`) сверяет,
    // что строка НАСТОЯЩЕЕ совпадение — фильтру B24 доверять нельзя (см. её тесты ниже).
    expect(bankDetailFilter('ACC1', 'RQ_ACC_NUM')).toEqual({ filter: { RQ_ACC_NUM: 'ACC1' }, select: ['ENTITY_ID', 'RQ_ACC_NUM'] })
  })
  it('requisiteFilter restricts to company requisites by id array', () => {
    expect(requisiteFilter(['5', '6'])).toEqual({
      filter: { ID: ['5', '6'], ENTITY_TYPE_ID: CRM_ENTITY_TYPE_COMPANY },
      select: ['ENTITY_ID']
    })
  })
})

/** Build a fake RestCall from canned responses keyed by method, recording calls. */
function fakeCall(
  responses: Partial<Record<string, (params: Record<string, unknown>) => Record<string, unknown>>>
): { call: RestCall, calls: { method: string, params: Record<string, unknown> }[] } {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const call: RestCall = async (method, params) => {
    calls.push({ method, params })
    return responses[method]?.(params) ?? { result: [] }
  }
  return { call, calls }
}

describe('matchingEntityIds — фильтру B24 доверять нельзя (замерено вживую)', () => {
  const resp = (rows: Record<string, unknown>[]) => ({ result: rows })

  it('строка с ДРУГИМ значением отбрасывается — неизвестное поле фильтра портал игнорирует молча', () => {
    // ⚠ Замерено на живом портале: фильтр по несуществующему полю возвращает ВСЕ строки. Слепое
    // извлечение превращало «поиск по счёту» в «первая компания портала» — платёж уезжал в чужую
    // карточку с зелёным логом, а при включённом autoDistribute за ним шла бы и мутация.
    const all = resp([
      { ENTITY_ID: '1', RQ_ACC_NUM: 'BY26PJCB0000' },
      { ENTITY_ID: '2', RQ_ACC_NUM: 'BY09ALFA0000' },
      { ENTITY_ID: '3', RQ_ACC_NUM: 'BY11ALFA0001' }
    ])
    expect(matchingEntityIds(all, 'RQ_ACC_NUM', 'BY99NONE0000')).toEqual([])
    expect(matchingEntityIds(all, 'RQ_ACC_NUM', 'BY09ALFA0000')).toEqual(['2'])
  })

  it('подстрочное совпадение по % отбрасывается', () => {
    // ⚠ Замерено: `%30120A%` в ЗНАЧЕНИИ фильтра работает как подстрока. Счёт контрагента приходит
    // из выписки (в ручном пути — из файла), normalizeAccount срезает только пробелы.
    const rows = resp([{ ENTITY_ID: '7', RQ_ACC_NUM: 'BY11ALFA30120A11111111111111' }])
    expect(matchingEntityIds(rows, 'RQ_ACC_NUM', '%30120A%')).toEqual([])
  })

  it('различие ТОЛЬКО в регистре — совпадение: живой фильтр и так матчит регистронезависимо', () => {
    const rows = resp([{ ENTITY_ID: '5', RQ_ACC_NUM: 'BY11ALFA0001' }])
    expect(matchingEntityIds(rows, 'RQ_ACC_NUM', 'by11alfa0001')).toEqual(['5'])
  })

  it('пробелы в ХРАНИМОМ значении не мешают: сравниваются нормализованные формы', () => {
    // Сегодня такая строка серверным фильтром не находится вовсе (#494 looks-same), но если
    // найдётся — отбрасывать её было бы неверно: это тот же счёт.
    const rows = resp([{ ENTITY_ID: '9', RQ_ACC_NUM: 'BY11 ALFA 0001' }])
    expect(matchingEntityIds(rows, 'RQ_ACC_NUM', 'BY11ALFA0001')).toEqual(['9'])
  })

  it('строка БЕЗ запрошенного поля — не совпадение (fail-closed)', () => {
    // select поле запрашивает явно; ответ без него — вне контракта, и доверять ему нельзя.
    expect(matchingEntityIds(resp([{ ENTITY_ID: '4' }]), 'RQ_ACC_NUM', 'X')).toEqual([])
  })

  it('пустой искомый счёт не матчит ничего', () => {
    const rows = resp([{ ENTITY_ID: '1', RQ_ACC_NUM: '' }])
    expect(matchingEntityIds(rows, 'RQ_ACC_NUM', '  ')).toEqual([])
  })
})

describe('findCompanyByAccount', () => {
  it('resolves company via bankdetail → requisite (RQ_ACC_NUM hit)', async () => {
    const { call, calls } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({ result: [{ ENTITY_ID: '11', RQ_ACC_NUM: 'ACC-1' }] }),
      'crm.requisite.list': () => ({ result: [{ ENTITY_ID: '42' }] })
    })
    expect(await findCompanyByAccount('ACC-1', call)).toBe('42')
    // Only the first account field is queried when it hits.
    expect(calls.map(c => c.method)).toEqual(['crm.requisite.bankdetail.list', 'crm.requisite.list'])
    expect(calls[0]!.params).toEqual(bankDetailFilter('ACC-1', 'RQ_ACC_NUM'))
    expect(calls[1]!.params).toEqual(requisiteFilter(['11']))
  })

  it('falls back to RQ_IIK when RQ_ACC_NUM finds nothing', async () => {
    const { call, calls } = fakeCall({
      'crm.requisite.bankdetail.list': params =>
        (params.filter as Record<string, unknown>).RQ_IIK ? { result: [{ ENTITY_ID: '7', RQ_IIK: 'BY13' }] } : { result: [] },
      'crm.requisite.list': () => ({ result: [{ ENTITY_ID: '99' }] })
    })
    expect(await findCompanyByAccount('BY13', call)).toBe('99')
    const fields = calls.filter(c => c.method === 'crm.requisite.bankdetail.list')
      .map(c => Object.keys(c.params.filter as object)[0])
    expect(fields).toEqual([...ACCOUNT_FIELDS])
  })

  it('returns the FIRST company when one account maps to several (RQ_ACC_NUM not unique)', async () => {
    // Confirmed live: the same settlement account can sit on several companies —
    // findCompanyByAccount collects every requisite id and returns the first company.
    const { call, calls } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({
        result: [{ ENTITY_ID: '11', RQ_ACC_NUM: 'ACC-DUP' }, { ENTITY_ID: '12', RQ_ACC_NUM: 'ACC-DUP' }]
      }),
      'crm.requisite.list': () => ({ result: [{ ENTITY_ID: '42' }, { ENTITY_ID: '43' }] })
    })
    expect(await findCompanyByAccount('ACC-DUP', call)).toBe('42')
    expect(calls[1]!.params).toEqual(requisiteFilter(['11', '12']))
  })

  it('проигнорированный фильтр НЕ отдаёт чужую компанию — сквозной кейс, а не юнит хелпера', async () => {
    // ⚠ Сценарий замера: портал вернул ВСЕ реквизиты, как будто фильтра не было. Проверяется
    // именно через findCompanyByAccount: юнит `matchingEntityIds` выше остаётся зелёным и при
    // слепом извлечении в resolveCompanyIdsByAccount (замерено мутацией — фикстуры остальных
    // кейсов несут совпадающие значения, и подмена вызова их не роняла).
    const { call, calls } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({
        result: [
          { ENTITY_ID: '11', RQ_ACC_NUM: 'BY26PJCB0000', RQ_IIK: '' },
          { ENTITY_ID: '12', RQ_ACC_NUM: 'BY09ALFA0000', RQ_IIK: '' }
        ]
      }),
      'crm.requisite.list': () => ({ result: [{ ENTITY_ID: '42' }, { ENTITY_ID: '43' }] })
    })
    expect(await findCompanyByAccount('BY99NONE0000', call)).toBeNull()
    // …и до второго шага дело не дошло: сверять с реквизитами нечего.
    expect(calls.some(c => c.method === 'crm.requisite.list')).toBe(false)
  })

  it('returns null when no bank detail matches (no requisite query made)', async () => {
    const { call, calls } = fakeCall({ 'crm.requisite.bankdetail.list': () => ({ result: [] }) })
    expect(await findCompanyByAccount('NOPE', call)).toBeNull()
    expect(calls.some(c => c.method === 'crm.requisite.list')).toBe(false)
  })

  it('returns null when the requisite is not a company', async () => {
    const { call } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({ result: [{ ENTITY_ID: '11', RQ_ACC_NUM: 'ACC-1' }] }),
      'crm.requisite.list': () => ({ result: [] }) // ENTITY_TYPE_ID=4 filter excluded it
    })
    expect(await findCompanyByAccount('ACC-1', call)).toBeNull()
  })

  it('a REST error thrown by call propagates (not swallowed as a miss)', async () => {
    const call: RestCall = async () => {
      throw new Error('QUERY_LIMIT_EXCEEDED')
    }
    await expect(findCompanyByAccount('ACC-1', call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })

  it('an error-SHAPED body (no result) reads as a miss — documents the RestCall contract', async () => {
    // If a binding resolves with B24's {error,...} shape instead of throwing, the
    // lookup cannot tell it from "nothing found". RestCall MUST throw on error.
    const { call } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({ error: 'insufficient_scope', error_description: 'need crm' })
    })
    expect(await findCompanyByAccount('ACC-1', call)).toBeNull()
  })

  it('returns null for an empty account without calling REST', async () => {
    const { call, calls } = fakeCall({})
    expect(await findCompanyByAccount('   ', call)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('normalizes the account before querying', async () => {
    const { call, calls } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({ result: [{ ENTITY_ID: '1', RQ_ACC_NUM: 'ACC1' }] }),
      'crm.requisite.list': () => ({ result: [{ ENTITY_ID: '2' }] })
    })
    await findCompanyByAccount(' AC C1 ', call)
    expect((calls[0]!.params.filter as Record<string, unknown>).RQ_ACC_NUM).toBe('ACC1')
  })
})

describe('myCompanyFilter', () => {
  it('filters companies by id IN-list AND isMyCompany=Y', () => {
    expect(myCompanyFilter(['5', '7'])).toEqual({
      entityTypeId: CRM_ENTITY_TYPE_COMPANY,
      filter: { id: ['5', '7'], isMyCompany: 'Y' },
      select: ['id']
    })
  })
})

describe('extractItemIds', () => {
  it('pulls result.items[].id and tolerates a missing/!array shape', () => {
    expect(extractItemIds({ result: { items: [{ id: 5 }, { id: 7 }] } })).toEqual(['5', '7'])
    expect(extractItemIds({})).toEqual([])
    expect(extractItemIds({ result: {} })).toEqual([])
    expect(extractItemIds({ result: { items: 'x' } })).toEqual([])
    expect(extractItemIds({ result: { items: [{ id: '' }] } })).toEqual([])
  })
})

describe('findMyCompanyByAccount', () => {
  it('resolves OUR company (isMyCompany=Y) for our account', async () => {
    const { call, calls } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({ result: [{ ENTITY_ID: '11', RQ_ACC_NUM: 'OUR-ACC' }] }),
      'crm.requisite.list': () => ({ result: [{ ENTITY_ID: '89' }] }),
      'crm.item.list': () => ({ result: { items: [{ id: '89' }] } })
    })
    expect(await findMyCompanyByAccount('OUR-ACC', call)).toBe('89')
    // The my-company filter is the 3rd call, over the resolved company ids.
    expect(calls[2]!.method).toBe('crm.item.list')
    expect(calls[2]!.params).toEqual(myCompanyFilter(['89']))
  })

  it('returns null when the account resolves only to client (not-my) companies', async () => {
    const { call } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({ result: [{ ENTITY_ID: '11', RQ_ACC_NUM: 'CLIENT-ACC' }] }),
      'crm.requisite.list': () => ({ result: [{ ENTITY_ID: '42' }] }),
      'crm.item.list': () => ({ result: { items: [] } }) // isMyCompany=Y filter excluded it
    })
    expect(await findMyCompanyByAccount('CLIENT-ACC', call)).toBeNull()
  })

  it('picks my company among SEVERAL resolved companies (shared account)', async () => {
    const { call, calls } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({
        result: [{ ENTITY_ID: '11', RQ_ACC_NUM: 'SHARED' }, { ENTITY_ID: '12', RQ_ACC_NUM: 'SHARED' }]
      }),
      'crm.requisite.list': () => ({ result: [{ ENTITY_ID: '42' }, { ENTITY_ID: '89' }] }),
      'crm.item.list': () => ({ result: { items: [{ id: '89' }] } }) // only 89 is ours
    })
    expect(await findMyCompanyByAccount('SHARED', call)).toBe('89')
    expect(calls[2]!.params).toEqual(myCompanyFilter(['42', '89'])) // whole set goes to the filter
  })

  it('returns null and skips the my-company query when no company owns the account', async () => {
    const { call, calls } = fakeCall({ 'crm.requisite.bankdetail.list': () => ({ result: [] }) })
    expect(await findMyCompanyByAccount('NOPE', call)).toBeNull()
    expect(calls.some(c => c.method === 'crm.item.list')).toBe(false)
  })

  it('propagates a REST error thrown by the my-company (crm.item.list) call', async () => {
    const call: RestCall = async (method) => {
      if (method === 'crm.requisite.bankdetail.list') return { result: [{ ENTITY_ID: '11', RQ_ACC_NUM: 'OUR-ACC' }] }
      if (method === 'crm.requisite.list') return { result: [{ ENTITY_ID: '89' }] }
      throw new Error('QUERY_LIMIT_EXCEEDED')
    }
    await expect(findMyCompanyByAccount('OUR-ACC', call)).rejects.toThrow('QUERY_LIMIT_EXCEEDED')
  })

  it('an error-SHAPED my-company body (no result) reads as «not mine» → null', async () => {
    const { call } = fakeCall({
      'crm.requisite.bankdetail.list': () => ({ result: [{ ENTITY_ID: '11' }] }),
      'crm.requisite.list': () => ({ result: [{ ENTITY_ID: '89' }] }),
      'crm.item.list': () => ({ error: 'insufficient_scope', error_description: 'need crm' })
    })
    expect(await findMyCompanyByAccount('OUR-ACC', call)).toBeNull()
  })

  it('returns null for an empty account without calling REST', async () => {
    const { call, calls } = fakeCall({})
    expect(await findMyCompanyByAccount('   ', call)).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
