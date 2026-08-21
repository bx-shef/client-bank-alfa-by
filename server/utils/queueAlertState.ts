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
 * Состояние САМОГО канала оповещений (#466 §3).
 *
 * ⚠ Заведено потому, что канал молчит одинаково в двух противоположных случаях: «всё хорошо» и
 * «сигнализация выключена». Неверный `chat_id`, отозванный бот или просто незаданные переменные
 * дают `console.error` и неотправленный эпизод — наружу об этом не выходит ничего. То есть
 * единственный канал, который стучится сам, не умел сказать, что он не стучится.
 */
let channel: AlertChannelState = { configured: false, lastOk: null, lastAtMs: null }

export interface AlertChannelState {
  /** Заданы ли обе переменные. `false` — канал выключен, алерты живут только в логе и на `/queues`. */
  configured: boolean
  /** Исход последней ПОПЫТКИ доставки: `null` — попыток ещё не было. */
  lastOk: boolean | null
  lastAtMs: number | null
}

/** Запомнить, включён ли канал (зовётся один раз на старте крон-инстанса). */
export function recordAlertChannelConfigured(configured: boolean): void {
  channel = { ...channel, configured }
}

/** Запомнить исход попытки доставки. */
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
