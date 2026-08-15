// In-process holder for the bank keep-alive pulse (#504) — the twin of `queueAlertState.ts`, and
// in-memory for the same reason: the keep-alive timer runs on the cron instance, which is the same
// process that serves `/api/ops/*` (the `worker` role runs with QUEUE_CRON=0).
//
// ⚠ Restart-survival is NOT wanted here, and that is the whole design. A pulse persisted in
// Postgres would keep answering «продление отработало 20 минут назад» after the process that does
// the продление has died and been replaced by one where the timer never started — i.e. the stored
// value would be true about the past and a lie about now. Losing the pulse on restart makes the
// state honestly `never`, which the caller must not render as «всё хорошо» either.

import type { KeepAlivePulse, KeepAlivePulseSummary } from '../../app/utils/keepAlivePulse'

let pulse: KeepAlivePulse | null = null

/** Record one COMPLETED run. Never called for a run that threw — a failed scan is not a heartbeat. */
export function recordKeepAlivePulse(summary: KeepAlivePulseSummary, atMs: number): void {
  pulse = { atMs, summary: { ...summary } }
}

/** Last completed run, or `null` when there has not been one in this process. */
export function keepAlivePulse(): KeepAlivePulse | null {
  return pulse ? { atMs: pulse.atMs, summary: { ...pulse.summary } } : null
}

/** Test seam — the module keeps process-wide state by design. */
export function resetKeepAlivePulse(): void {
  pulse = null
}
