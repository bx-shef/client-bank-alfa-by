import type { QueryFn } from './tokenStore'
import type { AppRatingState } from './appRatingPolicy'
import type { RatingStatusRow } from './appRatingStatus'

// Per-portal app-rating state over an injected QueryFn (testable without a DB). Keyed by member_id,
// like portal_tokens — the rating fact is kept «рядом с авторизацией». All writes are UPSERTs so a
// portal with no row yet is handled transparently. NB: our `QueryFn` returns the rows array
// directly (not a `{ rows }` envelope), so reads index it as an array.

/** Read the rating state for a portal, or null when there is no row yet. */
export async function getRatingState(memberId: string, query: QueryFn): Promise<AppRatingState | null> {
  const rows = await query(
    'SELECT prompted_at, opened_at, reviewed FROM portal_app_rating WHERE member_id=$1',
    [memberId]
  )
  const r = rows[0]
  if (!r) return null
  return {
    promptedAt: r.prompted_at ? new Date(r.prompted_at as string) : null,
    openedAt: r.opened_at ? new Date(r.opened_at as string) : null,
    reviewed: r.reviewed === true
  }
}

/** Stamp prompted_at = now() (the modal was actually shown). Upserts the row. Never touches a
 *  confirmed review (defense-in-depth — the policy already stops prompting a reviewed portal). */
export async function markPrompted(memberId: string, query: QueryFn): Promise<void> {
  await query(
    `INSERT INTO portal_app_rating (member_id, prompted_at) VALUES ($1, now())
     ON CONFLICT (member_id) DO UPDATE SET prompted_at = now(), updated_at = now()
       WHERE portal_app_rating.reviewed = false`,
    [memberId]
  )
}

/** Stamp opened_at = now() (the user clicked «Оценить» → opened the Market page). Upserts the row.
 *  Never overwrites a confirmed review. */
export async function markOpened(memberId: string, query: QueryFn): Promise<void> {
  await query(
    `INSERT INTO portal_app_rating (member_id, opened_at) VALUES ($1, now())
     ON CONFLICT (member_id) DO UPDATE SET opened_at = now(), updated_at = now()
       WHERE portal_app_rating.reviewed = false`,
    [memberId]
  )
}

/** List rating state for every INSTALLED portal (LEFT JOIN → portals with no row yet show as
 *  «not prompted»). NON-SECRET fields only (domain + timestamps, no tokens). Powers the operator
 *  management card on /queues. Capped defensively. */
export async function listRatingStatus(query: QueryFn, limit = 500): Promise<RatingStatusRow[]> {
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5000) : 500
  const rows = await query(
    `SELECT t.member_id, t.domain,
            (EXTRACT(EPOCH FROM r.prompted_at) * 1000)::bigint AS prompted_at_ms,
            (EXTRACT(EPOCH FROM r.opened_at)   * 1000)::bigint AS opened_at_ms,
            COALESCE(r.reviewed, false) AS reviewed
     FROM portal_tokens t
     LEFT JOIN portal_app_rating r ON r.member_id = t.member_id
     ORDER BY t.domain ASC, t.member_id ASC LIMIT $1`,
    [cap]
  )
  return rows.map(r => ({
    memberId: String(r.member_id ?? ''),
    domain: String(r.domain ?? ''),
    promptedAtMs: r.prompted_at_ms == null ? null : Number(r.prompted_at_ms),
    openedAtMs: r.opened_at_ms == null ? null : Number(r.opened_at_ms),
    reviewed: r.reviewed === true
  }))
}

/** MANUAL (owner op): mark a confirmed review → terminal, never prompt again. */
export async function markReviewed(memberId: string, query: QueryFn): Promise<void> {
  await query(
    `INSERT INTO portal_app_rating (member_id, reviewed) VALUES ($1, true)
     ON CONFLICT (member_id) DO UPDATE SET reviewed = true, updated_at = now()`,
    [memberId]
  )
}

/** MANUAL (owner op): clear opened_at AND prompted_at (no review appeared after the verification
 *  window) so the modal shows again on the user's next successful import — «модалка снова
 *  показывается». No-op on a confirmed review. */
export async function clearOpened(memberId: string, query: QueryFn): Promise<void> {
  await query(
    `UPDATE portal_app_rating SET opened_at = NULL, prompted_at = NULL, updated_at = now()
     WHERE member_id = $1 AND reviewed = false`,
    [memberId]
  )
}

/** Purge a portal's rating row on ONAPPUNINSTALL (data minimisation — a removed app keeps nothing). */
export async function deleteRatingForPortal(query: QueryFn, memberId: string): Promise<void> {
  await query(`DELETE FROM portal_app_rating WHERE member_id = $1`, [memberId])
}
