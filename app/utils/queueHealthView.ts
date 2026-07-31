// Presentation of the queue-health verdict on /queues (#426). Pure — the page only renders what
// this returns, so the one thing that actually matters here is unit-testable: an empty alert list
// has THREE different meanings, and showing them identically is the same class of lie as rendering
// an unreadable queue as an empty healthy one.
//
//   - «ещё не проверяли» — the check has not run yet (fresh boot, or this instance is not the cron
//     one). Nothing is known.
//   - «проверка протухла» — the last verdict is too old to speak about now. The checker itself may
//     be dead, which is precisely when a green screen is most misleading.
//   - «всё хорошо» — a recent check found nothing.

/** One alert as the API returns it (mirror of the server `QueueAlert`). */
export interface QueueHealthAlert {
  kind: 'stalled' | 'failing' | 'unreadable'
  queue: string
  text: string
}

export interface QueueHealthPayload {
  alerts?: QueueHealthAlert[]
  /** When the last check completed, ms. `null`/absent — ещё ни разу. */
  alertsCheckedAt?: number | null
}

/**
 * How old a verdict may be before it stops meaning anything.
 *
 * The check runs every 5 minutes, so ~3 missed rounds. Tighter would flag a single slow Redis read;
 * looser would keep showing a comforting green long after the checker died.
 */
export const HEALTH_STALE_MS = 16 * 60 * 1000

export type QueueHealthTone = 'unknown' | 'stale' | 'ok' | 'problem'

export interface QueueHealthView {
  tone: QueueHealthTone
  /** Sentence for the screen. Never «всё хорошо» unless a RECENT check said so. */
  note: string
  /** Alerts worth rendering as cards; empty unless `tone === 'problem'`. */
  alerts: QueueHealthAlert[]
}

export function presentQueueHealth(payload: QueueHealthPayload | null | undefined, nowMs: number): QueueHealthView {
  const alerts = payload?.alerts ?? []
  const checkedAt = payload?.alertsCheckedAt ?? null

  if (checkedAt === null) {
    return { tone: 'unknown', note: 'Проверка здоровья ещё не выполнялась — состояние конвейера неизвестно.', alerts: [] }
  }
  const ageMs = Math.max(0, nowMs - checkedAt)
  if (ageMs > HEALTH_STALE_MS) {
    const min = Math.round(ageMs / 60_000)
    // Deliberately reports the problems it DOES know about: a stale verdict is not «нет данных»,
    // it is «данные старые» — hiding the alerts would lose real information.
    return {
      tone: 'stale',
      note: `Последняя проверка была ${min} мин назад — данные устарели, возможно, остановился сам сервис проверки.`,
      alerts
    }
  }
  if (alerts.length === 0) {
    return { tone: 'ok', note: 'Проверка здоровья: проблем не обнаружено.', alerts: [] }
  }
  return { tone: 'problem', note: 'Проверка здоровья нашла проблемы:', alerts }
}

/** b24ui `B24Alert` colours we use for the verdict — a literal union, not `string`, so the page's
 *  `:color` binding stays type-checked against the component (a typo fails `typecheck`, not the
 *  screen). Values verified against the installed theme (`.nuxt/b24ui/alert.ts`). */
export type HealthAlertColor = 'air-secondary-accent' | 'air-primary-warning' | 'air-primary-success' | 'air-primary-alert'

/** Colour for the verdict. Kept next to the tone so the page has no branching. */
export const HEALTH_TONE_COLOR: Record<QueueHealthTone, HealthAlertColor> = {
  unknown: 'air-secondary-accent',
  stale: 'air-primary-warning',
  ok: 'air-primary-success',
  problem: 'air-primary-alert'
}
