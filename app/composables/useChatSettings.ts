import { reactive, ref, watch, type Ref } from 'vue'
import { frameAuth, frameAuthHeaders, frameFetchError } from '~/composables/useFrameAuth'
import { useSettingsSync } from '~/composables/useSettingsSync'
import { defaultPortalSettings, type PortalSettings } from '~/utils/settings'
import type { RemoteSearchPage } from '~/utils/remoteSearch'

// Per-portal chat settings (notification chat + rules + error chat), persisted
// server-side in app.option under SETTINGS_KEY. Auth to our backend is the B24
// FRAME access token + domain (from the SDK); B24 scopes it to THIS portal, so
// there's no member_id to trust. Outside a portal frame there's no token → inert
// (the form falls back to defaults, persistence is a no-op).
//
// The worker reads the SAME key/shape (readAppSettingVia(call, SETTINGS_KEY)) —
// writing here is what turns notifications on for the pipeline.

type ChatOption = { value: string, label: string }

// Module-level singleton: /settings renders the same <SettingsForm/> whether the portal opened
// it in a slider or the browser navigated to it, and both must share one settings state (and not
// double-load).
// Safe as a module singleton only because these pages are CLIENT-ONLY (SSG generate,
// layout `clear`, gated on frame auth) — it never runs during SSR, so there's no
// cross-request state leak. Do NOT reuse this pattern on an SSR route.
let instance: ReturnType<typeof create> | null = null

export function useChatSettings() {
  return (instance ??= create())
}

function create() {
  const settings = reactive<PortalSettings>(defaultPortalSettings())
  const enabled = ref(false)
  const loading = ref(false)
  const saving = ref(false)
  const savedOk = ref(false) // last save succeeded (cleared when a new save starts)
  const loaded = ref(false)
  const error = ref('')
  // Seed labels for the pickers so the saved chat shows its name (not a raw id)
  // before the menu is opened. Resolved from the recent-chats list on load.
  const notifyOption = ref<ChatOption | undefined>()
  const errorOption = ref<ChatOption | undefined>()

  // Clear the "Сохранено ✓" indicator as soon as the user edits again (explicit-save UX):
  // otherwise the green "saved" would linger next to unsaved changes. One-way flag clear —
  // harmless when it fires during load() (savedOk is already false then).
  watch(settings, () => {
    if (savedOk.value) savedOk.value = false
  }, { deep: true })

  /** Search transport for the chat pickers (AsyncSearchSelect fetcher). Hits the
   *  backend proxy with the frame token; inert (empty) outside the portal. */
  async function chatFetcher(query: string, offset: number, signal?: AbortSignal): Promise<RemoteSearchPage<ChatOption>> {
    const a = frameAuth()
    if (!a) return { items: [], hasMore: false }
    const res = await $fetch<{ items: ChatOption[], hasMore: boolean, nextOffset?: number }>('/api/chat-search', {
      headers: frameAuthHeaders(a),
      params: { q: query, offset },
      signal
    })
    return { items: res.items, hasMore: res.hasMore, nextOffset: res.nextOffset }
  }

  /** Resolve a saved dialog id to a {value,label} for the picker WITHOUT a round-trip:
   *  the cached title (stored at pick time), else the name from the recent list.
   *  `undefined` means "name unknown here" — the caller asks the portal (below). */
  function seedOption(dialogId: string, title: string | undefined, recent: ChatOption[]): ChatOption | undefined {
    if (!dialogId) return undefined
    if (title) return { value: dialogId, label: title }
    return recent.find(c => c.value === dialogId)
  }

  /** Ask the portal for a chat's title (im.dialog.get via our proxy). Used only when
   *  neither the cached title nor the recent list knows it — a chat configured long
   *  ago and since gone quiet otherwise showed as the raw `chat123`, which tells the
   *  admin nothing about what is configured. Falls back to the id if the portal can't
   *  resolve it (deleted chat / no access) — the value must stay selectable either way. */
  async function resolveOption(dialogId: string): Promise<ChatOption> {
    const a = frameAuth()
    if (a) {
      try {
        const res = await $fetch<{ item: ChatOption | null }>('/api/chat-search', {
          headers: frameAuthHeaders(a),
          params: { id: dialogId }
        })
        if (res.item?.label) return res.item
      } catch { /* fall through to the id */ }
    }
    return { value: dialogId, label: dialogId }
  }

  /** Resolve one picker's missing title and apply it — but ONLY if the id it was asked
   *  about is still the configured one. `load()` re-runs on the cross-instance pull, so a
   *  slow lookup from the previous run could otherwise paste the OLD chat's name onto the
   *  NEW chat's id — and that wrong name would be saved into app.option on the next Save. */
  async function adoptTitle(key: 'chat' | 'errorChat', target: Ref<ChatOption | undefined>): Promise<void> {
    const dialogId = settings[key].dialogId
    if (!dialogId || target.value) return
    const opt = await resolveOption(dialogId)
    if (settings[key].dialogId !== dialogId) return
    target.value = opt
    // Cache the REAL name only: writing the raw id here would teach `seedOption` to treat it
    // as a known title forever, and the portal would never be asked again.
    if (opt.label !== opt.value) settings[key].title = opt.label
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
      const res = await $fetch<PortalSettings>('/api/chat-settings', { headers: frameAuthHeaders(a) })
      Object.assign(settings, res)
      // Best-effort label seeding from recent chats (one extra call, settings page
      // is cold path). A failure here must not break loading the settings.
      let recent: ChatOption[] = []
      try {
        recent = (await chatFetcher('', 0)).items
      } catch { /* leave recent empty → id fallback */ }
      notifyOption.value = seedOption(settings.chat.dialogId, settings.chat.title, recent)
      errorOption.value = seedOption(settings.errorChat.dialogId, settings.errorChat.title, recent)
      // Names still unknown → ask the portal. In PARALLEL: they are independent, and
      // serialized they would hold the form on «Загрузка настроек…» for both round-trips.
      // Cache the title back into the settings so the next open is free — the same field
      // the picker writes when a chat is chosen by hand.
      await Promise.all([
        adoptTitle('chat', notifyOption),
        adoptTitle('errorChat', errorOption)
      ])
    } catch (e) {
      error.value = frameFetchError(e, 'Не удалось загрузить настройки')
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  async function save() {
    const a = frameAuth()
    if (!a) return
    saving.value = true
    savedOk.value = false
    error.value = ''
    try {
      await $fetch('/api/chat-settings', { method: 'POST', headers: frameAuthHeaders(a), body: settings })
      savedOk.value = true
      // Nudge other open instances (a second admin's form) to re-read — best-effort,
      // never throws; a pull failure must not surface as a save error.
      await useSettingsSync().notifyReload()
    } catch (e) {
      error.value = frameFetchError(e, 'Не удалось сохранить настройки')
    } finally {
      saving.value = false
    }
  }

  return { settings, enabled, loading, saving, savedOk, loaded, error, notifyOption, errorOption, chatFetcher, load, save }
}
