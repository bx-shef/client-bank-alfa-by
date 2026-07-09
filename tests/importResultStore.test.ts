import { describe, expect, it } from 'vitest'
import type { QueryFn } from '../server/utils/tokenStore'
import type { ImportRunSummary } from '../app/types/importStatus'
import { deleteImportResultForPortal, getImportResult, saveImportResult } from '../server/utils/importResultStore'

// Fake pg over an in-memory {member_id → row} map — exercises the store's SQL branches
// (SELECT/INSERT-upsert/DELETE) without a database.
function fakeStore() {
  const rows: Record<string, Record<string, unknown>> = {}
  const query: QueryFn = async (sql, params) => {
    const p = (params ?? []) as unknown[]
    if (sql.trimStart().startsWith('SELECT')) {
      const row = rows[String(p[0])]
      return row ? [row] : []
    }
    if (sql.trimStart().startsWith('INSERT')) {
      rows[String(p[0])] = {
        state: p[1], last_sync_at: p[2], operations: p[3],
        activities_created: p[4], chat_notified: p[5], errors: JSON.parse(String(p[6]))
      }
      return []
    }
    if (sql.trimStart().startsWith('DELETE')) {
      Reflect.deleteProperty(rows, String(p[0]))
      return []
    }
    return []
  }
  return { query, rows }
}

const run = (over: Partial<ImportRunSummary> = {}): ImportRunSummary => ({
  state: 'ok', lastSyncAt: '2026-07-09T08:00:00.000Z', operations: 5,
  activitiesCreated: 3, chatNotified: 2, errors: [], ...over
})

describe('importResultStore', () => {
  it('returns null when no run recorded', async () => {
    const { query } = fakeStore()
    expect(await getImportResult(query, 'M')).toBeNull()
  })

  it('round-trips a saved run', async () => {
    const { query } = fakeStore()
    await saveImportResult(query, 'M', run())
    expect(await getImportResult(query, 'M')).toEqual({
      state: 'ok', lastSyncAt: '2026-07-09T08:00:00.000Z', operations: 5,
      activitiesCreated: 3, chatNotified: 2, errors: []
    })
  })

  it('upserts — the latest run overwrites the previous (one row per portal)', async () => {
    const { query } = fakeStore()
    await saveImportResult(query, 'M', run({ operations: 5 }))
    await saveImportResult(query, 'M', run({ operations: 9, activitiesCreated: 7 }))
    const got = await getImportResult(query, 'M')
    expect(got).toMatchObject({ operations: 9, activitiesCreated: 7 })
  })

  it('keeps portals isolated by member_id', async () => {
    const { query } = fakeStore()
    await saveImportResult(query, 'A', run({ operations: 1 }))
    await saveImportResult(query, 'B', run({ operations: 2 }))
    expect((await getImportResult(query, 'A'))?.operations).toBe(1)
    expect((await getImportResult(query, 'B'))?.operations).toBe(2)
  })

  it('persists a null lastSyncAt and error list', async () => {
    const { query } = fakeStore()
    await saveImportResult(query, 'M', run({ state: 'error', lastSyncAt: null, errors: ['boom'] }))
    expect(await getImportResult(query, 'M')).toEqual({
      state: 'error', lastSyncAt: null, operations: 5, activitiesCreated: 3, chatNotified: 2, errors: ['boom']
    })
  })

  it('coerces a corrupt stored state/errors defensively', async () => {
    const { query, rows } = fakeStore()
    rows.M = { state: 'garbage', last_sync_at: null, operations: 4, activities_created: 1, chat_notified: 0, errors: 'not-an-array' }
    expect(await getImportResult(query, 'M')).toEqual({
      state: 'never', lastSyncAt: null, operations: 4, activitiesCreated: 1, chatNotified: 0, errors: []
    })
  })

  it('drops non-string entries from a stored errors array', async () => {
    const { query, rows } = fakeStore()
    rows.M = { state: 'error', last_sync_at: null, operations: 0, activities_created: 0, chat_notified: 0, errors: ['ok', 123, null, 'two'] }
    expect((await getImportResult(query, 'M'))?.errors).toEqual(['ok', 'two'])
  })

  it('deletes a portal row (uninstall purge)', async () => {
    const { query } = fakeStore()
    await saveImportResult(query, 'M', run())
    await deleteImportResultForPortal(query, 'M')
    expect(await getImportResult(query, 'M')).toBeNull()
  })
})
