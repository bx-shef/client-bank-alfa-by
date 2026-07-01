import { ref } from 'vue'
import { useB24 } from '~/composables/useB24'

// Test setting stored at the APP level in the portal (`app.option`, per-portal).
// Auth to our backend is the B24 FRAME access token + domain (from the SDK) — the
// backend calls app.option with it, and B24 scopes it to THIS portal. So there is
// no member_id to trust and no way to touch another portal. Outside a portal frame
// there is no token → the field is inert.
export function useAppSettings() {
  const value = ref('')
  const savedValue = ref<string | null>(null)
  const domain = ref('')
  const enabled = ref(false)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')

  /** Frame auth (access token + domain), or null outside a portal. */
  function frameAuth(): { token: string, domain: string } | null {
    const b24 = useB24()
    if (!b24.isInit()) return null
    try {
      const auth = b24.getOrThrow().auth.getAuthData()
      if (auth === false || !auth.access_token || !auth.domain) return null
      return { token: auth.access_token, domain: auth.domain }
    } catch {
      return null
    }
  }

  function authHeaders(a: { token: string, domain: string }) {
    return { 'authorization': `Bearer ${a.token}`, 'x-b24-domain': a.domain }
  }

  async function load() {
    const a = frameAuth()
    enabled.value = a !== null
    if (!a) return
    domain.value = a.domain
    loading.value = true
    error.value = ''
    try {
      const res = await $fetch<{ value: string | null }>('/api/settings', { headers: authHeaders(a) })
      savedValue.value = res.value
      value.value = res.value ?? ''
    } catch (e) {
      error.value = readError(e, 'Не удалось загрузить настройку')
    } finally {
      loading.value = false
    }
  }

  async function save() {
    const a = frameAuth()
    if (!a) return
    saving.value = true
    error.value = ''
    try {
      await $fetch('/api/settings', { method: 'POST', headers: authHeaders(a), body: { value: value.value } })
      savedValue.value = value.value
    } catch (e) {
      error.value = readError(e, 'Не удалось сохранить настройку')
    } finally {
      saving.value = false
    }
  }

  return { value, savedValue, domain, enabled, loading, saving, error, load, save }
}

function readError(e: unknown, fallback: string): string {
  const data = (e as { data?: { error?: string } })?.data
  return data?.error ? `${fallback}: ${data.error}` : fallback
}
