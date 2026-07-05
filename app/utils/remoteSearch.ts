// Pure core for remote (server-backed) autocomplete — the logic behind
// `useRemoteSearch` / `AsyncSearchSelect`. No Vue, no I/O: term gating,
// page merging, "load more" math. The reactive orchestration (debounce,
// request race, loading state) lives in the composable; the transport (a
// fetcher hitting a backend proxy) is injected by the caller.
//
// This pattern repeats across the app (pick a chat, a company, a deal, an
// invoice, a user), so the decisions live here once, under test.

/** One page of results from a remote source. "More pages exist?" can be signalled
 *  two ways so the contract fits both API styles:
 *  - `total` — grand total across all pages (e.g. `im.search.chat.list` returns it);
 *    more exist while `loaded < total`;
 *  - `hasMore` — an explicit flag (for cursor/next-token APIs with no grand total).
 *  If `hasMore` is given it wins; else `total` is used; if neither, there is no
 *  next page. `items` alone (no total/hasMore) ⇒ a single, complete page. */
export interface RemoteSearchPage<T> {
  items: T[]
  /** Total matches on the server for this query (across all pages), if known. */
  total?: number
  /** Explicit "more pages exist" flag; overrides `total` when present. */
  hasMore?: boolean
  /** Raw offset to request for the NEXT page. Give this when the source filters or
   *  transforms rows (so kept-item count ≠ rows consumed) — the paginator then
   *  advances by rows the server consumed, not by accumulated items. Omit for
   *  simple sources where offset == items loaded so far. */
  nextOffset?: number
}

/** Transport the composable drives: given a query and an offset (how many rows
 *  are already loaded), return the next page. Empty query ⇒ the "default" list
 *  (e.g. recent items). An optional AbortSignal lets the caller cancel a stale
 *  in-flight request. */
export type RemoteSearchFetcher<T> = (
  query: string,
  offset: number,
  signal?: AbortSignal
) => Promise<RemoteSearchPage<T>>

/** Trim a raw search term (what the user typed). Collapse is intentionally NOT
 *  done — inner spaces can be meaningful (a chat titled "АО Ромашка"). */
export function normalizeSearchTerm(raw: string): string {
  return raw.trim()
}

/**
 * Is a term ready to hit the network?
 * - empty ⇒ yes (fetch the default/recent list);
 * - ≥ minChars ⇒ yes (real search);
 * - 1..minChars-1 ⇒ no (too short — show a "type more" hint, don't spam the API).
 *
 * `minChars` ≤ 0 means "no minimum" (every term, including 1 char, searches).
 */
export function isQueryReady(term: string, minChars: number): boolean {
  if (term.length === 0) return true
  if (minChars <= 0) return true
  return term.length >= minChars
}

/**
 * Merge a freshly fetched page onto the accumulated list for "load more"
 * pagination, de-duplicating by a stable key (keeps the first occurrence and
 * original order). Guards against a server returning an overlapping window.
 */
export function mergePages<T>(existing: T[], incoming: T[], keyOf: (x: T) => string): T[] {
  const seen = new Set(existing.map(keyOf))
  const merged = existing.slice()
  for (const it of incoming) {
    const k = keyOf(it)
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(it)
  }
  return merged
}

/** Are there more results to load beyond what's already loaded, by total count? */
export function hasMoreResults(loaded: number, total: number): boolean {
  return loaded < total
}

/**
 * Resolve "are there more pages?" from a page's signals (see RemoteSearchPage):
 * explicit `hasMore` wins, else `total` (loaded < total), else false. Used by the
 * composable so both count-based and cursor-based sources work through one path.
 */
export function resolveHasMore(loaded: number, page: { total?: number, hasMore?: boolean }): boolean {
  if (typeof page.hasMore === 'boolean') return page.hasMore
  if (typeof page.total === 'number') return hasMoreResults(loaded, page.total)
  return false
}
