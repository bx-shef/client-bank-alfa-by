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
  truncated?: boolean
}

export function useRecentOperations() {
  const operations = ref<StatementItem[]>([])
  /** Настроен ли СП «Платежи»: `false` ⇒ читать неоткуда (не поднят провижинингом). */
  const configured = ref(true)
  /** Сколько операций попало в период (#42) — число для подписи. */
  const total = ref<number | null>(null)
  /** Портал отдал НЕ ВСЕ операции периода (страница реестра фиксированная). Считает СЕРВЕР по сырой
   *  странице: сравнивать `total` с длиной списка нельзя — маппер отбрасывает битые элементы, и один
   *  испорченный руками элемент объявлял бы обрезку там, где её нет, с невыполнимым советом. */
  const truncated = ref(false)
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  // ⚠ Токен последовательности: период переключают кликами, и медленный ответ ПРЕДЫДУЩЕГО периода
  // приходил бы после быстрого — на экране оставался бы список одного срока под подписью другого.
  // Ровно то состояние, ради запрета которого сервер отвечает 400 на кривую границу; тот же приём
  // стоит в `LandingDemo` (`runSeq`) и в `useChatSettings`.
  let seq = 0

  async function load(range: DayRange = { from: '', to: '' }): Promise<void> {
    const my = ++seq
    const a = frameAuth()
    if (!a) {
      // Вне портала спрашивать некого — пустая витрина, проверка завершена.
      operations.value = []
      total.value = null
      truncated.value = false
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
      if (my !== seq) return
      operations.value = Array.isArray(res?.operations) ? res.operations : []
      configured.value = res?.configured !== false
      total.value = typeof res?.total === 'number' ? res.total : null
      truncated.value = res?.truncated === true
    } catch {
      if (my !== seq) return
      // ⚠ Список ОЧИЩАЕТСЯ. Оставить прежний значило бы показать операции СТАРОГО периода под
      // подписью нового — отказ выглядел бы данными, и «за сегодня 50 платежей» читалось бы как
      // правда. Ошибку страница обязана показать (`error` рендерится в карточке).
      operations.value = []
      total.value = null
      truncated.value = false
      error.value = 'Не удалось загрузить операции за выбранный период'
    } finally {
      if (my === seq) loading.value = false
      loaded.value = true
    }
  }

  return { operations, configured, total, truncated, loading, loaded, error, load }
}
