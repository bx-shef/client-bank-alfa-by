import { describe, expect, it } from 'vitest'
import type { QueryFn } from '../server/utils/tokenStore'
import {
  MAX_BATCH_IDS, deleteBatchesForPortal, getBatchResults, markBatchQueued, saveBatchError,
  saveBatchResult, sweepOldBatches
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
        .filter(r => r.user_id === p[2] || r.user_id === '')
    }
    if (head.startsWith('INSERT')) {
      const k = key(p[0], p[1])
      const prev = rows.get(k)
      if (sql.includes('\'queued\'')) {
        // ON CONFLICT сбрасывает строку в «принято» и обнуляет счётчики (#498): повторная загрузка
        // теперь действительно перезапускает обработку, и прошлый итог на экране был бы отчётом об
        // успехе за работу, которая ещё не началась.
        rows.set(k, {
          ...(prev ?? { batch_id: p[1], user_id: p[3] }),
          state: 'queued', file_name: p[2],
          operations: 0, created: 0, notified: 0, unmatched: 0, error: '',
          updated_at: '2026-07-30T06:00:00.000Z'
        })
        return []
      }
      if (sql.includes('\'error\'')) {
        rows.set(k, { ...(prev ?? { batch_id: p[1], file_name: '', user_id: '' }), state: 'error', error: p[2], updated_at: '2026-07-30T06:00:00.000Z' })
        return []
      }
      rows.set(k, {
        ...(prev ?? { batch_id: p[1], file_name: '', user_id: '' }),
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
    await markBatchQueued(query, 'M', ID, 'v.txt', 'U1')
    const [row] = await getBatchResults(query, 'M', [ID], 'U1')
    expect(row?.state).toBe('queued')
    expect(row?.fileName).toBe('v.txt')
  })

  it('повторная загрузка СБРАСЫВАЕТ строку в «принято» и обнуляет счётчики (#498)', async () => {
    // ⚠ Раньше здесь стоял ОБРАТНЫЙ тест — «UPSERT никогда не трогает состояние». Он охранял
    // верное следствие из посылки, которая оказалась багом: повтор дедуплицировался по хешу файла,
    // прогона действительно не было, и сброс повесил бы строку в «принято» навсегда. Дедуп
    // человеческого действия снят (`enqueueParse`/`enqueueCrmSync`), прогон теперь происходит — и
    // прошлое «всё разобрано» на экране стало отчётом об успехе за работу, которая не начиналась.
    //
    // Утверждаем про САМ SQL, а не про поведение своего фейка: фейк можно случайно научить
    // «правильному» поведению, которого в запросе нет.
    let sql = ''
    await markBatchQueued(async (s) => {
      sql = s
      return []
    }, 'M', ID, 'v.txt', 'U1')
    const onConflict = sql.slice(sql.indexOf('ON CONFLICT'))
    expect(onConflict).toMatch(/state\s+= 'queued'/)
    expect(onConflict).toMatch(/operations = 0/)
    expect(onConflict).toMatch(/error\s+= ''/)
    // Чужую строку не перетереть: ключ — хеш файла, он совпадёт у коллеги с тем же файлом.
    expect(onConflict).toMatch(/WHERE import_batch\.user_id = EXCLUDED\.user_id/)
  })

  it('готовый итог сменяется на «принято» при повторной загрузке того же файла', async () => {
    const { query } = fakeStore()
    await markBatchQueued(query, 'M', ID, 'v.txt', 'U1')
    await saveBatchResult(query, 'M', ID, { operations: 117, created: 0, notified: 0, unmatched: 117 })
    expect((await getBatchResults(query, 'M', [ID], 'U1'))[0]?.state).toBe('ok')

    // Оператор настроил портал и загрузил файл заново — экран обязан показать НОВЫЙ прогон.
    await markBatchQueued(query, 'M', ID, 'v.txt', 'U1')
    const [row] = await getBatchResults(query, 'M', [ID], 'U1')
    expect(row?.state).toBe('queued')
    expect(row?.unmatched).toBe(0)
    expect(row?.operations).toBe(0)
  })

  it('провал несёт причину, а успех её стирает', async () => {
    const { query } = fakeStore()
    await saveBatchError(query, 'M', ID, 'Формат не распознан.')
    expect((await getBatchResults(query, 'M', [ID], 'U1'))[0]).toMatchObject({ state: 'error', error: 'Формат не распознан.' })
    await saveBatchResult(query, 'M', ID, { operations: 2, created: 2, notified: 0, unmatched: 0 })
    expect((await getBatchResults(query, 'M', [ID], 'U1'))[0]).toMatchObject({ state: 'ok', error: '' })
  })

  it('скоуп чтения и удаления — в самом WHERE, а не в фильтре после', async () => {
    // Ключ — sha256 ФАЙЛА, то есть не секрет: его подберёт любой, у кого тот же файл. Границу
    // держат member_id и user_id прямо в запросе, иначе чужие строки успели бы покинуть БД.
    const seen: string[] = []
    const q: QueryFn = async (sql) => {
      seen.push(sql)
      return []
    }
    await getBatchResults(q, 'M', [ID], 'U1')
    await deleteBatchesForPortal(q, 'M')
    expect(seen[0]).toMatch(/WHERE member_id = \$1 AND batch_id = ANY/)
    expect(seen[0]).toMatch(/user_id = \$3 OR user_id = ''/)
    expect(seen[1]).toMatch(/DELETE FROM import_batch WHERE member_id = \$1/)
  })

  it('свип удаляет по ВОЗРАСТУ, а не по порталу', async () => {
    let sql = ''
    let params: unknown[] = []
    await sweepOldBatches(async (s, p) => {
      sql = s
      params = p ?? []
      return []
    }, 3)
    expect(sql).toMatch(/updated_at < now\(\) - \(\$1 \|\| ' days'\)::interval/)
    expect(params).toEqual(['3'])
  })

  it('битая строка из БД не роняет чтение', async () => {
    const q: QueryFn = async () => [{ batch_id: ID, state: 'ЧТО-ТО', operations: 'x', updated_at: null }]
    const [row] = await getBatchResults(q, 'M', [ID], 'U1')
    expect(row).toMatchObject({ state: 'queued', operations: 0, fileName: '', updatedAt: null })
  })

  it('пустой список ключей не идёт в БД', async () => {
    let called = 0
    const query: QueryFn = async () => {
      called++
      return []
    }
    expect(await getBatchResults(query, 'M', [], 'U1')).toEqual([])
    expect(called).toBe(0)
  })

  it('число ключей ограничено', async () => {
    let seen: unknown[] = []
    const query: QueryFn = async (_sql, params) => {
      seen = (params?.[1] ?? []) as unknown[]
      return []
    }
    await getBatchResults(query, 'M', Array.from({ length: MAX_BATCH_IDS + 10 }, (_, i) => String(i)), 'U1')
    expect(seen).toHaveLength(MAX_BATCH_IDS)
  })

  it('удаление приложения стирает все загрузки портала', async () => {
    const { query, rows } = fakeStore()
    await markBatchQueued(query, 'M', ID, 'v.txt', 'U1')
    await deleteBatchesForPortal(query, 'M')
    expect(rows.size).toBe(0)
  })
})
