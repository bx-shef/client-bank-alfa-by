import type { QueueAlert } from './queueAlert'

// What actually gets PUSHED out of the queue health check, and when (#426, ported from
// `ai-price-import`).
//
// Where this sits relative to the other three observability paths, so the four do not grow into
// duplicates of each other:
//
//   - **Телеметрия (OTel → Grafana)** — графики и разбор: «когда началось», «как часто», «что ещё
//     происходило рядом». Смотрят, когда уже знают, что смотреть.
//   - **`/queues`** — текущее состояние: открыл и увидел.
//   - **Логи `[queue-job-failed]`** — что именно упало, при разборе конкретного инцидента.
//   - **Телеграм (здесь)** — единственный канал, который стучится САМ. Поэтому в него идёт не всё,
//     что интересно, а только то, ради чего стоит отвлечь человека. Дублировать сюда графики
//     бессмысленно: канал, который пишет часто, перестают читать, и тогда он не сработает в тот
//     единственный раз, ради которого заведён.
//
// Hence the rules below: one message per EPISODE, not per check, and a floor on how often the same
// problem may be re-announced. The health check runs every five minutes and a real outage lasts
// longer, so «сообщать на каждый замер» would mean twelve identical messages an hour.

/** One ongoing problem, keyed so the same breakage is recognised across checks. */
export type EpisodeKey = string

export function episodeKey(a: QueueAlert): EpisodeKey {
  return `${a.kind}:${a.queue}`
}

/**
 * Floor on re-announcing the same problem after it cleared.
 *
 * Without it, a FLAPPING breakage is the worst case in the whole design: a queue that trips the
 * threshold, drains just enough to clear, and trips again produces «сломалось»+«починилось» on every
 * five-minute check — twenty-four messages an hour, strictly worse than the outage it reports. An
 * hour is chosen so a genuinely new incident on the same queue is still not sat on for long.
 */
export const MIN_REANNOUNCE_MS = 60 * 60 * 1000

/** What the caller carries between checks. Opaque to it — build it with `emptyDeliveryState()`. */
export interface DeliveryState {
  /** Episodes observed as ongoing on the previous check. */
  open: EpisodeKey[]
  /** When each episode was last SUCCESSFULLY announced. Bounds the flapping case. */
  announcedAtMs: Record<EpisodeKey, number>
  /** Episodes announced as broken whose recovery has not been reported yet. */
  awaitingRecovery: EpisodeKey[]
}

export function emptyDeliveryState(): DeliveryState {
  return { open: [], announcedAtMs: {}, awaitingRecovery: [] }
}

export interface DeliveryPlan {
  /** Alerts to announce now. */
  opened: QueueAlert[]
  /** Problems whose breakage WAS announced and which are now gone. */
  recovered: EpisodeKey[]
  /** State to carry into the next check, before delivery is confirmed. */
  state: DeliveryState
}

/**
 * Decide what to push, given what is wrong now and what has already been SAID.
 *
 * Three things this has to get right, each of which was wrong in an earlier draft of the source:
 *
 *  1. **Не повторяться.** An ongoing outage outlives the five-minute interval, so an episode that
 *     has been announced stays quiet.
 *  2. **Не терять.** «Announced» means the message actually went out — see `markAnnounced`. An
 *     episode whose send failed is retried on the next check instead of being silently marked as
 *     told, which is how the previous version lost an alert forever on a single 429.
 *  3. **Не мерцать.** A breakage sitting exactly on a threshold trips and clears on alternate
 *     checks. Re-announcing it is floored by `MIN_REANNOUNCE_MS`, and — crucially — a clear is only
 *     reported for an episode whose BREAKAGE was announced (`awaitingRecovery`), so a suppressed
 *     flap produces no «восстановилось» either. Otherwise the ✅ half alone would be twelve messages
 *     an hour.
 *
 * The recovery notice itself is not decoration: without it the channel only ever says «сломалось»,
 * and the reader cannot tell «починилось само» from «всё ещё лежит, просто мы замолчали».
 */
export function planAlertDelivery(
  alerts: QueueAlert[],
  previous: DeliveryState,
  nowMs: number
): DeliveryPlan {
  const wasOpen = new Set(previous.open)
  const awaiting = new Set(previous.awaitingRecovery)
  const now = new Map<EpisodeKey, QueueAlert>()
  for (const a of alerts) now.set(episodeKey(a), a)

  const opened: QueueAlert[] = []
  for (const [key, alert] of now) {
    const last = previous.announcedAtMs[key]
    // Never announced (first time, or the previous send failed) → say it now.
    if (last === undefined) {
      opened.push(alert)
      continue
    }
    if (wasOpen.has(key)) continue // ongoing and already told
    if (nowMs - last < MIN_REANNOUNCE_MS) continue // flapping — stay quiet
    opened.push(alert)
  }

  const recovered: EpisodeKey[] = []
  for (const key of awaiting) {
    if (!now.has(key)) recovered.push(key)
  }

  // Prune: keep a timestamp only while it still does work — the episode is ongoing, or it is recent
  // enough to still suppress a re-announcement. Otherwise the map grows for the process's lifetime.
  const announcedAtMs: Record<EpisodeKey, number> = {}
  for (const [key, at] of Object.entries(previous.announcedAtMs)) {
    if (now.has(key) || nowMs - at < MIN_REANNOUNCE_MS) announcedAtMs[key] = at
  }

  return {
    opened,
    recovered,
    state: {
      open: [...now.keys()],
      announcedAtMs,
      // Recovery reported → stop awaiting it. Announcements are added by `markAnnounced`.
      awaitingRecovery: [...awaiting].filter(k => now.has(k))
    }
  }
}

/**
 * Record that an episode's message actually reached the channel.
 *
 * Separate from `planAlertDelivery` on purpose: only the caller knows whether the send succeeded,
 * and marking before knowing is exactly how an alert gets lost.
 */
export function markAnnounced(state: DeliveryState, key: EpisodeKey, nowMs: number): DeliveryState {
  return {
    open: state.open,
    announcedAtMs: { ...state.announcedAtMs, [key]: nowMs },
    awaitingRecovery: state.awaitingRecovery.includes(key)
      ? state.awaitingRecovery
      : [...state.awaitingRecovery, key]
  }
}

/** How the app names itself in the channel. One operator may watch several of our services in the
 *  same chat, so «⚠️ очередь встала» without a subject is unactionable. */
export const ALERT_APP_NAME = 'Импорт выписки клиент-банка'

/** Human name for an episode key in the recovery notice. */
const KIND_WORD: Record<string, string> = {
  stalled: 'простой',
  failing: 'падения задач',
  unreadable: 'нечитаемая очередь'
}

/** Message announcing a new problem. */
export function alertMessage(a: QueueAlert, appUrl?: string | null): string {
  const lines = [`⚠️ ${ALERT_APP_NAME}: ${a.text}`]
  if (appUrl) lines.push(`Состояние: ${appUrl}`)
  return lines.join('\n')
}

/** Message announcing that a problem is gone. */
export function recoveryMessage(key: EpisodeKey): string {
  const [kind, ...rest] = key.split(':')
  const what = KIND_WORD[kind ?? ''] ?? kind
  return `✅ ${ALERT_APP_NAME}: очередь «${rest.join(':')}» — ${what} прекратились.`
}
