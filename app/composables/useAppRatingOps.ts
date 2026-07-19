import { ref } from 'vue'

// Operator-side «оценки приложения» client for the /queues page: read per-portal rating state and
// drive its lifecycle (confirm a review / reset the flag) — so the owner MANAGES it from the UI
// instead of running SQL. Auth is the operator SESSION cookie (sent same-origin); the POST also
// carries the CSRF header (a custom header can't be set by a cross-site form POST).

export type RatingState = 'reviewed' | 'opened' | 'prompted' | 'none'

export interface RatingStatus {
  memberId: string
  domain: string
  state: RatingState
  promptedAtMs: number | null
  openedAtMs: number | null
}

export type RatingOpAction = 'reviewed' | 'reset'

// Mirror of server/utils/session.ts CSRF_HEADER (kept in sync by hand, like useAuth).
const CSRF_HEADERS = { 'x-cba-auth': '1' }

export function useAppRatingOps() {
  const portals = ref<RatingStatus[]>([])
  const loading = ref(false)
  const error = ref('')
  const busy = ref('') // member_id currently mutating (disables its buttons)
  const message = ref('')

  /** Pull the per-portal rating state. Best-effort — a failure just leaves the card empty. */
  async function load(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const r = await $fetch<{ portals: RatingStatus[] }>('/api/ops/app-rating')
      portals.value = r.portals
    } catch {
      error.value = 'Не удалось загрузить статусы оценок'
    } finally {
      loading.value = false
    }
  }

  /** Owner control of the review lifecycle: confirm a review (terminal) or reset the flag so the
   *  modal shows again. Re-pulls on success so the row reflects the new state. */
  async function setRating(memberId: string, action: RatingOpAction): Promise<void> {
    busy.value = memberId
    message.value = ''
    try {
      await $fetch('/api/ops/app-rating', { method: 'POST', headers: CSRF_HEADERS, body: { memberId, action } })
      message.value = action === 'reviewed'
        ? 'Отмечено как «отзыв оставлен»'
        : 'Флаг сброшен — попап покажется снова'
      await load()
    } catch {
      message.value = 'Не удалось изменить статус'
    } finally {
      busy.value = ''
    }
  }

  return { portals, loading, error, busy, message, load, setRating }
}
