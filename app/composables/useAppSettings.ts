import { ref } from 'vue'
import { useB24 } from '~/composables/useB24'

// Test setting stored at the APP level in the portal (`app.option`, per-portal).
// The UI passes the portal's member_id (from the B24 frame) to the backend, which
// does the actual app.option.get/set by the stored token. Outside a portal frame
// there is no member_id → the field is inert (nothing to scope the setting to).
export function useAppSettings() {
  const value = ref('')
  const savedValue = ref<string | null>(null)
  const memberId = ref('')
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')

  function resolveMemberId(): string {
    const b24 = useB24()
    if (!b24.isInit()) return ''
    try {
      const auth = b24.getOrThrow().auth.getAuthData()
      return auth === false ? '' : (auth.member_id || '')
    } catch {
      return ''
    }
  }

  async function load() {
    memberId.value = resolveMemberId()
    if (!memberId.value) return
    loading.value = true
    error.value = ''
    try {
      const res = await $fetch<{ value: string | null }>('/api/settings', { params: { memberId: memberId.value } })
      savedValue.value = res.value
      value.value = res.value ?? ''
    } catch (e) {
      error.value = readError(e, 'Не удалось загрузить настройку')
    } finally {
      loading.value = false
    }
  }

  async function save() {
    if (!memberId.value) return
    saving.value = true
    error.value = ''
    try {
      await $fetch('/api/settings', { method: 'POST', body: { memberId: memberId.value, value: value.value } })
      savedValue.value = value.value
    } catch (e) {
      error.value = readError(e, 'Не удалось сохранить настройку')
    } finally {
      saving.value = false
    }
  }

  return { value, savedValue, memberId, loading, saving, error, load, save }
}

function readError(e: unknown, fallback: string): string {
  const data = (e as { data?: { error?: string } })?.data
  return data?.error ? `${fallback}: ${data.error}` : fallback
}
