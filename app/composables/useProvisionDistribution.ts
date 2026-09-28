import { ref } from 'vue'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'

// Provision the two distribution smart processes (#109 §9.1). POSTs to /api/distribution/provision
// with the FRAME token (Bearer + X-B24-Domain) — the backend proves the portal + `profile.ADMIN`,
// then creates/verifies the SPs on the portal's STORED OAuth token and stores their entityTypeIds
// in settings. Outside a portal frame there is no token → inert. Mirrors useManualPoll.
//
// ⚠ There is NO feature flag any more (owner's call, 2026-08-23): the payments smart process is the
// REGISTRY every operation is written to (#575), not an optional extra, so the app's mode is always
// «on». The same call runs unattended right after install — see `app/pages/install.vue`.

export interface ProvisionResponse {
  ok?: boolean
  paymentSpEtid?: number
  distributionSpEtid?: number
  created?: boolean
  addedFields?: number
  storedChanged?: boolean
  /** Дошла ли раскладка карточки «Платежи» до всех сотрудников (лучшие усилия на сервере). */
  cardConfigured?: boolean
  error?: string
}

export function useProvisionDistribution() {
  const provisioning = ref(false)
  const error = ref('')
  const message = ref('')
  /** Смарт-процессы на месте, но карточка настроена не до конца: не ошибка, но админ узнаёт сразу. */
  const warning = ref('')
  /** Дошла ли раскладка карточки «Платежи» до всех: `null` — не знаем (не запускали, отказ целиком
   *  или ответ старого backend без этого поля). Читает вердикт установки. */
  const cardConfigured = ref<boolean | null>(null)
  /** entityTypeId созданных/найденных СП — из них строятся ссылки в портал. */
  const paymentSpEtid = ref<number | null>(null)
  const distributionSpEtid = ref<number | null>(null)
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
    warning.value = ''
    cardConfigured.value = null
    if (!a) {
      error.value = 'Настройка смарт-процессов доступна только внутри портала Bitrix24'
      return
    }
    provisioning.value = true
    try {
      const res = await $fetch<ProvisionResponse>('/api/distribution/provision', { method: 'POST', headers: authHeaders(a) })
      // Голые id («платежи 1046») пользователю ничего не говорят — сами смарт-процессы отдаём
      // ссылками (см. ProvisionSpCard), а здесь остаётся только «что произошло».
      paymentSpEtid.value = Number(res?.paymentSpEtid) || null
      distributionSpEtid.value = Number(res?.distributionSpEtid) || null
      // ⚠ Строго булево: поле отсутствует у ответа сервера старше этой правки (образы статики и
      // backend выкатываются порознь), и «не знаем» не должно читаться ни как «удалось», ни как
      // «не удалось».
      cardConfigured.value = typeof res?.cardConfigured === 'boolean' ? res.cardConfigured : null
      message.value = res?.created
        ? 'Смарт-процессы созданы.'
        : cardConfigured.value === true
          ? 'Смарт-процессы и раскладка карточки «Платежи» на месте.'
          : 'Смарт-процессы уже были на месте.'
      if (cardConfigured.value === false) {
        warning.value = 'Раскладку карточки «Платежи» применить не удалось: у всех сотрудников или у '
          + 'части из них в карточке может не быть клиента и реквизитов вашей компании. Смарт-процессы '
          + 'и поля на месте. Повторите настройку позже.'
      }
    } catch (e) {
      // Map the backend's typed rejections to friendly copy; fall back to the generic message.
      const status = (e as { statusCode?: number, status?: number })?.statusCode ?? (e as { status?: number })?.status
      if (status === 403) error.value = 'Настроить смарт-процессы может только администратор портала.'
      else if (status === 409) error.value = 'Приложение не установлено на портал.'
      else error.value = frameFetchError(e, 'Не удалось настроить смарт-процессы')
    } finally {
      provisioning.value = false
    }
  }

  return { provision, syncEnabled, provisioning, error, message, warning, cardConfigured, enabled, paymentSpEtid, distributionSpEtid }
}
