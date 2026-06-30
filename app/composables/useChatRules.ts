import { computed, ref, watch } from 'vue'
import type { ChatNotifyRules } from '~/utils/statement'
import type { OperationDirection } from '~/types/statement'

// Reactive app settings persisted to localStorage (client-side, demo). The real
// API key + chat target live server-side once the backend/SDK lands; here we
// wire the UI and the chat-notify filter (pure logic in utils/statement.ts).
const STORAGE_KEY = 'cb_settings_v1'

export interface AppSettings {
  /** Alfa API key per "my company" — stored locally for the demo only. */
  apiKey: string
  /** Selected chat target id (from config/chat MOCK_CHATS for now). */
  chatId: string
  directions: OperationDirection[]
  excludeAccounts: string[]
  excludePurposePatterns: string[]
}

export function defaultSettings(): AppSettings {
  return { apiKey: '', chatId: '', directions: ['credit'], excludeAccounts: [], excludePurposePatterns: [] }
}

// Module-level singleton so settings are shared across pages. Safe here because
// the app is SSG (one prerender pass, no per-request isolation needed); the load
// is guarded to the client. Tests must reset it (settings.value = defaultSettings()
// + localStorage.clear()) in beforeEach.
const settings = ref<AppSettings>(defaultSettings())
let initialized = false

/** Persisted subset — the API key is NEVER written to localStorage (it would be
 * exposed to any script/DevTools); it stays in memory for the demo session only.
 * The real key lives server-side (backend stage). */
function persistable(s: AppSettings) {
  const { apiKey: _apiKey, ...rest } = s
  return rest
}

export function useChatRules() {
  if (import.meta.client && !initialized) {
    initialized = true
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) settings.value = { ...defaultSettings(), ...JSON.parse(raw) }
    } catch {
      // Corrupt/blocked storage — fall back to defaults.
    }
    watch(settings, (value) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable(value)))
      } catch {
        // Storage unavailable (private mode / quota) — keep working in memory.
      }
    }, { deep: true })
  }

  /** Pure ChatNotifyRules derived from the editable settings. */
  const rules = computed<ChatNotifyRules>(() => ({
    directions: settings.value.directions,
    excludeAccounts: settings.value.excludeAccounts,
    excludePurposePatterns: settings.value.excludePurposePatterns
  }))

  return { settings, rules }
}
