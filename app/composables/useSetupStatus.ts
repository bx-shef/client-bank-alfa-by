import { ref } from 'vue'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'

// Server-side half of the setup checklist (#409/#405) — what the browser cannot know: connected
// bank accounts, the poll gate + period, and when the last run finished. The other half (chat,
// smart processes) comes from the settings the client already holds; `buildReadiness` joins them.
//
// Inert outside the portal frame: no token ⇒ defaults, so the card renders a truthful «ничего не
// настроено» preview instead of an error.

export interface SetupStatus {
  connectedAccounts: number
  /** Подключения без выбранного счёта (#407) — их надо доводить до конца. */
  pendingAccounts: number
  pollEnabled: boolean
  pollIntervalMin: number
  lastRunMs: number | null
  /** Компания «моя» с расчётным счётом (#493). `undefined` — сервер не ответил на этот вопрос
   *  (старая сборка или отказ REST); строка тогда не рисуется вовсе. */
  myCompany?: 'ok' | 'no-company' | 'no-account'
}

const DEFAULTS: SetupStatus = {
  connectedAccounts: 0,
  pendingAccounts: 0,
  pollEnabled: false,
  pollIntervalMin: 5,
  lastRunMs: null
}

export function useSetupStatus() {
  const status = ref<SetupStatus>({ ...DEFAULTS })
  /** Whether we are inside the portal frame (a token exists). Resolved by `load()` from OUR OWN
   *  frameAuth rather than borrowed from useChatSettings — that one only flips its flag after ITS
   *  load resolves, so a child mounting first would flash a false «предпросмотр» in-portal. */
  const inFrame = ref(false)
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  async function load(): Promise<void> {
    const a = frameAuth()
    inFrame.value = a !== null
    if (!a) {
      // Вне фрейма спрашивать некого: показываем дефолты и считаем проверку ЗАВЕРШЁННОЙ, иначе
      // карточка вечно висела бы в состоянии «проверяем настройку…».
      status.value = { ...DEFAULTS }
      loaded.value = true
      return
    }
    loading.value = true
    error.value = ''
    try {
      const res = await $fetch<Partial<SetupStatus>>('/api/setup-status', { headers: authHeaders(a) })
      status.value = {
        connectedAccounts: Number(res?.connectedAccounts) || 0,
        pendingAccounts: Number(res?.pendingAccounts) || 0,
        pollEnabled: res?.pollEnabled === true,
        pollIntervalMin: Number(res?.pollIntervalMin) || DEFAULTS.pollIntervalMin,
        lastRunMs: typeof res?.lastRunMs === 'number' ? res.lastRunMs : null
      }
    } catch (e) {
      error.value = frameFetchError(e, 'Не удалось загрузить состояние настройки')
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  return { status, inFrame, loading, loaded, error, load }
}
