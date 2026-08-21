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
  // ⚠ Keep in sync with `QueueAlertKind` (`server/utils/queueAlert.ts`). The lists had already
  // drifted: neither `bank-dead` nor `keepalive-stale` was here while the API was already sending
  // them — the screen's type silently described something other than what arrives. Pinned by a test.
  kind: 'stalled' | 'failing' | 'unreadable' | 'bank-dead' | 'keepalive-stale' | 'no-workers'
  queue: string
  text: string
}

/** State of the alerting channel itself (#466 §3), as the screen sees it. */
export interface AlertChannelInfo {
  configured: boolean
  lastOk: boolean | null
  lastAtMs: number | null
}

/**
 * One line about the alerting channel: is it on, and is it getting through?
 *
 * ⚠ Three DISTINCT meanings that must not collapse: «off» (alerts live only in the log and here),
 * «on, but the last delivery failed» (revoked bot, wrong chat_id) and «on, delivering». Without
 * this line the first and third look identical on screen — both are silence.
 */
export type AlertChannelTone = 'off' | 'broken' | 'ok'

/**
 * Text classes per channel tone.
 *
 * ⚠ `off` and `broken` get DIFFERENT colours, and that is not cosmetics. «Not configured» is a
 * common and often deliberate state (dev, staging, an owner who simply never set up Telegram),
 * while «configured but not arriving» is a real breakage. Painting both red would train the reader
 * to ignore red on the very page where red has to mean something.
 *
 * ⚠ Tokens are `--ui-color-*`, not `text-base-500`/`text-red-600`: b24ui's base scale is `1..8`, so
 * `base-500` is not a generated class at all (it would silently do nothing), and raw Tailwind reds
 * fall below 4.5:1 on the light theme — which would make the line saying «alerting is dead» the
 * least readable one on the screen. The red pair below is the measured one from PAGE_GUIDE §9
 * (6.07 / 4.86), NOT `accent-main-alert` — that one is a FILL colour and gives 3.12:1 as text.
 */
export const ALERT_CHANNEL_CLASS: Record<AlertChannelTone, string> = {
  off: 'text-(--ui-color-base-3)',
  // ⚠ `--ui-color-accent-main-alert` тут НЕ ГОДИТСЯ, хотя выглядит «семантически правильным»: это
  // цвет ЗАЛИВКИ, и текстом на светлом фоне он даёт 3.12:1 при пороге 4.5:1 (CLAUDE.md §Цвет и
  // контраст, замерено в #528). Первая редакция этой строки взяла именно его — то есть повторила
  // ошибку, которую проект уже задокументировал. Рабочая пара из PAGE_GUIDE §9: 6.07 / 4.86.
  broken: 'text-(--ui-color-red-80) dark:text-(--ui-color-red-50)',
  ok: 'text-(--ui-color-base-3)'
}

export function presentAlertChannel(info: AlertChannelInfo | null | undefined): { tone: AlertChannelTone, note: string } {
  if (!info?.configured) {
    return { tone: 'off', note: 'Оповещения выключены — тревоги видны только здесь и в логе' }
  }
  if (info.lastOk === false) {
    return { tone: 'broken', note: 'Оповещения включены, но последняя доставка НЕ прошла — проверьте бота и chat_id' }
  }
  if (info.lastOk === null) {
    return { tone: 'ok', note: 'Оповещения включены; отправлять пока было нечего' }
  }
  return { tone: 'ok', note: 'Оповещения включены, последняя доставка прошла' }
}

export interface QueueHealthPayload {
  alerts?: QueueHealthAlert[]
  /** Alerting channel state (#466 §3). */
  alertChannel?: AlertChannelInfo | null
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
