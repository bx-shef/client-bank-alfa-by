import { ref } from 'vue'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'

// Provision the two distribution smart processes (#109 §9.1) from the in-portal admin UI. POSTs to
// /api/distribution/provision with the FRAME token (Bearer + X-B24-Domain) — the backend gates on
// the feature flag + admin, then creates/verifies the SPs on the portal's STORED OAuth token and
// stores their entityTypeIds in settings. Outside a portal frame there is no token → inert. Mirrors
// useManualPoll. The feature is OFF unless the owner sets DISTRIBUTION_PROVISION_ENABLED — the UI
// surfaces the backend's response (404 disabled / 403 admin / 200 result) rather than hiding it.

export interface ProvisionResponse {
  ok?: boolean
  paymentSpEtid?: number
  distributionSpEtid?: number
  created?: boolean
  addedFields?: number
  storedChanged?: boolean
  error?: string
}

export function useProvisionDistribution() {
  const provisioning = ref(false)
  const error = ref('')
  const message = ref('')
  /** True only in the in-portal frame (a token exists). Resolve on mount via syncEnabled(). */
  const enabled = ref(false)

  function syncEnabled(): void {
    enabled.value = frameAuth() !== null
  }

  /** Trigger provisioning. Sets `message` on success, `error` on any failure. */
  async function provision(): Promise<void> {
    const a = frameAuth()
    enabled.value = a !== null
    error.value = ''
    message.value = ''
    if (!a) {
      error.value = 'Настройка смарт-процессов доступна только внутри портала Bitrix24'
      return
    }
    provisioning.value = true
    try {
      const res = await $fetch<ProvisionResponse>('/api/distribution/provision', { method: 'POST', headers: authHeaders(a) })
      message.value = res?.created
        ? `Смарт-процессы созданы (платежи ${res?.paymentSpEtid}, распределения ${res?.distributionSpEtid}).`
        : `Смарт-процессы на месте (платежи ${res?.paymentSpEtid}, распределения ${res?.distributionSpEtid}).`
    } catch (e) {
      // Map the backend's typed rejections to friendly copy; fall back to the generic message.
      const status = (e as { statusCode?: number, status?: number })?.statusCode ?? (e as { status?: number })?.status
      if (status === 404) error.value = 'Настройка смарт-процессов сейчас отключена.'
      else if (status === 403) error.value = 'Настроить смарт-процессы может только администратор портала.'
      else if (status === 409) error.value = 'Приложение не установлено на портал.'
      else error.value = frameFetchError(e, 'Не удалось настроить смарт-процессы')
    } finally {
      provisioning.value = false
    }
  }

  return { provision, syncEnabled, provisioning, error, message, enabled }
}
