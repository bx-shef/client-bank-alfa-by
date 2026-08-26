import { describe, expect, it } from 'vitest'
import { handleSetupStatus, type SetupStatusDeps } from '../server/utils/setupStatus'

// Server half of the setup checklist (#409/#405). Same gate as the bank routes — the answer
// describes the portal's configuration posture, which is admin business.

function deps(over: Partial<SetupStatusDeps> = {}): SetupStatusDeps {
  return {
    memberIdByDomain: async () => 'M1',
    validateFrame: async () => ({ userId: '7', isAdmin: true }),
    countAccounts: async () => ({ connected: 2, pending: 0 }),
    pollEnabled: true,
    pollIntervalMin: 5,
    lastRunMs: async () => 1_700_000_000_000,
    ...over
  }
}

const input = { accessToken: 't', domain: 'p.bitrix24.by' }

describe('handleSetupStatus', () => {
  it('returns only what the browser cannot know', async () => {
    const res = await handleSetupStatus(deps(), input)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      connectedAccounts: 2,
      pendingAccounts: 0,
      // Сколько подключений приложение уже считает нерабочими (#504) — браузер этого знать не
      // может, а без этого «Банк подключён» горит зелёным на сломанном подключении.
      unhealthyAccounts: 0,
      // Сколько подключений приостановлено администратором (#576). ⚠ Отдельно от «не работает»:
      // это выбор, а не поломка, — но и молчать нельзя, иначе при всех счетах на паузе строка
      // «Автоопрос: каждые N мин» была бы ложью.
      pausedAccounts: 0,
      pollEnabled: true,
      pollIntervalMin: 5,
      lastRunMs: 1_700_000_000_000
    })
    // Portal settings stay with the client — a server copy could disagree with the open form.
    expect(JSON.stringify(res.body)).not.toContain('dialogId')
  })

  it('отдаёт слот misconfig карты распознавания, но НЕ английский detail портала (#595)', async () => {
    const res = await handleSetupStatus(
      deps({ recognitionMisconfig: async () => 'deal-field|field|Field UF_CRM_X not found' }),
      input
    )
    expect(res.body.recognitionMisconfig).toEqual({ slot: 'deal-field' })
    // Английский текст портала бухгалтеру бесполезен и остаётся только в логе.
    expect(JSON.stringify(res.body)).not.toContain('UF_CRM_X')
    expect(JSON.stringify(res.body)).not.toContain('not found')
  })

  it('без наблюдения misconfig ключа в ответе нет вовсе (#595)', async () => {
    const res = await handleSetupStatus(deps({ recognitionMisconfig: async () => null }), input)
    expect('recognitionMisconfig' in res.body).toBe(false)
  })

  it('reports a never-polled portal as lastRunMs: null rather than inventing a time', async () => {
    const res = await handleSetupStatus(deps({ lastRunMs: async () => null }), input)
    expect(res.body.lastRunMs).toBeNull()
  })

  it('reports the poll gate honestly when it is off', async () => {
    const res = await handleSetupStatus(deps({ pollEnabled: false }), input)
    expect(res.body.pollEnabled).toBe(false)
  })

  it('отдаёт счётчик незавершённых подключений отдельно (#407)', () => {
    // Считать их «подключёнными счетами» нельзя (с них ничего не забрать), молчать о них — тоже.
    return handleSetupStatus(deps({ countAccounts: async () => ({ connected: 1, pending: 2 }) }), input)
      .then((res) => {
        expect(res.body.connectedAccounts).toBe(1)
        expect(res.body.pendingAccounts).toBe(2)
      })
  })

  it('is 400 without frame auth, 409 for an unknown portal', async () => {
    expect((await handleSetupStatus(deps(), { accessToken: '', domain: '' })).status).toBe(400)
    expect((await handleSetupStatus(deps({ memberIdByDomain: async () => null }), input)).status).toBe(409)
  })

  it('is 403 on a token that is not this portal (domain spoofing)', async () => {
    const d = deps({
      validateFrame: async () => {
        throw new Error('nope')
      }
    })
    expect((await handleSetupStatus(d, input)).status).toBe(403)
  })

  it('is 403 for a non-admin — and reads nothing', async () => {
    let read = false
    const d = deps({
      validateFrame: async () => ({ userId: '9', isAdmin: false }),
      countAccounts: async () => {
        read = true
        return { connected: 1, pending: 0 }
      }
    })
    expect((await handleSetupStatus(d, input)).status).toBe(403)
    expect(read).toBe(false)
  })
})

