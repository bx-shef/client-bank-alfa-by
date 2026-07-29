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
  pollEnabled: boolean
  pollIntervalMin: number
  lastRunMs: number | null
}

const DEFAULTS: SetupStatus = {
  connectedAccounts: 0,
  pollEnabled: false,
  pollIntervalMin: 5,
  lastRunMs: null
}

export function useSetupStatus() {
  const status = ref<SetupStatus>({ ...DEFAULTS })
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  async function load(): Promise<void> {
    const a = frameAuth()
    if (!a) {
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

  return { status, loading, loaded, error, load }
}
