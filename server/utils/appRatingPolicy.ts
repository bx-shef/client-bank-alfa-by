// Pure decision core for the in-portal «оцените приложение» prompt (no I/O → unit-tested).
// State lives in portal_app_rating (one row per portal). The rules mirror the owner's spec:
//   • reviewed === true  → NEVER prompt again (a real Market review is confirmed).
//   • opened_at is set   → the user already clicked «Оценить»; suppress until an owner MANUALLY
//                          verifies the review. If none appeared after ~RATING_REPROMPT_DAYS the
//                          owner clears opened_at and the prompt returns (see appRatingStore).
//   • otherwise          → show, but no more than once per RATING_REPROMPT_DAYS (throttled by
//                          prompted_at). So it surfaces «раз в несколько дней», never on every open.

/** Days between prompts and the manual-verification window. Kept as one constant so the throttle
 *  and the «через N дней проверяем руками» window stay in lockstep. */
export const RATING_REPROMPT_DAYS = 4

const DAY_MS = 24 * 60 * 60 * 1000

/** Row shape from portal_app_rating (nulls when the portal has no row yet). */
export interface AppRatingState {
  promptedAt: Date | null
  openedAt: Date | null
  reviewed: boolean
}

export interface ShouldPromptOptions {
  /** Override the re-prompt interval (days). Defaults to RATING_REPROMPT_DAYS. */
  repromptDays?: number
}

/**
 * Decide whether to show the rating modal now. `now` is injected so the decision is deterministic
 * and testable. A missing row (never prompted) → show.
 */
export function shouldPrompt(state: AppRatingState | null, now: Date, opts: ShouldPromptOptions = {}): boolean {
  if (!state) return true // no row yet → first-ever prompt
  if (state.reviewed) return false // confirmed review → done forever
  if (state.openedAt) return false // clicked «Оценить» → wait for manual verification
  if (!state.promptedAt) return true // row exists but never actually shown
  const intervalMs = (opts.repromptDays ?? RATING_REPROMPT_DAYS) * DAY_MS
  return now.getTime() - state.promptedAt.getTime() >= intervalMs
}
