import type { ImportRunSummary, ImportState } from '~/types/importStatus'

// Pure helpers for presenting the import status — Russian relative time and a
// state→label/colour map. No I/O; unit-tested.

/** The empty "never run yet" summary — SSG-stable default, the API fallback when a
 *  portal has no recorded run, and the client empty state. Single source (client-safe,
 *  imported by both the server handler and the UI composable). */
export function emptyImportSummary(): ImportRunSummary {
  return { state: 'never', lastSyncAt: null, operations: 0, activitiesCreated: 0, chatNotified: 0, errors: [] }
}

/** Russian plural pick: forms = [one, few, many] (e.g. ['минуту','минуты','минут']). */
export function pluralRu(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100
  const last = abs % 10
  if (abs > 10 && abs < 20) return forms[2]
  if (last > 1 && last < 5) return forms[1]
  if (last === 1) return forms[0]
  return forms[2]
}

/**
 * Human relative time in Russian: «только что», «5 минут назад», «2 часа назад»,
 * «вчера», else an absolute DD.MM.YYYY. `nowMs` is injected for testability/SSG.
 * Returns '' for a null/invalid timestamp.
 */
export function formatRelativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const diffSec = Math.round((nowMs - then) / 1000)

  if (diffSec < 0) return 'только что'
  if (diffSec < 60) return 'только что'
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min} ${pluralRu(min, ['минуту', 'минуты', 'минут'])} назад`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} ${pluralRu(hours, ['час', 'часа', 'часов'])} назад`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'вчера'
  if (days < 7) return `${days} ${pluralRu(days, ['день', 'дня', 'дней'])} назад`
  // Older — show an absolute date.
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(then)
}

/** Presentation metadata for a state: a label and a b24ui colour token. */
export interface ImportStateMeta {
  label: string
  /** b24ui "air-*" colour token for B24Badge/B24Alert. */
  color: 'air-primary' | 'air-primary-success' | 'air-primary-warning' | 'air-primary-alert' | 'air-secondary'
}

export function importStateMeta(state: ImportState): ImportStateMeta {
  switch (state) {
    case 'running': return { label: 'Идёт синхронизация…', color: 'air-primary' }
    case 'ok': return { label: 'Работает', color: 'air-primary-success' }
    case 'error': return { label: 'Ошибка синхронизации', color: 'air-primary-alert' }
    case 'never': return { label: 'Ещё не запускалась', color: 'air-secondary' }
  }
}
