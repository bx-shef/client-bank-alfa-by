import { ref } from 'vue'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'

// Manual «Опросить сейчас» (#54): trigger an on-demand bank poll of the portal's connected accounts
// from the in-portal admin UI. POSTs to /api/poll-now with the FRAME token (Bearer + X-B24-Domain) —
// the backend gates on the feature flag + admin + a per-portal cooldown, then enqueues the fetch
// jobs. Outside a portal frame there is no token → inert. Frame-auth helpers are shared (useFrameAuth),
// same as useBankConnect. The feature is OFF unless the owner sets MANUAL_POLL_ENABLED — the UI
// surfaces the backend's response (disabled / cooldown / enqueued N) rather than hiding the button.

export interface PollNowResponse {
  enqueued?: number
  accounts?: number
  cooldownSec?: number
  error?: string
}

export function useManualPoll() {
  const polling = ref(false)
  const error = ref('')
  const message = ref('')
  /** True only in the in-portal frame (a token exists). Resolve on mount via syncEnabled(). */
  const enabled = ref(false)

  function syncEnabled(): void {
    enabled.value = frameAuth() !== null
  }

  /** Trigger the poll. Sets `message` on success, `error` on any failure. */
  async function poll(): Promise<void> {
    const a = frameAuth()
    enabled.value = a !== null
    error.value = ''
    message.value = ''
    if (!a) {
      error.value = 'Опрос доступен только внутри портала Bitrix24'
      return
    }
    polling.value = true
    try {
      const res = await $fetch<PollNowResponse>('/api/poll-now', { method: 'POST', headers: authHeaders(a) })
      const n = res?.enqueued ?? 0
      message.value = n > 0
        ? `Опрос запущен: счетов — ${res?.accounts ?? n}.`
        : 'Опрос запущен, но подключённых счетов нет — сначала подключите счёт.'
    } catch (e) {
      // Map the backend's typed rejections to friendly copy; fall back to the generic message.
      const status = (e as { statusCode?: number, status?: number })?.statusCode ?? (e as { status?: number })?.status
      if (status === 429) error.value = 'Слишком часто — подождите немного и повторите.'
      else if (status === 503) error.value = 'Ручной опрос сейчас отключён.'
      else if (status === 403) error.value = 'Опрос может запустить только администратор портала.'
      else error.value = frameFetchError(e, 'Не удалось запустить опрос')
    } finally {
      polling.value = false
    }
  }

  return { poll, syncEnabled, polling, error, message, enabled }
}
