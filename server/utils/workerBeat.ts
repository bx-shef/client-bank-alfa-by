import { markWorkerBeat } from '../queue/connection'
import { WORKER_BEAT_INTERVAL_MS, WORKER_BEAT_TTL_SEC } from '../../app/utils/workerHeartbeat'

// Планировщик пульса воркеров (#466 §1), вынесенный из плагина ПО ТОЙ ЖЕ причине, что и
// `bankKeepAliveSchedule.ts`: внутри `defineNitroPlugin` его нельзя проверить вызовом, а ревью
// показало, что именно этого и не хватало — таймер можно было завести на пустой колбэк, и весь
// набор тестов оставался зелёным, хотя пульс никуда не писался.

export interface WorkerBeatDeps {
  /** Живы ли обработчики ПРЯМО СЕЙЧАС. Пульс без этой проверки доказывал бы лишь, что жив event
   *  loop — ту самую дыру, за которую отвергнут `getWorkers()` BullMQ. */
  running: () => boolean
  /** Записать отметку. По умолчанию — реальный Redis. */
  mark?: (id: string, ttlSec: number, nowMs: number) => Promise<void>
  now?: () => number
  warn?: (msg: string) => void
}

/**
 * Один удар пульса. Возвращает `true`, если отметка ушла.
 *
 * ⚠ Никогда не бросает. `.catch` обязан ГЛОТАТЬ, а не пробрасывать: `void promise.catch(fn)`, где
 * `fn` бросает, даёт unhandled rejection, а глобального обработчика в проекте нет — на современном
 * Node это валит воркер ровно на том сетевом блипе, который пульс и должен пережить.
 */
export function beatOnce(id: string, deps: WorkerBeatDeps): boolean {
  if (!deps.running()) return false
  const mark = deps.mark ?? markWorkerBeat
  const now = deps.now ?? Date.now
  void mark(id, WORKER_BEAT_TTL_SEC, now())
    .catch(e => deps.warn?.(`[queue] worker beat failed: ${(e as Error)?.message}`))
  return true
}

/** Завести пульс: первый удар сразу, дальше по интервалу. Таймер возвращается, чтобы вызывающий
 *  СНЯЛ его на остановке — `unref()` не отменяет таймер, а лишь не даёт держать процесс. */
export function startWorkerBeat(id: string, deps: WorkerBeatDeps): ReturnType<typeof setInterval> {
  beatOnce(id, deps)
  const timer = setInterval(() => beatOnce(id, deps), WORKER_BEAT_INTERVAL_MS)
  timer.unref?.()
  return timer
}
