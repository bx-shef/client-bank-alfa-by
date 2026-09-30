import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Проводка МАРШРУТА `server/api/b24/events.post.ts` для события о служебном пользователе
// (ONAPPUSERREADY, решение владельца 2026-09-29). Чистое ядро (`handleEventRequest`) покрыто своими
// тестами; здесь — то единственное место, где оно соединяется с живыми потолком несверенных заявок,
// записью в базу и строкой журнала. До QA-ревью #783 маршрут не загружал ни один тест: проводку можно
// было выключить или перепутать, и весь набор оставался зелёным.
//
// Подменены глобалы Nitro (`defineEventHandler` — тождественная функция), база, очередь и Redis.

const h = vi.hoisted(() => ({
  state: {
    storedToken: '',
    raw: '',
    enqueueImpl: async (): Promise<boolean> => true,
    incrImpl: async (): Promise<number> => 1
  },
  queries: [] as Array<{ sql: string, params: unknown[] }>,
  incrCalls: [] as Array<[string, number]>,
  enqueued: [] as unknown[],
  status: [] as number[]
}))

vi.mock('../server/db/client', () => ({
  dbQuery: async (sql: string, params: unknown[]) => {
    h.queries.push({ sql, params })
    if (/SELECT application_token/.test(sql)) return h.state.storedToken ? [{ application_token: h.state.storedToken }] : []
    if (/UPDATE portal_tokens SET system_user_id/.test(sql)) return [{ member_id: params[0] }]
    return []
  }
}))
vi.mock('../server/queue/producers', () => ({
  enqueueEvent: async (job: unknown) => {
    h.enqueued.push(job)
    return h.state.enqueueImpl()
  },
  enqueueDeletion: async () => false
}))
vi.mock('../server/queue/connection', () => ({
  incrementWithTtl: async (key: string, ttl: number) => {
    h.incrCalls.push([key, ttl])
    return h.state.incrImpl()
  }
}))

const TOKEN = 'appTok123'
const WIRE = 'event=ONAPPUSERREADY&data[user_id]=512&data[member_id]=m1&ts=1756890123'
  + `&auth[domain]=p.bitrix24.ru&auth[member_id]=m1&auth[user_id]=1&auth[application_token]=${TOKEN}`

let route: (e: unknown) => Promise<unknown>
beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('readRawBody', async () => h.state.raw)
  vi.stubGlobal('setResponseStatus', (_e: unknown, s: number) => {
    h.status.push(s)
  })
  route = (await import('../server/api/b24/events.post')).default as never
}, 60_000)
afterAll(() => {
  vi.unstubAllGlobals()
})
beforeEach(() => {
  h.queries.length = 0
  h.incrCalls.length = 0
  h.enqueued.length = 0
  h.status.length = 0
  h.state.raw = WIRE
  h.state.storedToken = ''
  h.state.enqueueImpl = async () => true
  h.state.incrImpl = async () => 1
})

/** Прогнать маршрут и вернуть то, что он написал в журнал (серверный логгер пишет в stdout). */
async function runAndCaptureLog(): Promise<string> {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    chunks.push(String(c))
    return true
  })
  try {
    await route({})
  } finally {
    spy.mockRestore()
  }
  return chunks.join('')
}

describe('маршрут событий: служебный пользователь', () => {
  it('сверенная заявка при упавшем Redis пишется в базу — адресно, портал и id не перепутаны', async () => {
    h.state.storedToken = TOKEN
    h.state.enqueueImpl = async () => {
      throw new Error('ECONNREFUSED')
    }
    await route({})
    const update = h.queries.find(q => /UPDATE portal_tokens SET system_user_id/.test(q.sql))
    expect(update?.params).toEqual(['m1', 512])
  })

  it('несверенная заявка проходит через НАСТОЯЩИЙ потолок — со счётчиком текущей минуты', async () => {
    // Подменены только часы, таймеры живые (у потолка свой дедлайн на setTimeout). Без фиксации
    // граница минуты между вызовом маршрута и проверкой изредка разводила бы ключи.
    const now = Date.parse('2026-09-30T12:00:30Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    try {
      await route({})
    } finally {
      vi.useRealTimers()
    }
    expect(h.incrCalls).toHaveLength(1)
    const [key, ttl] = h.incrCalls[0]!
    expect(key).toBe(`sysuser-deferred:${Math.floor(now / 60_000)}`) // часы маршрута, а не константа
    expect(ttl).toBeGreaterThan(60)
    expect(h.enqueued).toHaveLength(1) // счёт 1 — пускаем
  })

  it('сверх потолка — 503, в очередь ничего', async () => {
    h.state.incrImpl = async () => 31
    await route({})
    expect(h.status.at(-1)).toBe(503)
    expect(h.enqueued).toHaveLength(0)
  })

  it('в журнале несверенная заявка названа хешем портала, а не member_id из чужого запроса', async () => {
    const text = await runAndCaptureLog() // токена в базе нет — заявка не сверена
    expect(text).toMatch(/system-user portal=[0-9a-f]+ unverified/)
    expect(text).not.toContain('m1')
  })

  it('сверенная заявка в журнале — по member_id: он уже проверен токеном приложения', async () => {
    h.state.storedToken = TOKEN
    expect(await runAndCaptureLog()).toContain('system-user member_id=m1')
  })
})
