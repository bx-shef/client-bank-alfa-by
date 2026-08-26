import { ref } from 'vue'
import { frameAuth, frameAuthHeaders as authHeaders } from '~/composables/useFrameAuth'
import type { StatementItem } from '~/types/statement'
import type { DayRange } from '~/utils/operationPeriod'

// «Последние операции» для главного экрана (#5/#36): читает реестр «Платежи» портала через
// `/api/import/operations` по фрейм-токену. Вне фрейма инертно — нет токена, показываем пусто.
//
// ⚠ Витрина, а не источник истины: сервер отдаёт уже развёрнутые StatementItem (маппинг из СП там),
// клиент только рисует. `configured=false` — СП не создан, список честно пуст.

interface OperationsResponse {
  operations?: StatementItem[]
  configured?: boolean
  total?: number | null
}

export function useRecentOperations() {
  const operations = ref<StatementItem[]>([])
  /** Настроен ли СП «Платежи»: `false` ⇒ читать неоткуда (не поднят провижинингом). */
  const configured = ref(true)
  /** Сколько операций попало в период (#42). Больше длины списка ⇒ портал отдал только первую
   *  страницу, и витрина обязана это сказать, а не выдавать обрезок за весь период. */
  const total = ref<number | null>(null)
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  async function load(range: DayRange = { from: '', to: '' }): Promise<void> {
    const a = frameAuth()
    if (!a) {
      // Вне портала спрашивать некого — пустая витрина, проверка завершена.
      operations.value = []
      total.value = null
      loaded.value = true
      return
    }
    loading.value = true
    error.value = ''
    try {
      const res = await $fetch<OperationsResponse>('/api/import/operations', {
        headers: authHeaders(a),
        query: { from: range.from, to: range.to }
      })
      operations.value = Array.isArray(res?.operations) ? res.operations : []
      configured.value = res?.configured !== false
      total.value = typeof res?.total === 'number' ? res.total : null
    } catch {
      error.value = 'Не удалось загрузить последние операции'
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  return { operations, configured, total, loading, loaded, error, load }
}
