import { ref } from 'vue'
import { frameAuth, frameAuthHeaders as authHeaders } from '~/composables/useFrameAuth'
import type { ErasePeriod } from '~/utils/eraseActivities'

// Стирание дел, созданных приложением (#576 п.4). Два РАЗНЫХ маршрута — посчитать и стереть, —
// и здесь это тоже две функции: подсчёт структурно не умеет удалять.
//
// ⚠ Вне портала инертно: фрейм-токена нет, и оба действия невозможны.

export interface EraseCount {
  count: number
  /** Под отбор попадает больше, чем можно стереть за один вызов. */
  capped: boolean
}

export function useEraseActivities() {
  const counting = ref(false)
  const erasing = ref(false)
  const error = ref('')
  /** Сколько дел попадёт под удаление; `null` — ещё не считали. */
  const pending = ref<EraseCount | null>(null)
  /** Итог последнего стирания; `null` — ещё не стирали. */
  const result = ref<{ deleted: number, remaining: number } | null>(null)

  function query(period: ErasePeriod, accounts: string[]): Record<string, unknown> {
    const q: Record<string, unknown> = {}
    if (period.from) q.from = period.from
    if (period.to) q.to = period.to
    if (accounts.length) q.accounts = accounts
    return q
  }

  /** Посчитать, ничего не меняя. Всегда предшествует стиранию — это требование владельца. */
  async function count(period: ErasePeriod, accounts: string[]): Promise<boolean> {
    const a = frameAuth()
    if (!a) {
      error.value = 'Действие доступно только внутри портала Bitrix24'
      return false
    }
    counting.value = true
    error.value = ''
    // ⚠ Прошлый итог сбрасываем: «удалено 300» рядом со свежим подсчётом читалось бы так, будто
    // это и есть результат нового отбора.
    result.value = null
    try {
      pending.value = await $fetch<EraseCount>('/api/activities/erasable', {
        headers: authHeaders(a), query: query(period, accounts)
      })
      return true
    } catch {
      pending.value = null
      error.value = 'Не удалось посчитать дела — попробуйте ещё раз'
      return false
    } finally {
      counting.value = false
    }
  }

  /** Стереть. НЕОБРАТИМО. */
  async function erase(period: ErasePeriod, accounts: string[]): Promise<boolean> {
    const a = frameAuth()
    if (!a) {
      error.value = 'Действие доступно только внутри портала Bitrix24'
      return false
    }
    erasing.value = true
    error.value = ''
    try {
      result.value = await $fetch<{ deleted: number, remaining: number }>('/api/activities/erase', {
        method: 'POST',
        headers: authHeaders(a),
        body: { ...query(period, accounts) }
      })
      // ⚠ Подтверждение снимаем ВСЕГДА после стирания: оставленное число относилось к состоянию
      // ДО удаления, и второй клик по «Стереть» удалил бы уже не то, что было обещано.
      pending.value = null
      return true
    } catch {
      error.value = 'Не удалось стереть дела — попробуйте ещё раз'
      return false
    } finally {
      erasing.value = false
    }
  }

  return { counting, erasing, error, pending, result, count, erase }
}
