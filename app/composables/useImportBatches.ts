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

export function readStoredBatchIds(): string[] {
  if (typeof sessionStorage === 'undefined') return []
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function writeStoredBatchIds(ids: string[]): void {
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
  /** Опрос прекращён по времени, а итог так и не пришёл. */
  const timedOut = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let startedAt = 0
  // Токен запуска: `track()`/`reset()` его инкрементируют, и ответ прошлого запуска (или его
  // продолжение) не смеет ни затереть свежие результаты, ни поставить ВТОРОЙ таймер поверх
  // текущего — иначе хэндл активного теряется, и две цепочки опроса тикают параллельно, а
  // `stop()` гасит только одну.
  let runSeq = 0

  function stop() {
    if (timer) clearTimeout(timer)
    timer = undefined
    polling.value = false
  }

  async function fetchOnce(seq: number): Promise<void> {
    const auth = frameAuth()
    if (!auth || !ids.value.length) return
    try {
      const res = await $fetch<{ batches?: ImportBatchResult[] }>('/api/import/batch', {
        params: { ids: ids.value.join(',') },
        headers: frameAuthHeaders(auth)
      })
      if (seq !== runSeq) return
      results.value = res?.batches ?? []
    } catch {
      // Транзиентный сбой опроса не должен гасить уже показанный итог — просто ждём следующий тик.
    }
  }

  function tick(seq: number) {
    timer = setTimeout(async () => {
      await fetchOnce(seq)
      if (seq !== runSeq) return
      if (shouldKeepPolling(ids.value, results.value, Date.now() - startedAt)) tick(seq)
      else finish()
    }, POLL_INTERVAL_MS)
  }

  /** Опрос окончен: либо всё завершилось, либо вышло время. */
  function finish() {
    timedOut.value = shouldKeepPolling(ids.value, results.value, 0)
    stop()
    // Ключи в хранилище держим, только пока есть чего ждать: иначе вернувшийся через несколько
    // дней сотрудник (сессия вкладки живёт долго, а строки чистит суточный свип) запускал бы
    // опрос по ключам, которых на сервере уже нет, и видел «обрабатываем» для давнего импорта.
    if (!timedOut.value) writeStoredBatchIds([])
  }

  /** Начать следить за загрузками (после успешной отправки или при возвращении на страницу). */
  async function track(newIds: string[]) {
    if (!newIds.length) return
    const seq = ++runSeq
    ids.value = [...new Set([...ids.value, ...newIds])]
    writeStoredBatchIds(ids.value)
    stop()
    timedOut.value = false
    startedAt = Date.now()
    polling.value = true
    await fetchOnce(seq)
    if (seq !== runSeq) return
    if (shouldKeepPolling(ids.value, results.value, 0)) tick(seq)
    else finish()
  }

  /** Подхватить ключи из прошлой загрузки этой вкладки (после перезагрузки страницы). */
  async function restore() {
    const stored = readStoredBatchIds()
    if (stored.length) await track(stored)
  }

  /** Проверить ещё раз после того, как опрос сдался по времени. */
  async function retry() {
    if (!ids.value.length) return
    await track([...ids.value])
  }

  /** Забыть отслеживаемые загрузки (новая пачка файлов). */
  function reset() {
    runSeq++
    stop()
    ids.value = []
    results.value = []
    timedOut.value = false
    writeStoredBatchIds([])
  }

  onScopeDispose(stop)

  return { ids, results, polling, timedOut, track, restore, retry, reset }
}
