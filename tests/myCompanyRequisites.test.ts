import { describe, expect, it, vi } from 'vitest'
import {
  MAX_MY_COMPANIES, MY_COMPANY_GATE_MESSAGE, findMyCompanyAccounts, myCompanyGate
} from '../server/utils/myCompanyRequisites'

// Первый боевой прогон дал «117 обработано, 117 не опознано, 0 создано» при полностью исправном
// транспорте — потому что искать было нечего: компании «моя» с расчётным счётом в CRM не было
// (#493). На свежем портале контрагенты ещё не заведены, то есть КЛИЕНТ не находится никогда, и
// «моя компания» — единственное, что удерживает платёж в CRM вообще.

function fakeCall(replies: Record<string, unknown>) {
  const seen: { method: string, params: Record<string, unknown> }[] = []
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    seen.push({ method, params })
    return (replies[method] ?? {}) as Record<string, unknown>
  })
  return { call, seen }
}

const MY = { result: { items: [{ id: 7 }] } }
const REQ = { result: [{ ID: '70', ENTITY_ID: '7' }] }

describe('findMyCompanyAccounts', () => {
  it('идёт компания → реквизиты → банковские детали, тремя вызовами', async () => {
    const { call, seen } = fakeCall({
      'crm.item.list': MY,
      'crm.requisite.list': REQ,
      'crm.requisite.bankdetail.list': { result: [{ ENTITY_ID: '70', RQ_ACC_NUM: 'BY00BANK0001' }] }
    })
    await expect(findMyCompanyAccounts(call)).resolves.toEqual([{ companyId: '7', accounts: ['BY00BANK0001'] }])
    expect(seen.map(s => s.method)).toEqual(['crm.item.list', 'crm.requisite.list', 'crm.requisite.bankdetail.list'])
    expect(seen[0]!.params).toMatchObject({ filter: { isMyCompany: 'Y' } })
  })

  it('⚠ номер отдаётся КАК ХРАНИТСЯ — без нормализации', async () => {
    // Поиск в CRM сравнивает значение дословно. Убрав тут пробелы, мы бы дали зелёный гейт при
    // импорте, который всё равно не работает, — а это хуже отсутствия проверки (#494).
    const { call } = fakeCall({
      'crm.item.list': MY,
      'crm.requisite.list': REQ,
      'crm.requisite.bankdetail.list': { result: [{ ENTITY_ID: '70', RQ_ACC_NUM: 'BY00 BANK 0001' }] }
    })
    const [row] = await findMyCompanyAccounts(call)
    expect(row!.accounts).toEqual(['BY00 BANK 0001'])
  })

  it('берёт и RQ_IIK — белорусские порталы заполняют то одно, то другое', async () => {
    const { call } = fakeCall({
      'crm.item.list': MY,
      'crm.requisite.list': REQ,
      'crm.requisite.bankdetail.list': { result: [{ ENTITY_ID: '70', RQ_ACC_NUM: '', RQ_IIK: 'BY00IIK0001' }] }
    })
    const [row] = await findMyCompanyAccounts(call)
    expect(row!.accounts).toEqual(['BY00IIK0001'])
  })

  it('компания есть, реквизитов нет → строка со ПУСТЫМ списком, а не отсутствие компании', async () => {
    // Различие несущее: «нет моей компании» и «есть, но без счёта» чинятся по-разному.
    const { call } = fakeCall({ 'crm.item.list': MY, 'crm.requisite.list': { result: [] } })
    await expect(findMyCompanyAccounts(call)).resolves.toEqual([{ companyId: '7', accounts: [] }])
  })

  it('нет ни одной «моей» компании → пусто и БЕЗ лишних вызовов', async () => {
    const { call, seen } = fakeCall({ 'crm.item.list': { result: { items: [] } } })
    await expect(findMyCompanyAccounts(call)).resolves.toEqual([])
    expect(seen).toHaveLength(1)
  })

  it('число компаний капнуто — фильтр, поймавший сотни, это баг, а не повод веерить запросы', async () => {
    const items = Array.from({ length: MAX_MY_COMPANIES + 5 }, (_, i) => ({ id: i + 1 }))
    const { call, seen } = fakeCall({ 'crm.item.list': { result: { items } }, 'crm.requisite.list': { result: [] } })
    await findMyCompanyAccounts(call)
    expect((seen[1]!.params.filter as { ENTITY_ID: string[] }).ENTITY_ID).toHaveLength(MAX_MY_COMPANIES)
  })

  it('ошибка транспорта ПРОБРАСЫВАЕТСЯ — «не смогли спросить» это не «не настроено»', async () => {
    const call = vi.fn(async () => {
      throw new Error('rest down')
    })
    await expect(findMyCompanyAccounts(call)).rejects.toThrow('rest down')
  })
})

