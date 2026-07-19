// Pure status model for the operator «оценки приложения» card (manage, don't SQL). Maps each
// installed portal's rating row into a single derived state the owner acts on, WITHOUT exposing any
// secret. No I/O → unit-tested. The store SELECT feeding it returns only domain + timestamps.

/** One portal's raw rating row (non-secret) — from appRatingStore.listRatingStatus. */
export interface RatingStatusRow {
  memberId: string
  domain: string
  /** ms epoch the modal was last shown, or null. */
  promptedAtMs: number | null
  /** ms epoch the user clicked «Оценить», or null. */
  openedAtMs: number | null
  reviewed: boolean
}

/** Derived lifecycle state, in priority order. */
export type RatingState
  = | 'reviewed' // отзыв подтверждён вручную — терминально
    | 'opened' // нажал «Оценить» → ждёт ручной проверки факта отзыва
    | 'prompted' // попап показывали, но не открыл Маркет
    | 'none' // ещё не показывали

/** One portal's status for the ops view. */
export interface RatingStatus {
  memberId: string
  domain: string
  state: RatingState
  promptedAtMs: number | null
  openedAtMs: number | null
}

/** Reduce a row to its single dominant state (reviewed > opened > prompted > none). Pure. */
export function ratingStateOf(row: Pick<RatingStatusRow, 'reviewed' | 'openedAtMs' | 'promptedAtMs'>): RatingState {
  if (row.reviewed) return 'reviewed'
  if (row.openedAtMs != null) return 'opened'
  if (row.promptedAtMs != null) return 'prompted'
  return 'none'
}

/** Map store rows → status list, «needs attention» first (opened awaiting verification at the top),
 *  then prompted, then none, then reviewed (done). Pure. */
export function buildRatingStatuses(rows: RatingStatusRow[]): RatingStatus[] {
  const order: Record<RatingState, number> = { opened: 0, prompted: 1, none: 2, reviewed: 3 }
  return rows
    .map(r => ({
      memberId: r.memberId,
      domain: r.domain,
      state: ratingStateOf(r),
      promptedAtMs: r.promptedAtMs,
      openedAtMs: r.openedAtMs
    }))
    .sort((a, b) => order[a.state] - order[b.state] || a.domain.localeCompare(b.domain))
}
