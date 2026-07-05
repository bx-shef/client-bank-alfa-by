// Backend proxy core for the chat picker (#16): search a portal's chats to pick a
// notification / error target. Pure over an injected `call(method, params)` so it
// unit-tests without the network; the route binds the real transport + identity.
//
// Two B24 methods, one normalized shape ({ value: dialogId, label: title }):
//   - non-empty query (≥3 chars) → im.search.chat.list (FIND/OFFSET/LIMIT, returns
//     result[]/total/next);
//   - empty query → im.recent.list (recent dialogs, SKIP_DIALOG=Y so 1-1 chats are
//     excluded — we post to group chats/channels, not to a person).
// Only chats we may post to are kept (restrictions.send / can_post honoured). The
// stored value is the B24 DIALOG_ID for a chat: `chat<id>` (what im.message.add wants).
//
// See docs/REST_METHODS.md for the identity note (search + send must use the same
// token). Both methods are NOT batchable, so each call is standalone.

// Reuse the shared REST-call type (Nuxt auto-imports server/utils into one
// namespace, so re-declaring/re-exporting `RestCall` here would collide with
// companyLookup's — import it type-only, no re-export).
import type { RestCall } from './companyLookup'

/** One pickable chat: `value` is the B24 DIALOG_ID (`chat<id>`), `label` its title. */
export interface ChatOption {
  value: string
  label: string
}

/** A page of chat options plus whether more pages exist (for the picker).
 *  `nextOffset` is the RAW server offset to request for the next page — the client
 *  must advance by rows the SERVER consumed, not by kept items, or filtered rows
 *  (`send:false`) desync the offset and hide later chats. Present only when `hasMore`. */
export interface ChatSearchPage {
  items: ChatOption[]
  hasMore: boolean
  nextOffset?: number
}

/** Min chars before a non-empty query searches (im.search.chat.list requires ≥3). */
export const CHAT_SEARCH_MIN = 3
/** Page size for the paginated search (im.search.chat.list caps at 50). */
export const CHAT_SEARCH_LIMIT = 20
/** Page size for the default recent list (single page — see searchChats). */
export const CHAT_RECENT_LIMIT = 50

/** Build a chat DIALOG_ID (`chat<id>`) from a numeric id, or null if not a positive
 *  integer (defends against malformed rows — a bad id must not become a target). */
export function chatDialogId(id: unknown): string | null {
  const n = typeof id === 'number' ? id : Number(id)
  return Number.isInteger(n) && n > 0 ? `chat${n}` : null
}

/** True unless the chat explicitly forbids sending (default: allowed). Reads
 *  `restrictions.send` (im.search.chat.list) — only `false` excludes it. */
function canSend(chat: Record<string, unknown>): boolean {
  const r = chat.restrictions as Record<string, unknown> | undefined
  return !(r && r.send === false)
}

/** Normalize an im.search.chat.list response into a page. `offset` is the request
 *  offset (to derive hasMore from `total` when `next` is absent). */
export function normalizeChatSearch(resp: Record<string, unknown>, offset: number): ChatSearchPage {
  const rows = Array.isArray(resp.result) ? resp.result as Record<string, unknown>[] : []
  const items: ChatOption[] = []
  for (const row of rows) {
    if (!canSend(row)) continue
    const value = chatDialogId(row.id)
    const label = String(row.name ?? '').trim()
    if (value && label) items.push({ value, label })
  }
  // More pages: `next` (server's next offset) when present, else offset+rows < total.
  // NB use rows.length (RAW rows the server returned), not items.length — the next
  // offset must skip everything the server already yielded, including filtered rows.
  const total = Number(resp.total)
  const serverNext = Number(resp.next)
  const hasMore = resp.next != null || (Number.isFinite(total) && offset + rows.length < total)
  const nextOffset = Number.isFinite(serverNext) ? serverNext : offset + rows.length
  return hasMore ? { items, hasMore, nextOffset } : { items, hasMore }
}

/** Normalize an im.recent.list response (result.items) into a page of group chats.
 *  1-1 user dialogs are dropped (type === 'user') as a guard on top of SKIP_DIALOG. */
export function normalizeRecentChats(resp: Record<string, unknown>): ChatSearchPage {
  const result = (resp.result ?? {}) as Record<string, unknown>
  const rows = Array.isArray(result.items) ? result.items as Record<string, unknown>[] : []
  const items: ChatOption[] = []
  for (const row of rows) {
    if (row.type === 'user') continue
    const value = chatDialogId(row.chat_id ?? row.id)
    const label = String(row.title ?? '').trim()
    if (value && label) items.push({ value, label })
  }
  return { items, hasMore: Boolean(result.hasMore) }
}

/** Throw on a REST error body so the route can map it to a status. */
function assertOk(resp: Record<string, unknown>, method: string): void {
  if (resp && resp.error) {
    throw new Error(`${method}: ${String(resp.error_description ?? resp.error)}`)
  }
}

/**
 * Search a portal's chats: non-empty query → im.search.chat.list; empty query →
 * recent group chats. `call` carries the identity (see the route). Pure otherwise.
 */
export async function searchChats(
  call: RestCall,
  query: string,
  offset: number,
  limit: number = CHAT_SEARCH_LIMIT
): Promise<ChatSearchPage> {
  const q = query.trim()
  const off = Number.isInteger(offset) && offset > 0 ? offset : 0
  if (q.length >= CHAT_SEARCH_MIN) {
    const resp = await call('im.search.chat.list', { FIND: q, OFFSET: off, LIMIT: limit })
    assertOk(resp, 'im.search.chat.list')
    return normalizeChatSearch(resp, off)
  }
  // Empty/short query → recent group chats as the default list. im.recent.list is
  // cursor-based (LAST_MESSAGE_DATE); its OFFSET honouring is unverified on a live
  // portal, so we serve a SINGLE larger page (no load-more) rather than risk a
  // stuck "load more" that refetches page 0. Typing ≥3 chars switches to the
  // paginated im.search.chat.list. (Follow-up: real OFFSET/date paging once verified.)
  const resp = await call('im.recent.list', { SKIP_DIALOG: 'Y', OFFSET: 0, LIMIT: CHAT_RECENT_LIMIT })
  assertOk(resp, 'im.recent.list')
  return { items: normalizeRecentChats(resp).items, hasMore: false }
}