describe('счётчик нерабочих подключений доезжает до ответа (#504)', () => {
  // ⚠ Проверка «в дефолтном случае там ноль» ничего не доказывает: захардкоженная константа
  // проходит её ровно так же. А цена незаметности тут высокая — роут продолжает честно СЧИТАТЬ
  // нерабочие подключения, но докладывает, что всё хорошо, и экран готовности снова красит
  // «Банк подключён» зелёным на подключении, по которому импорт уже стоит.
  it('сколько насчитали — столько и отдали', async () => {
    const res = await handleSetupStatus(
      deps({ countAccounts: async () => ({ connected: 3, pending: 1, unhealthy: 2 }) }),
      input
    )
    expect(res.body).toMatchObject({ connectedAccounts: 3, pendingAccounts: 1, unhealthyAccounts: 2 })
  })

  it('старый источник без поля — ноль, а не падение', async () => {
    const res = await handleSetupStatus(
      deps({ countAccounts: async () => ({ connected: 1, pending: 0 }) }),
      input
    )
    expect(res.body.unhealthyAccounts).toBe(0)
  })
})

// ⚠ #46: серверный fail-open ключа `spFieldNames`. Держала его ТОЛЬКО проза, а мутация
// `...(spFieldNames ? {…} : {})` → `spFieldNames: spFieldNames ?? []` оставляла весь набор
// зелёным и красила КАЖДЫЙ портал: пустой список читается ядром как «нет ни одного поля реестра»,
// то есть экран уверенно посылает чинить исправное. Находка ревью.
describe('поля смарт-процесса: ключ появляется только когда реально спросили (#46)', () => {
  const withFields = { ...input, wantFields: true }

  it('деп не задан — ключа нет', async () => {
    const res = await handleSetupStatus(deps(), withFields)
    expect(res.body).not.toHaveProperty('spFieldNames')
  })

  it('деп вернул null (портал не ответил) — ключа нет, а не пустой список', async () => {
    const res = await handleSetupStatus(deps({ spFieldNames: async () => null }), withFields)
    expect(res.body).not.toHaveProperty('spFieldNames')
  })

  it('деп упал — ключа нет, остальной ответ цел', async () => {
    const res = await handleSetupStatus(
      deps({ spFieldNames: async () => { throw new Error('портал молчит') } }), withFields)
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('spFieldNames')
    expect(res.body.connectedAccounts).toBe(2)
  })

  it('портал ответил — имена уезжают как есть', async () => {
    const res = await handleSetupStatus(deps({ spFieldNames: async () => ['ufCrm13Total'] }), withFields)
    expect(res.body.spFieldNames).toEqual(['ufCrm13Total'])
  })

  // ⚠ Дорогая проверка (два REST в портал) спрашивается ТОЛЬКО по явному запросу: `/app` зовёт тот
  // же маршрут на каждом открытии, а строки смарт-процессов у него нет вовсе.
  it('без запроса поля НЕ спрашиваются вовсе — деп не зовут', async () => {
    let called = 0
    const res = await handleSetupStatus(
      deps({
        spFieldNames: async () => {
          called++
          return ['ufCrm13Total']
        }
      }), input)
    expect(called, 'деп не должен вызываться без wantFields').toBe(0)
    expect(res.body).not.toHaveProperty('spFieldNames')
  })
})
