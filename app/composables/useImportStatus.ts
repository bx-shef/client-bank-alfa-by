import { ref } from 'vue'
import type { ImportRunSummary } from '~/types/importStatus'
import { MOCK_STATEMENT } from '~/utils/mockStatement'
import { frameAuth, frameAuthHeaders } from '~/composables/useFrameAuth'

// Reactive import-status holder (#5). IN-PORTAL: `refresh()` fetches the real last run
// from `GET /api/import/status` (B24 frame token, same auth as /api/import). STANDALONE
// (landing / preview, no frame): falls back to a demo mock so /app looks alive outside a
// portal. Initial value is "never" so SSG prerenders a stable empty state; the client
// populates it on mount (no hydration mismatch).
function emptySummary(): ImportRunSummary {
  return { state: 'never', lastSyncAt: null, operations: 0, activitiesCreated: 0, chatNotified: 0, errors: [] }
}

export function useImportStatus() {
  const status = ref<ImportRunSummary>(emptySummary())
  const loading = ref(false)

  async function refresh() {
    loading.value = true
    try {
      const auth = frameAuth()
      if (auth) {
        // In-portal: real last-run summary from the backend.
        status.value = await $fetch<ImportRunSummary>('/api/import/status', { headers: frameAuthHeaders(auth) })
        return
      }
      // Standalone/preview (no B24 frame): demo mock — numbers mirror the demo statement
      // so /app and this card agree outside a portal.
      const credits = MOCK_STATEMENT.items.filter(i => i.direction === 'credit').length
      const now = Date.now()
      status.value = {
        state: 'ok',
        lastSyncAt: new Date(now - 8 * 60 * 1000).toISOString(),
        operations: MOCK_STATEMENT.items.length,
        activitiesCreated: MOCK_STATEMENT.items.length,
        chatNotified: credits,
        errors: [],
        nextSyncAt: new Date(now + 52 * 60 * 1000).toISOString()
      }
    } catch {
      // In-frame fetch error (not installed / transient) → keep the safe empty state
      // rather than crashing the status card.
      status.value = emptySummary()
    } finally {
      loading.value = false
    }
  }

  return { status, loading, refresh }
}
