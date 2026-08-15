import type { QueueAlert } from './queueAlert'
import type { BankProviderId } from '../../app/types/statement'
import { BANK_LABELS } from '../../app/utils/bankLabels'

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

/**
 * What the caller carries between checks. Opaque to it — build it with `emptyDeliveryState()`.
 *
 * ⚠ There is deliberately NO «episodes seen last time» field, though the source port had one
 * (`open`). Keeping it caused a real outage to go silent FOREVER: an episode that tripped, was
 * announced, cleared, and tripped again inside the flap floor was recorded as «seen» while never
 * having been announced the second time — and from the next check on, the «ongoing, already told»
 * short-circuit fired before the floor was ever re-examined. The queue could then lie broken for
 * days with a green ✅ as the last thing the operator heard.
 *
 * `awaitingRecovery` carries that meaning correctly and by construction: an episode is in it iff
 * its breakage HAS been announced and its recovery has not. «Ongoing and already told» is exactly
 * membership in that set — no second bookkeeping to fall out of sync.
 */
export interface DeliveryState {
  /** When each episode was last SUCCESSFULLY announced. Bounds the flapping case. */
  announcedAtMs: Record<EpisodeKey, number>
  /** Episodes whose breakage was announced and whose recovery has not been reported yet. */
  awaitingRecovery: EpisodeKey[]
}

export function emptyDeliveryState(): DeliveryState {
  return { announcedAtMs: {}, awaitingRecovery: [] }
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
  const awaiting = new Set(previous.awaitingRecovery)
  const now = new Map<EpisodeKey, QueueAlert>()
  for (const a of alerts) now.set(episodeKey(a), a)

  const opened: QueueAlert[] = []
  for (const [key, alert] of now) {
    // Already announced and not yet closed → the reader knows; stay quiet however long it lasts.
    if (awaiting.has(key)) continue
    const last = previous.announcedAtMs[key]
    // Never announced (first time, or the previous send failed) → say it now.
    if (last === undefined) {
      opened.push(alert)
      continue
    }
    // Announced before and since closed. Re-announce only past the flap floor — but DO
    // re-announce: this is the branch whose absence let a re-tripped queue lie broken for days.
    if (nowMs - last < MIN_REANNOUNCE_MS) continue
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
      announcedAtMs,
      // ⚠ A recovered episode STAYS in `awaitingRecovery` here — it is removed by `markRecovered`,
      // and only once its ✅ actually went out. Dropping it at planning time (what the source port
      // did) loses the recovery notice forever on a single 429: the next tick no longer sees the
      // episode as awaiting, so nothing is ever re-sent, and the channel is left having said
      // «сломалось» with no closing line. That is the very failure `markAnnounced` exists to prevent
      // on the breakage side — the two halves must be symmetric.
      awaitingRecovery: [...awaiting]
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
    announcedAtMs: { ...state.announcedAtMs, [key]: nowMs },
    awaitingRecovery: state.awaitingRecovery.includes(key)
      ? state.awaitingRecovery
      : [...state.awaitingRecovery, key]
  }
}

/**
 * Record that an episode's RECOVERY notice actually reached the channel.
 *
 * The mirror of `markAnnounced`, and needed for the same reason: until the ✅ is delivered the
 * episode stays «awaiting», so a failed send is retried on the next check instead of leaving the
 * channel with an unclosed «сломалось». Without this the recovery half was the one place a single
 * 429 still lost a message for good.
 */
export function markRecovered(state: DeliveryState, key: EpisodeKey): DeliveryState {
  return {
    announcedAtMs: state.announcedAtMs,
    awaitingRecovery: state.awaitingRecovery.filter(k => k !== key)
  }
}

/** How the app names itself in the channel. One operator may watch several of our services in the
 *  same chat, so «⚠️ очередь встала» without a subject is unactionable. */
export const ALERT_APP_NAME = 'Импорт выписки клиент-банка'

/**
 * Готовое предложение «стало хорошо» по типу эпизода.
 *
 * ⚠ Раньше здесь был словарь ПОДЛЕЖАЩИХ, который подставлялся в общий шаблон «… — {слово}
 * прекратились», и по-русски это не сходилось ни в одном падеже: получалось «простой
 * прекратились» и «нечитаемая очередь прекратились». Восстановление читают ровно один раз и в
 * тот момент, когда решают «можно выдохнуть», — сообщение обязано быть связным. Целое предложение
 * на тип эпизода стоит столько же, а склонять уже нечего.
 */
const RECOVERY_SENTENCE: Record<string, (subject: string) => string> = {
  'stalled': s => `очередь «${s}» снова разгребается.`,
  'failing': s => `очередь «${s}» — задачи перестали падать.`,
  'unreadable': s => `очередь «${s}» снова читается.`,
  // Подлежащее здесь — банк, а не очередь; общий шаблон с «очередь «alfa-by»» был бы просто ложью.
  'bank-dead': s => `${BANK_LABELS[s as BankProviderId] ?? s} — мёртвых подключений больше нет.`,
  'keepalive-stale': () => 'продление банковских токенов снова отрабатывает.'
}

/** Message announcing a new problem. */
export function alertMessage(a: QueueAlert, appUrl?: string | null): string {
  const lines = [`⚠️ ${ALERT_APP_NAME}: ${a.text}`]
  if (appUrl) lines.push(`Состояние: ${appUrl}`)
  return lines.join('\n')
}

/** Message announcing that a problem is gone. */
export function recoveryMessage(key: EpisodeKey): string {
  const cut = key.indexOf(':')
  const kind = cut === -1 ? key : key.slice(0, cut)
  const subject = cut === -1 ? '' : key.slice(cut + 1)
  const make = RECOVERY_SENTENCE[kind]
  // Неизвестный тип эпизода не должен превращаться в бессмыслицу: лучше сухо и верно, чем бойко и
  // мимо. Такой ключ может появиться только при рассинхроне версий — и это как раз тот момент,
  // когда сообщение обязано остаться читаемым.
  return `✅ ${ALERT_APP_NAME}: ${make ? make(subject) : `${subject} — восстановлено.`}`
}
