import { ref } from 'vue'
import type { ImportRunSummary } from '~/types/importStatus'
import { emptyImportSummary } from '~/utils/importStatus'
import { frameAuth, frameAuthHeaders } from '~/composables/useFrameAuth'

// Состояние последнего импорта (#5). `refresh()` читает реальный прогон из
// `GET /api/import/status` по фрейм-токену (та же авторизация, что у `/api/import`).
//
// ⚠ Демо-мока БОЛЬШЕ НЕТ (#415). Раньше вне портала подставлялись выдуманные цифры («12 операций,
// 8 минут назад»), чтобы страница «выглядела живой» — на деле это враньё: снаружи портала у нас
// нет ни доступа к данным, ни права их показывать. Плюс страницы приложения теперь и не
// открываются снаружи (#414, `InPortalGate`), так что подменять было бы просто нечего.
// Начальное значение — «прогонов не было»: SSG отрисует стабильное пустое состояние, клиент
// заполнит его на монтировании (без расхождения гидратации).
export function useImportStatus() {
  const status = ref<ImportRunSummary>(emptyImportSummary())
  const loading = ref(false)

  async function refresh() {
    loading.value = true
    try {
      const auth = frameAuth()
      if (!auth) {
        // Нет фрейма — нечего показывать. Честное пустое состояние вместо выдуманных цифр.
        status.value = emptyImportSummary()
        return
      }
      status.value = await $fetch<ImportRunSummary>('/api/import/status', { headers: frameAuthHeaders(auth) })
    } catch {
      // In-frame fetch error (not installed / transient) → keep the safe empty state
      // rather than crashing the status card.
      status.value = emptyImportSummary()
    } finally {
      loading.value = false
    }
  }

  return { status, loading, refresh }
}
