import type { QueueAlert } from './queueAlert'

// In-process holder for the queue-health check (#426, ported from `ai-price-import`). Deliberately
// NOT in Postgres or Redis: the check runs on the cron instance, which is the same process that
// serves `/api/ops/*` (the `worker` role runs with QUEUE_CRON=0), and the verdict is derived fresh
// from live queue state every tick — there is nothing worth surviving a restart.
//
// The rules are stateless (see queueAlert.ts), so this holds only the LAST VERDICT and WHEN it was
// reached. That «when» is not decoration: a check that last ran six hours ago says nothing about
// now, and a screen that renders it identically to a fresh one is the same lie as showing an
// unread queue as healthy.

let current: QueueAlert[] = []
let checkedAtMs: number | null = null

/** Store the verdict of one check. */
export function recordQueueHealth(alerts: QueueAlert[], atMs: number): void {
  current = [...alerts]
  checkedAtMs = atMs
}

/**
 * What the last check found, and when.
 *
 * `checkedAtMs === null` means «ещё ни разу не проверяли» — which the UI must not render as «всё
 * хорошо». The array is copied out: it is process-wide state, and a caller mutating what it got
 * back would silently rewrite the stored verdict.
 */
export function queueAlertState(): { alerts: QueueAlert[], checkedAtMs: number | null } {
  return { alerts: [...current], checkedAtMs }
}

/** Test seam — the module keeps process-wide state by design. */
export function resetQueueAlertState(): void {
  current = []
  checkedAtMs = null
}
