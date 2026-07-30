import { describe, expect, it } from 'vitest'
import type { QueryFn } from '../server/utils/tokenStore'
import {
  MAX_BATCH_IDS, deleteBatchesForPortal, getBatchResults, markBatchQueued, saveBatchError, saveBatchResult
} from '../server/utils/importBatchStore'

// Фейковый pg над картой `member|batch → строка`: гоняет ветки SQL стора без БД.
function fakeStore() {
  const rows = new Map<string, Record<string, unknown>>()
  const key = (m: unknown, b: unknown) => `${String(m)}|${String(b)}`
  const query: QueryFn = async (sql, params) => {
    const p = (params ?? []) as unknown[]
    const head = sql.trimStart().slice(0, 6).toUpperCase()
    if (head.startsWith('SELECT')) {
      const ids = (p[1] ?? []) as string[]
      return ids
        .map(id => rows.get(key(p[0], id)))
        .filter((r): r is Record<string, unknown> => Boolean(r))
    }
    if (head.startsWith('INSERT')) {
      const k = key(p[0], p[1])
      const prev = rows.get(k)
      if (sql.includes('VALUES ($1, $2, \'queued\'')) {
        // ON CONFLICT здесь обновляет ТОЛЬКО имя файла — состояние не сбрасывается.
        rows.set(k, prev
          ? { ...prev, file_name: p[2] }
          : { batch_id: p[1], state: 'queued', file_name: p[2], operations: 0, created: 0, notified: 0, unmatched: 0, error: '', updated_at: '2026-07-30T06:00:00.000Z' })
        return []
      }
      if (sql.includes('\'error\'')) {
        rows.set(k, { ...(prev ?? { batch_id: p[1], file_name: '' }), state: 'error', error: p[2], updated_at: '2026-07-30T06:00:00.000Z' })
        return []
      }
      rows.set(k, {
        ...(prev ?? { batch_id: p[1], file_name: '' }),
        state: 'ok', operations: p[2], created: p[3], notified: p[4], unmatched: p[5], error: '',
        updated_at: '2026-07-30T06:00:00.000Z'
      })
      return []
    }
    if (head.startsWith('DELETE')) {
      for (const k of [...rows.keys()]) {
        if (k.startsWith(`${String(p[0])}|`)) rows.delete(k)
      }
      return []
    }
    return []
  }
  return { query, rows }
}

const ID = 'a'.repeat(64)

describe('importBatchStore', () => {
  it('принятая загрузка читается как «в очереди»', async () => {
    const { query } = fakeStore()
    await markBatchQueued(query, 'M', ID, 'v.txt')
    const [row] = await getBatchResults(query, 'M', [ID])
    expect(row?.state).toBe('queued')
    expect(row?.fileName).toBe('v.txt')
  })

  it('повторная загрузка того же файла НЕ сбрасывает готовый итог', async () => {
    // Обработка дедуплицируется по тому же хешу, второго прогона не будет — сброс оставил бы
    // строку висеть в «принято» навсегда.
    const { query } = fakeStore()
    await markBatchQueued(query, 'M', ID, 'v.txt')
    await saveBatchResult(query, 'M', ID, { operations: 5, created: 4, notified: 3, unmatched: 1 })
    await markBatchQueued(query, 'M', ID, 'v.txt')
    const [row] = await getBatchResults(query, 'M', [ID])
    expect(row?.state).toBe('ok')
    expect(row?.created).toBe(4)
  })

  it('провал несёт причину, а успех её стирает', async () => {
    const { query } = fakeStore()
    await saveBatchError(query, 'M', ID, 'Формат не распознан.')
    expect((await getBatchResults(query, 'M', [ID]))[0]).toMatchObject({ state: 'error', error: 'Формат не распознан.' })
    await saveBatchResult(query, 'M', ID, { operations: 2, created: 2, notified: 0, unmatched: 0 })
    expect((await getBatchResults(query, 'M', [ID]))[0]).toMatchObject({ state: 'ok', error: '' })
  })

  it('чужой портал не читает наш итог по тому же ключу', async () => {
    // Ключ — sha256 файла: он не секрет. Границу держит скоуп по member_id.
    const { query } = fakeStore()
    await markBatchQueued(query, 'M', ID, 'v.txt')
    expect(await getBatchResults(query, 'OTHER', [ID])).toEqual([])
  })

  it('пустой список ключей не идёт в БД', async () => {
    let called = 0
    const query: QueryFn = async () => {
      called++
      return []
    }
    expect(await getBatchResults(query, 'M', [])).toEqual([])
    expect(called).toBe(0)
  })

  it('число ключей ограничено', async () => {
    let seen: unknown[] = []
    const query: QueryFn = async (_sql, params) => {
      seen = (params?.[1] ?? []) as unknown[]
      return []
    }
    await getBatchResults(query, 'M', Array.from({ length: MAX_BATCH_IDS + 10 }, (_, i) => String(i)))
    expect(seen).toHaveLength(MAX_BATCH_IDS)
  })

  it('удаление приложения стирает все загрузки портала', async () => {
    const { query, rows } = fakeStore()
    await markBatchQueued(query, 'M', ID, 'v.txt')
    await deleteBatchesForPortal(query, 'M')
    expect(rows.size).toBe(0)
  })
})
