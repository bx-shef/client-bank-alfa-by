import { describe, expect, it, vi } from 'vitest'
import {
  chatDialogId,
  normalizeChatSearch,
  normalizeRecentChats,
  searchChats
} from '../server/utils/chatSearch'

describe('chatDialogId', () => {
  it('builds chat<id> for positive integers', () => {
    expect(chatDialogId(1137)).toBe('chat1137')
    expect(chatDialogId('42')).toBe('chat42')
  })
  it('rejects non-positive / non-integer / junk ids', () => {
    expect(chatDialogId(0)).toBeNull()
    expect(chatDialogId(-5)).toBeNull()
    expect(chatDialogId(1.5)).toBeNull()
    expect(chatDialogId('abc')).toBeNull()
    expect(chatDialogId(undefined)).toBeNull()
  })
})

describe('normalizeChatSearch (im.search.chat.list)', () => {
  it('maps result rows to {value,label}, keeps title, derives hasMore from next', () => {
    const resp = {
      result: [
        { id: 1137, name: 'Проект: разработка' },
        { id: 88, name: 'Бухгалтерия' }
      ],
      total: 5,
      next: 2
    }
    expect(normalizeChatSearch(resp, 0)).toEqual({
      items: [
        { value: 'chat1137', label: 'Проект: разработка' },
        { value: 'chat88', label: 'Бухгалтерия' }
      ],
      hasMore: true,
      nextOffset: 2 // from resp.next (server's next offset)
    })
  })

  it('hasMore falls back to offset+count < total when next absent; nextOffset = offset + RAW rows', () => {
    // 2 rows returned but only 1 kept (one read-only): nextOffset must skip BOTH rows.
    const resp = { result: [{ id: 1, name: 'A' }, { id: 2, name: 'B', restrictions: { send: false } }], total: 3 }
    const page = normalizeChatSearch(resp, 0)
    expect(page.hasMore).toBe(true)
    expect(page.items).toEqual([{ value: 'chat1', label: 'A' }]) // B filtered out
    expect(page.nextOffset).toBe(2) // offset(0) + rows(2), NOT items(1)
    expect(normalizeChatSearch({ result: [{ id: 1, name: 'A' }], total: 1 }, 0).hasMore).toBe(false)
  })

  it('excludes chats that forbid sending, and rows without id/title', () => {
    const resp = {
      result: [
        { id: 1, name: 'ok' },
        { id: 2, name: 'no-send', restrictions: { send: false } },
        { id: 0, name: 'bad-id' },
        { id: 3, name: '' }
      ],
      total: 4
    }
    expect(normalizeChatSearch(resp, 0).items).toEqual([{ value: 'chat1', label: 'ok' }])
  })

  it('empty / malformed result → empty page (no throw)', () => {
    expect(normalizeChatSearch({}, 0)).toEqual({ items: [], hasMore: false })
    expect(normalizeChatSearch({ result: 'nope' } as never, 0)).toEqual({ items: [], hasMore: false })
  })
})

describe('normalizeRecentChats (im.recent.list)', () => {
  it('maps group chats via chat_id, drops 1-1 user dialogs, reads hasMore', () => {
    const resp = {
      result: {
        items: [
          { type: 'chat', chat_id: 1231, title: 'Отдел продаж' },
          { type: 'user', chat_id: 999, title: 'Иван Иванов' },
          { type: 'open', chat_id: 77, title: 'Линия 1' }
        ],
        hasMore: true
      }
    }
    expect(normalizeRecentChats(resp)).toEqual({
      items: [
        { value: 'chat1231', label: 'Отдел продаж' },
        { value: 'chat77', label: 'Линия 1' }
      ],
      hasMore: true
    })
  })

  it('empty / malformed → empty page (no throw)', () => {
    expect(normalizeRecentChats({})).toEqual({ items: [], hasMore: false })
    expect(normalizeRecentChats({ result: { items: 'x' } } as never)).toEqual({ items: [], hasMore: false })
  })
})

describe('searchChats (routing + params)', () => {
  it('query ≥ 3 chars → im.search.chat.list with FIND/OFFSET/LIMIT', async () => {
    const call = vi.fn(async () => ({ result: [{ id: 1, name: 'A' }], total: 1 }))
    const page = await searchChats(call, 'ромаш', 0)
    expect(call).toHaveBeenCalledWith('im.search.chat.list', { FIND: 'ромаш', OFFSET: 0, LIMIT: 20 })
    expect(page.items).toEqual([{ value: 'chat1', label: 'A' }])
  })

  it('short/empty query → im.recent.list single page (SKIP_DIALOG, LIMIT 50, hasMore forced false)', async () => {
    // Even if B24 claims hasMore, the recent list is served as ONE page (im.recent.list
    // OFFSET honouring is unverified) — so the picker never load-mores a stuck cursor.
    const call = vi.fn(async () => ({ result: { items: [{ type: 'chat', chat_id: 5, title: 'C' }], hasMore: true } }))
    const page = await searchChats(call, '', 0)
    expect(call).toHaveBeenCalledWith('im.recent.list', { SKIP_DIALOG: 'Y', OFFSET: 0, LIMIT: 50 })
    expect(page).toEqual({ items: [{ value: 'chat5', label: 'C' }], hasMore: false })
    // a 2-char query is also "too short" → recent, not search
    await searchChats(call, 'аб', 0)
    expect(call).toHaveBeenLastCalledWith('im.recent.list', { SKIP_DIALOG: 'Y', OFFSET: 0, LIMIT: 50 })
  })

  it('passes a positive offset through; clamps junk offset to 0', async () => {
    const call = vi.fn(async () => ({ result: [], total: 0 }))
    await searchChats(call, 'проект', 20)
    expect(call).toHaveBeenLastCalledWith('im.search.chat.list', { FIND: 'проект', OFFSET: 20, LIMIT: 20 })
    await searchChats(call, 'проект', -3)
    expect(call).toHaveBeenLastCalledWith('im.search.chat.list', { FIND: 'проект', OFFSET: 0, LIMIT: 20 })
  })

  it('throws on a REST error body (route maps to a status)', async () => {
    const call = vi.fn(async () => ({ error: 'FIND_SHORT', error_description: 'Too short' }))
    await expect(searchChats(call, 'проект', 0)).rejects.toThrow('Too short')
  })
})
