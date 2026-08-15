import { evaluateQueueHealth } from './queueAlert'
import { evaluateBankHealth, evaluateKeepAlivePulse } from './bankHealthAlert'
import type { BankHealthRow } from '../../app/utils/bankHealthOverview'
import type { KeepAlivePulse } from '../../app/utils/keepAlivePulse'
import { readQueueHealth, type QueueHealthReader } from './queueHealthRead'
import {
  alertMessage, episodeKey, markAnnounced, markRecovered, planAlertDelivery, recoveryMessage,
  type DeliveryState
} from './queueAlertDeliver'

// One tick of the queue health check (#426), extracted from the Nitro plugin so it is TESTABLE.
//
// The plugin is a startup side-effect: nothing in it can be asserted without booting a server and a
// Redis. Yet the awkward parts all live in the tick — the non-overlap guard, sending OUTSIDE that
// guard, marking an episode as told only when the send actually succeeded, and swallowing a failing
// channel so the monitor never takes the cron instance down. Those are exactly the behaviours a
// regression would silently break, so they belong in a pure-over-deps function and not in a plugin.
//
// The plugin keeps only what a plugin should: the timer, the process-wide state, and binding the
// deps to live BullMQ / fetch / console.

export interface QueueHealthTickDeps {
  reader: QueueHealthReader
  now: () => number
  /** Publish one message. `true` ONLY when it actually reached the channel — the whole
   *  «не потерять алерт» rule hangs on this being honest. Must never throw. */
  push: (text: string) => Promise<boolean>
  /** Record the verdict for the operator UI / diagnostics. */
  record: (alerts: ReturnType<typeof evaluateQueueHealth>, atMs: number) => void
  /** Greppable log line per alert (the channel may be off; the log is always there). */
  warn: (message: string) => void
  /** Unexpected failure of the check itself. */
  error: (message: string) => void
  /** Link appended to an alert, or null when no https site url is configured. */
  queuesUrl?: string | null
  /**
   * Банковские подключения по всем порталам (#497 §3). Необязательна: без неё тик работает ровно
   * как прежде.
   *
   * ⚠ Едет ЧЕРЕЗ ЭТОТ ЖЕ ТИК, а не отдельным таймером, намеренно. Второй таймер означал бы второй
   * не-перекрывающийся страж, второе состояние доставки и вторую пару «объявили/восстановилось»,
   * пишущую в тот же чат, — то есть удвоение всей механики ради данных, которые меняются РЕЖЕ
   * очередей. Отказ чтения не должен гасить проверку конвейера, поэтому изолирован.
   */
  bankRows?: () => Promise<BankHealthRow[]>
  /**
   * Пульс продления банковских токенов и его каденция (#504). Необязательна.
   *
   * ⚠ Читается СИНХРОННО и без I/O — это память того же процесса. Поэтому, в отличие от `bankRows`,
   * тут нечему падать и нечего изолировать.
   */
  keepAlive?: () => { pulse: KeepAlivePulse | null, intervalMs: number }
}

export interface QueueHealthTickResult {
  /** State to carry into the next tick (announcements already marked). */
  state: DeliveryState
  /** How many breakage messages actually went out. */
  announced: number
  /** How many recovery messages went out. */
  recovered: number
  /** True when the reading/rules step threw — the verdict was NOT refreshed. */
  failed: boolean
}

/**
 * Read the pipeline, judge it, and push what has not been said yet.
 *
 * Order matters and is the point of the function:
 *
 *  1. **Read + judge + record first.** A verdict is never recorded unless it was actually reached —
 *     a stale «всё хорошо» is worse than an obviously old timestamp.
 *  2. **Log every alert**, whether or not the channel is on. The channel is optional; the log is not.
 *  3. **Send last, and never let a send failure abort the tick.** An outgoing HTTP call hanging is
 *     CORRELATED with the outage being reported (one host network fault breaks both), so a channel
 *     that stalls its own monitor during an incident is worse than no channel.
 *  4. **`markAnnounced` only on a successful push.** Marking before knowing is how the previous
 *     version of the source lost an alert forever on a single 429: from the next tick the episode
 *     reads as «ongoing and already told».
 *
 * A throw from the reader/rules step is caught: the tick reports `failed` and still returns usable
 * state, because the cron instance must survive its own monitor.
 */
export async function runQueueHealthTick(
  previous: DeliveryState,
  deps: QueueHealthTickDeps
): Promise<QueueHealthTickResult> {
  let plan: ReturnType<typeof planAlertDelivery>
  try {
    const alerts = evaluateQueueHealth(await readQueueHealth(deps.reader, deps.now()), deps.now())
    // Мёртвые банковские подключения — в тот же канал и тем же механизмом эпизодов. ИЗОЛИРОВАНО:
    // недоступная база не должна отменять проверку конвейера, которая уже отработала. Молчание
    // здесь честнее выдумки — состояние подключений мы в этот раз просто не знаем.
    if (deps.bankRows) {
      try {
        alerts.push(...evaluateBankHealth(await deps.bankRows(), deps.now()))
      } catch (err) {
        deps.error(`[queue] bank health read failed: ${(err as Error)?.message}`)
      }
    }
    // Продление токенов встало — НАША авария, не отказ банка (#504). Отдельным эпизодом, потому
    // что чинится другим действием и другими людьми.
    if (deps.keepAlive) {
      const { pulse, intervalMs } = deps.keepAlive()
      alerts.push(...evaluateKeepAlivePulse(pulse, deps.now(), intervalMs))
    }
    deps.record(alerts, deps.now())
    for (const a of alerts) deps.warn(`[queue-alert] ${a.text}`)
    plan = planAlertDelivery(alerts, previous, deps.now())
  } catch (err) {
    // The reader isolates per-queue failures, so only a bug reaches here. The state is returned
    // UNCHANGED: a tick that could not read must not look like «ничего не сломано» to the next one.
    deps.error(`[queue] health check failed: ${(err as Error)?.message}`)
    return { state: previous, announced: 0, recovered: 0, failed: true }
  }
  let state = plan.state

  let announced = 0
  for (const a of plan.opened) {
    if (await deps.push(alertMessage(a, deps.queuesUrl ?? null))) {
      state = markAnnounced(state, episodeKey(a), deps.now())
      announced++
    }
  }
  let recovered = 0
  for (const key of plan.recovered) {
    // Symmetric to the breakage side: the episode stops «awaiting» only once the ✅ went out,
    // so a failed send is retried next tick instead of leaving an unclosed «сломалось».
    if (await deps.push(recoveryMessage(key))) {
      state = markRecovered(state, key)
      recovered++
    }
  }

  return { state, announced, recovered, failed: false }
}
