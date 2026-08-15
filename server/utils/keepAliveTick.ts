// One tick of the bank keep-alive timer (#504), extracted from the cron plugin so it is TESTABLE —
// the same move `queueHealthTick.ts` made, and for the same reason.
//
// ⚠ THE INVARIANT THIS FILE EXISTS FOR: the pulse is recorded ONLY for a run that COMPLETED. A scan
// that threw is not a heartbeat — recording it would silence precisely the alarm the pulse was added
// for, and the failure would look identical to health. While this lived as a try/catch inside the
// plugin it could be inverted (recording in `catch`) without a single test going red, because a
// plugin is a startup side-effect and nothing in it can be asserted.
//
// What stays in the plugin is what belongs to a plugin: the timer, the process-wide state, and the
// live bindings.

import type { KeepAlivePulseSummary } from '../../app/utils/keepAlivePulse'

export interface KeepAliveTickDeps {
  /** Run the scan. Throws when the run itself failed (e.g. the account listing is unreachable). */
  run: () => Promise<KeepAlivePulseSummary>
  /** Record a COMPLETED run. Never called otherwise. */
  record: (summary: KeepAlivePulseSummary, atMs: number) => void
  now: () => number
  /** Report a failed run. Must not throw — alerting must never take the cron instance down. */
  error: (message: string) => void
}

/**
 * Run the scan and record the pulse if — and only if — it finished.
 *
 * Returns `true` when a pulse was recorded. A throw from `run` is swallowed: per-account failures
 * are already isolated inside the scan, so only a failure of the listing itself reaches here, and
 * the cron instance must survive its own maintenance task.
 */
export async function runKeepAliveTick(deps: KeepAliveTickDeps): Promise<boolean> {
  try {
    const summary = await deps.run()
    deps.record(summary, deps.now())
    return true
  } catch (err) {
    deps.error(`[queue] bank keep-alive run failed: ${(err as Error)?.message}`)
    return false
  }
}
