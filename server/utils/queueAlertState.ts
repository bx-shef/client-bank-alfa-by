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

/**
 * State of the alerting channel ITSELF (#466 §3).
 *
 * ⚠ Added because the channel is silent in the same way in two opposite cases: «all good» and
 * «alerting is switched off». A wrong `chat_id`, a revoked bot, or simply unset variables produce a
 * `console.error` and an undelivered episode — nothing of which reaches the outside. The one
 * channel that reaches out on its own could not say that it is not reaching out.
 */
let channel: AlertChannelState = { configured: false, lastOk: null, lastAtMs: null }

export interface AlertChannelState {
  /** Whether both variables are set. `false` — channel off; alerts live only in the log and `/queues`. */
  configured: boolean
  /** Outcome of the last delivery ATTEMPT; `null` — no attempt has been made yet. */
  lastOk: boolean | null
  lastAtMs: number | null
}

/** Remember whether the channel is on (called once, when the cron instance starts). */
export function recordAlertChannelConfigured(configured: boolean): void {
  channel = { ...channel, configured }
}

/** Remember the outcome of a delivery attempt. */
export function recordAlertDelivery(ok: boolean, atMs: number): void {
  channel = { ...channel, lastOk: ok, lastAtMs: atMs }
}

export function alertChannelState(): AlertChannelState {
  return { ...channel }
}

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
  channel = { configured: false, lastOk: null, lastAtMs: null }
}