describe('myCompanyGate', () => {
  it('три РАЗНЫХ состояния, потому что чинятся они по-разному', () => {
    expect(myCompanyGate([])).toBe('no-company')
    expect(myCompanyGate([{ companyId: '7', accounts: [] }])).toBe('no-account')
    expect(myCompanyGate([{ companyId: '7', accounts: ['BY1'] }])).toBe('ok')
  })

  it('хватает ОДНОЙ компании со счётом среди нескольких', () => {
    expect(myCompanyGate([{ companyId: '1', accounts: [] }, { companyId: '2', accounts: ['BY1'] }])).toBe('ok')
  })

  it('текст называет ДЕЙСТВИЕ, а не состояние', () => {
    // «no-account» ничего не говорит тому, кто не знает, где живут реквизиты.
    expect(MY_COMPANY_GATE_MESSAGE['no-company']).toContain('Моя компания')
    expect(MY_COMPANY_GATE_MESSAGE['no-account']).toContain('реквизит')
    for (const m of Object.values(MY_COMPANY_GATE_MESSAGE)) expect(m.length).toBeGreaterThan(80)
  })
})

describe('гейт в точках входа (#493)', () => {
  it('подключение банка отклоняется ДО похода в банк', async () => {
    // Смысл именно в порядке: дальше человек введёт пароль от интернет-банка и подтвердит доступ
    // к деньгам компании. Потратить это на настройку, которая не создаст ни одной записи, —
    // самая дорогая ошибка, а не неудобство.
    const { handleBankConnectStart } = await import('../server/utils/bankConnectStart')
    const called: string[] = []
    const r = await handleBankConnectStart({
      memberIdByDomain: async () => 'M1',
      validateFrame: async () => ({ userId: '1', isAdmin: true }),
      config: () => ({ authorizeBase: 'https://bank.test', clientId: 'c', redirectUri: 'https://x/cb', scope: 's' }),
      priorConfig: () => null,
      buildPriorUrl: async () => {
        called.push('prior')
        return 'x'
      },
      secret: 'a'.repeat(32),
      myCompanyGate: async () => 'no-company'
    }, { accessToken: 't', domain: 'p.bitrix24.by', provider: 'alfa-by', accountKey: '', nonce: 'n', nowMs: 1 })
    expect(r.status).toBe(409)
    expect(String(r.body.error)).toContain('Моя компания')
    expect(r.body.reason).toBe('no-company')
    expect(called).toEqual([]) // до банка не дошли
  })

  it('ручная загрузка отклоняется, а НЕ принимается молча', async () => {
    // Иначе файл разберётся, кнопка отработает, интерфейс скажет «принято» — и не создастся ничего.
    const { handleImportUpload } = await import('../server/utils/importIngest')
    const enqueued: unknown[] = []
    const r = await handleImportUpload({
      validateFrame: async () => '1',
      memberIdByDomain: async () => 'M1',
      enqueueParse: async (j) => {
        enqueued.push(j)
        return true
      },
      hash: () => 'h',
      myCompanyGate: async () => 'no-account'
    }, { accessToken: 't', domain: 'p.bitrix24.by', fileName: 'a.txt', bytes: new Uint8Array([1, 2, 3]) })
    expect(r.status).toBe(409)
    expect(String(r.body.error)).toContain('реквизит')
    expect(enqueued).toEqual([]) // в очередь не попало
  })

  it('⚠ не смогли СПРОСИТЬ — пропускаем, а не блокируем исправный портал', async () => {
    // Гейт бережёт время владельца счёта, а не защищает что-то. Заблокировать верно настроенного
    // клиента из-за нашей же неудачи хуже, чем пропустить настроенного неверно: второе чинится
    // на экране готовности, первое со стороны админа не чинится вовсе.
    const { handleImportUpload } = await import('../server/utils/importIngest')
    const enqueued: unknown[] = []
    const r = await handleImportUpload({
      validateFrame: async () => '1',
      memberIdByDomain: async () => 'M1',
      enqueueParse: async (j) => {
        enqueued.push(j)
        return true
      },
      hash: () => 'h',
      myCompanyGate: async () => {
        throw new Error('rest down')
      }
    }, { accessToken: 't', domain: 'p.bitrix24.by', fileName: 'a.txt', bytes: new Uint8Array([1, 2, 3]) })
    expect(r.status).toBe(202)
    expect(enqueued).toHaveLength(1)
  })
})
