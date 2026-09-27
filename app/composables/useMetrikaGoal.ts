import { resolveMetrikaId } from '~/utils/metrika'

/**
 * Отправка цели в Яндекс.Метрику (reachGoal).
 * Единая точка вызова `ym` — чтобы не дублировать обращение к window/счётчику
 * по компонентам (им пользуется и `BriefForm`: brief_submit).
 * Безопасно no-op, если Метрика не загружена или id пустой.
 *
 * ⚠ Id — через `resolveMetrikaId`, ту же функцию, по которой `nuxt.config.ts` вставляет сниппет.
 * Сырое значение конфига на проде пустое (пустая переменная сборки перекрывает умолчание), и пока
 * цель брала его как есть, с #701 не ушла ни одна — при работающем счётчике.
 */
export function useMetrikaGoal() {
  const config = useRuntimeConfig()
  const localMode = useLocalMode()

  function reachGoal(goal: string) {
    if (!import.meta.client) return
    const id = Number(resolveMetrikaId(config.public.metrikaId, localMode))
    if (!id) return
    const w = window as Window & { ym?: (...args: unknown[]) => void }
    w.ym?.(id, 'reachGoal', goal)
  }

  return { reachGoal }
}
