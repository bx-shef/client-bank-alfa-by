import { afterEach, describe, expect, it, vi } from 'vitest'

// Повторная загрузка того же файла — это ПОЧИНКА, а не дубль (#498).
//
// Оператор видит «117 обработано, 0 создано», настраивает портал (отмечает компанию «моей»,
// дописывает реквизит, правит номер счёта) и загружает тот же файл заново. Раньше это молча не
// делало НИЧЕГО: BullMQ дедуплицирует `add` по идентификатору задачи, а завершённая задача держала
// свой id час. Экран при этом показывал прошлое «всё разобрано» — приложение отчитывалось об
// успехе за работу, которую только что отказалось делать.
//
// Здесь проверяется, КАКИЕ завершённые задачи освобождают свой id, а какие нет. Разница по
// источнику существенна: `parse` — это человек, `fetch` — это крон, и дедуп крона держит нагрузку.

process.env.REDIS_URL = 'redis://localhost:6379'

interface FakeJob { state: string, removed: boolean }

const jobs = new Map<string, FakeJob>()
const adds: Array<{ name: string, jobId: string }> = []

vi.mock('bullmq', () => ({
  Queue: class {
    async add(name: string, _data: unknown, opts: Record<string, unknown>) {
      const jobId = String(opts.jobId)
      // Верная модель BullMQ: `add` с занятым идентификатором — ТИХИЙ no-op.
      if (jobs.has(jobId)) return
      jobs.set(jobId, { state: 'waiting', removed: false })
      adds.push({ name, jobId })
    }

    async getJob(jobId: string) {
      const job = jobs.get(jobId)
      if (!job) return null
      return {
        getState: async () => {
          if (job.state === 'throw-on-state') throw new Error('redis blip')
          return job.state
        },
        remove: async () => {
          // Реальный BullMQ отказывается удалять задачу, захваченную воркером, — это и есть тот
          // случай, ради которого стоит `catch`.
          if (job.state === 'locked') throw new Error('Job could not be removed because it is locked by another worker')
          job.removed = true
          jobs.delete(jobId)
        }
      }
    }

    async close() {}
  }
}))

const { enqueueParse, enqueueCrmSync } = await import('../server/queue/producers')

afterEach(() => {
  jobs.clear()
  adds.length = 0
})

const parseJob = { memberId: 'M', providerId: 'manual' as const, fileName: 'v.txt', contentBase64: '', fileHash: 'h1' }
const crmJob = (source: 'parse' | 'fetch') => ({
  memberId: 'M', providerId: 'manual' as const, source, batchId: 'h1', items: []
})

/** Поставить задачу и довести её до нужного финального состояния. */
async function finish(state: 'completed' | 'failed', enqueue: () => Promise<unknown>) {
  await enqueue()
  for (const job of jobs.values()) job.state = state
}

describe('повторная загрузка файла (#498)', () => {
  it('file-parse: завершённая задача НЕ блокирует повторную загрузку', async () => {
    await finish('completed', () => enqueueParse(parseJob))
    adds.length = 0
    await enqueueParse(parseJob)
    expect(adds).toHaveLength(1)
  })

  it('file-parse: упавшая задача тоже освобождает id (не блокирует на сутки)', async () => {
    await finish('failed', () => enqueueParse(parseJob))
    adds.length = 0
    await enqueueParse(parseJob)
    expect(adds).toHaveLength(1)
  })

  it('file-parse: задача В РАБОТЕ по-прежнему дедуплицируется — это защита от двойного клика', async () => {
    await enqueueParse(parseJob) // остаётся в состоянии `waiting`
    adds.length = 0
    await enqueueParse(parseJob)
    expect(adds).toHaveLength(0)
  })

  it('crm-sync из разбора: завершённая задача освобождает id — иначе тупик просто переехал бы на шаг ниже', async () => {
    // Разблокировать только очередь разбора мало: свежий разбор ставит crm-sync с тем же ключом
    // (хеш файла), и оператор смотрел бы, как файл разбирается заново, а в CRM ничего не появляется.
    await finish('completed', () => enqueueCrmSync(crmJob('parse')))
    adds.length = 0
    await enqueueCrmSync(crmJob('parse'))
    expect(adds).toHaveLength(1)
  })

  it('crm-sync из опроса: завершённая задача id НЕ освобождает — этот дедуп держит нагрузку', async () => {
    // batchId опроса — хеш СОДЕРЖИМОГО: тот же id означает буквально те же операции, и повторный
    // прогон перечитывал бы маркеры в Б24 по каждой из них, чтобы прийти к выводу «уже записано».
    await finish('completed', () => enqueueCrmSync(crmJob('fetch')))
    adds.length = 0
    await enqueueCrmSync(crmJob('fetch'))
    expect(adds).toHaveLength(0)
  })

  it('crm-sync из опроса: УПАВШАЯ задача id освобождает — иначе счёт выпал бы из ротации на сутки', async () => {
    await finish('failed', () => enqueueCrmSync(crmJob('fetch')))
    adds.length = 0
    await enqueueCrmSync(crmJob('fetch'))
    expect(adds).toHaveLength(1)
  })
})

describe('unstick не роняет постановку задачи (#498, ревью)', () => {
  // Освобождение id — вспомогательный шаг, а не условие. Если он не удался (воркер перехватил
  // задачу между чтением состояния и удалением, Redis моргнул), поставить задачу всё равно надо:
  // в худшем случае `add` сдедуплицируется — то есть ровно прежнее поведение, а не отказ приёма.
  it('задача захвачена воркером — `add` всё равно вызывается, ошибка не всплывает', async () => {
    await enqueueParse(parseJob)
    for (const job of jobs.values()) job.state = 'locked'
    adds.length = 0
    await expect(enqueueParse(parseJob)).resolves.toBe(true)
    // Задача осталась (её держит воркер), поэтому `add` сдедуплицировался — работа не потеряна.
    expect(jobs.size).toBe(1)
  })

  it('чтение состояния упало — постановка не отменяется', async () => {
    await enqueueParse(parseJob)
    for (const job of jobs.values()) job.state = 'throw-on-state'
    await expect(enqueueParse(parseJob)).resolves.toBe(true)
  })

  it('задачи с таким id уже нет — просто ставим новую', async () => {
    adds.length = 0
    await expect(enqueueParse(parseJob)).resolves.toBe(true)
    expect(adds).toHaveLength(1)
  })
})
