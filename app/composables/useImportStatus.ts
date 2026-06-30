import { ref } from 'vue'
import type { ImportRunSummary } from '~/types/importStatus'
import { MOCK_STATEMENT } from '~/utils/mockStatement'

// Reactive import-status holder. DEMO: until the backend poller (#5) exists,
// `refresh()` fills in a plausible recent run on the client. Real impl: client
// fetch to `${apiBase}/import/status` returning the same ImportRunSummary shape.
// Initial value is "never" so SSG prerenders a stable empty state; the client
// populates it on mount (no hydration mismatch).
export function useImportStatus() {
  const status = ref<ImportRunSummary>({
    state: 'never',
    lastSyncAt: null,
    operations: 0,
    activitiesCreated: 0,
    chatNotified: 0,
    errors: []
  })
  const loading = ref(false)

  async function refresh() {
    loading.value = true
    try {
      // DEMO mock — numbers mirror the demo statement so /app and this card agree.
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
    } finally {
      loading.value = false
    }
  }

  return { status, loading, refresh }
}
