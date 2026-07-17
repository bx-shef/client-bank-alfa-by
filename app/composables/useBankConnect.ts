import { ref } from 'vue'
import type { BankProviderId } from '~/types/statement'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'

// Start the bank OAuth connect from the in-portal admin UI (stage 5, A7c). `start()` POSTs the
// target account to /api/bank/connect with the FRAME token (Bearer + X-B24-Domain) — the backend
// gates on admin + validates the token, mints a signed state, and returns the bank authorize URL.
// It RETURNS that URL (or null) rather than navigating: the component must open the tab
// SYNCHRONOUSLY inside the click gesture (a window.open after this await would be popup-blocked),
// then point it at the URL. Outside a portal frame there is no token → inert. Frame-auth helpers
// are shared (useFrameAuth), same as useAppSettings.

export function useBankConnect() {
  const connecting = ref(false)
  const error = ref('')
  /** True only in the in-portal frame (a token exists). Outside → the UI is a preview. Resolve on
   *  mount via `syncEnabled()` so the preview note is correct before the first click. */
  const enabled = ref(false)

  /** Resolve frame presence now (call from onMounted). */
  function syncEnabled(): void {
    enabled.value = frameAuth() !== null
  }

  /**
   * Kick off the connect. Returns the bank authorize URL to open, or null (with `error` set) on any
   * failure (no frame / blank account / backend error / network). Does NOT open a window — the
   * caller opens it synchronously in the click handler and sets its location to the returned URL.
   */
  async function start(provider: BankProviderId, accountKey: string): Promise<string | null> {
    const a = frameAuth()
    enabled.value = a !== null
    error.value = ''
    if (!a) {
      error.value = 'Подключение доступно только внутри портала Bitrix24'
      return null
    }
    if (!accountKey.trim()) {
      error.value = 'Укажите номер счёта'
      return null
    }
    connecting.value = true
    try {
      const res = await $fetch<{ authorizeUrl?: string, error?: string }>('/api/bank/connect', {
        method: 'POST',
        headers: authHeaders(a),
        body: { provider, accountKey: accountKey.trim() }
      })
      if (res?.authorizeUrl) return res.authorizeUrl
      error.value = res?.error || 'Не удалось начать подключение'
      return null
    } catch (e) {
      error.value = frameFetchError(e, 'Не удалось начать подключение')
      return null
    } finally {
      connecting.value = false
    }
  }

  return { start, syncEnabled, connecting, error, enabled }
}
