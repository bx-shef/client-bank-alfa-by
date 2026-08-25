import { ref } from 'vue'
import { frameAuth, frameAuthHeaders as authHeaders } from '~/composables/useFrameAuth'
import type { StatementItem } from '~/types/statement'

// «Последние операции» для главного экрана (#5/#36): читает реестр «Платежи» портала через
// `/api/import/operations` по фрейм-токену. Вне фрейма инертно — нет токена, показываем пусто.
//
// ⚠ Витрина, а не источник истины: сервер отдаёт уже развёрнутые StatementItem (маппинг из СП там),
// клиент только рисует. `configured=false` — СП не создан, список честно пуст.

interface OperationsResponse {
  operations?: StatementItem[]
  configured?: boolean
}

export function useRecentOperations() {
  const operations = ref<StatementItem[]>([])
  /** Настроен ли СП «Платежи»: `false` ⇒ читать неоткуда (не поднят провижинингом). */
  const configured = ref(true)
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  async function load(): Promise<void> {
    const a = frameAuth()
    if (!a) {
      // Вне портала спрашивать некого — пустая витрина, проверка завершена.
      operations.value = []
      loaded.value = true
      return
    }
    loading.value = true
    error.value = ''
    try {
      const res = await $fetch<OperationsResponse>('/api/import/operations', { headers: authHeaders(a) })
      operations.value = Array.isArray(res?.operations) ? res.operations : []
      configured.value = res?.configured !== false
    } catch {
      error.value = 'Не удалось загрузить последние операции'
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  return { operations, configured, loading, loaded, error, load }
}
