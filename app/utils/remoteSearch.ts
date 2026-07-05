// Pure core for remote (server-backed) autocomplete — the logic behind
// `useRemoteSearch` / `AsyncSearchSelect`. No Vue, no I/O: term gating,
// page merging, "load more" math. The reactive orchestration (debounce,
// request race, loading state) lives in the composable; the transport (a
// fetcher hitting a backend proxy) is injected by the caller.
//
// This pattern repeats across the app (pick a chat, a company, a deal, an
// invoice, a user), so the decisions live here once, under test.

/** One page of results from a remote source: the rows plus the grand total
 *  (so we know whether more pages exist). `total` may exceed `items.length`. */
export interface RemoteSearchPage<T> {
  items: T[]
  /** Total matches on the server for this query (across all pages). */
  total: number
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

/** Are there more results to load beyond what's already loaded? */
export function hasMoreResults(loaded: number, total: number): boolean {
  return loaded < total
}
