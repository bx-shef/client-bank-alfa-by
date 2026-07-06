import { reactive, ref } from 'vue'
import { useB24 } from '~/composables/useB24'
import { defaultPortalSettings, type PortalSettings } from '~/utils/settings'
import type { RemoteSearchPage } from '~/utils/remoteSearch'

// Per-portal chat settings (notification chat + rules + error chat), persisted
// server-side in app.option under SETTINGS_KEY. Auth to our backend is the B24
// FRAME access token + domain (from the SDK); B24 scopes it to THIS portal, so
// there's no member_id to trust. Outside a portal frame there's no token → inert
// (the form falls back to defaults, persistence is a no-op).
//
// The worker reads the SAME key/shape (readAppSetting(SETTINGS_KEY)) — writing here
// is what turns notifications on for the pipeline.

type ChatOption = { value: string, label: string }

// Module-level singleton: the slideover (/app) and the full page (/settings) render
// the same <SettingsForm/> and must share one settings state (and not double-load).
let instance: ReturnType<typeof create> | null = null

export function useChatSettings() {
  return (instance ??= create())
}

function create() {
  const settings = reactive<PortalSettings>(defaultPortalSettings())
  const enabled = ref(false)
  const loading = ref(false)
  const saving = ref(false)
  const loaded = ref(false)
  const error = ref('')
  // Seed labels for the pickers so the saved chat shows its name (not a raw id)
  // before the menu is opened. Resolved from the recent-chats list on load.
  const notifyOption = ref<ChatOption | undefined>()
  const errorOption = ref<ChatOption | undefined>()

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

  /** Search transport for the chat pickers (AsyncSearchSelect fetcher). Hits the
   *  backend proxy with the frame token; inert (empty) outside the portal. */
  async function chatFetcher(query: string, offset: number, signal?: AbortSignal): Promise<RemoteSearchPage<ChatOption>> {
    const a = frameAuth()
    if (!a) return { items: [], hasMore: false }
    const res = await $fetch<{ items: ChatOption[], hasMore: boolean, nextOffset?: number }>('/api/chat-search', {
      headers: authHeaders(a),
      params: { q: query, offset },
      signal
    })
    return { items: res.items, hasMore: res.hasMore, nextOffset: res.nextOffset }
  }

  /** Resolve a saved dialog id to a {value,label} for the picker: prefer the name
   *  from the recent list, else fall back to the id itself (still selectable). */
  function seedOption(dialogId: string, recent: ChatOption[]): ChatOption | undefined {
    if (!dialogId) return undefined
    return recent.find(c => c.value === dialogId) ?? { value: dialogId, label: dialogId }
  }

  async function load() {
    const a = frameAuth()
    enabled.value = a !== null
    if (!a) {
      loaded.value = true
      return
    }
    loading.value = true
    error.value = ''
    try {
      const res = await $fetch<PortalSettings>('/api/chat-settings', { headers: authHeaders(a) })
      Object.assign(settings, res)
      // Best-effort label seeding from recent chats (one extra call, settings page
      // is cold path). A failure here must not break loading the settings.
      let recent: ChatOption[] = []
      try {
        recent = (await chatFetcher('', 0)).items
      } catch { /* leave recent empty → id fallback */ }
      notifyOption.value = seedOption(settings.chat.dialogId, recent)
      errorOption.value = seedOption(settings.errorChat.dialogId, recent)
    } catch (e) {
      error.value = readError(e, 'Не удалось загрузить настройки')
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  async function save() {
    const a = frameAuth()
    if (!a) return
    saving.value = true
    error.value = ''
    try {
      await $fetch('/api/chat-settings', { method: 'POST', headers: authHeaders(a), body: settings })
    } catch (e) {
      error.value = readError(e, 'Не удалось сохранить настройки')
    } finally {
      saving.value = false
    }
  }

  return { settings, enabled, loading, saving, loaded, error, notifyOption, errorOption, chatFetcher, load, save }
}

function readError(e: unknown, fallback: string): string {
  const data = (e as { data?: { error?: string } })?.data
  return data?.error ? `${fallback}: ${data.error}` : fallback
}
