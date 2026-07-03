/**
 * Отправка цели в Яндекс.Метрику (reachGoal).
 * Единая точка вызова `ym` — чтобы не дублировать обращение к window/счётчику
 * по компонентам (см. также BriefForm: brief_submit).
 * Безопасно no-op, если Метрика не загружена или id пустой.
 */
export function useMetrikaGoal() {
  const config = useRuntimeConfig()

  function reachGoal(goal: string) {
    if (!import.meta.client) return
    const id = Number(config.public.metrikaId)
    if (!id) return
    const w = window as Window & { ym?: (...args: unknown[]) => void }
    w.ym?.(id, 'reachGoal', goal)
  }

  return { reachGoal }
}
