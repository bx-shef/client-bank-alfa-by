import { onScopeDispose, ref } from 'vue'
import { frameAuth, frameAuthHeaders } from '~/composables/useFrameAuth'
import type { ImportBatchResult } from '~/types/importBatch'
import { POLL_INTERVAL_MS, shouldKeepPolling } from '~/utils/importBatchView'

// Опрос итогов ручных загрузок (#417). Решения о том, когда прекращать опрос и что показывать,
// живут в чистом `importBatchView.ts` — здесь только реактивность и I/O.
//
// Ключи держим в `sessionStorage`: обработка идёт в фоне, и вкладку легко перезагрузить (или
// вернуться на `/import` из портала). Без этого сотрудник, обновивший страницу, снова терял бы
// исход загрузки — ровно та проблема, ради которой всё это и делается. `session`, а не `local`:
// итог живёт минуты, а не между сессиями, и на сервере он всё равно вычищается свипом.

const STORAGE_KEY = 'cba.import.batches'

function readStored(): string[] {
  if (typeof sessionStorage === 'undefined') return []
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeStored(ids: string[]): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // Приватный режим / переполнение — опрос всё равно отработает в текущей вкладке.
  }
}

export function useImportBatches() {
  const ids = ref<string[]>([])
  const results = ref<ImportBatchResult[]>([])
  const polling = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let startedAt = 0

  function stop() {
    if (timer) clearTimeout(timer)
    timer = undefined
    polling.value = false
  }

  async function fetchOnce(): Promise<void> {
    const auth = frameAuth()
    if (!auth || !ids.value.length) return
    try {
      const res = await $fetch<{ batches?: ImportBatchResult[] }>('/api/import/batch', {
        params: { ids: ids.value.join(',') },
        headers: frameAuthHeaders(auth)
      })
      results.value = res?.batches ?? []
    } catch {
      // Транзиентный сбой опроса не должен гасить уже показанный итог — просто ждём следующий тик.
    }
  }

  function tick() {
    timer = setTimeout(async () => {
      await fetchOnce()
      if (shouldKeepPolling(ids.value, results.value, Date.now() - startedAt)) tick()
      else stop()
    }, POLL_INTERVAL_MS)
  }

  /** Начать следить за загрузками (после успешной отправки или при возвращении на страницу). */
  async function track(newIds: string[]) {
    if (!newIds.length) return
    ids.value = [...new Set([...ids.value, ...newIds])]
    writeStored(ids.value)
    stop()
    startedAt = Date.now()
    polling.value = true
    await fetchOnce()
    if (shouldKeepPolling(ids.value, results.value, 0)) tick()
    else stop()
  }

  /** Подхватить ключи из прошлой загрузки этой вкладки (после перезагрузки страницы). */
  async function restore() {
    const stored = readStored()
    if (stored.length) await track(stored)
  }

  /** Забыть отслеживаемые загрузки (новая пачка файлов). */
  function reset() {
    stop()
    ids.value = []
    results.value = []
    writeStored([])
  }

  onScopeDispose(stop)

  return { ids, results, polling, track, restore, reset }
}
