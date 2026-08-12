import { vi } from 'vitest'

// Nuxt 4.5 перенёс `$fetch` из глобального объекта в build-модуль `#build/fetch`: авто-импорт в
// компонентах теперь резолвится туда, а не в `globalThis`. Наши тесты подменяют транспорт через
// `vi.stubGlobal('$fetch', …)` — после апгрейда подмена перестала перехватывать вызовы, и семь
// файлов молча ушли в ветку «не удалось загрузить» вместо проверяемого сценария.
//
// Мостик возвращает прежнюю семантику: модуль делегирует в `globalThis.$fetch`, поэтому и
// `stubGlobal`, и подсчёт вызовов мока работают как раньше. Делегирование ленивое — на момент
// загрузки модуля глобальная заглушка ещё не поставлена.
type AnyFetch = ((...args: unknown[]) => unknown) & Record<string, unknown>

const delegate = ((...args: unknown[]) => {
  const fn = (globalThis as unknown as { $fetch?: AnyFetch }).$fetch
  if (typeof fn !== 'function') throw new Error('$fetch не подменён в тесте (vi.stubGlobal)')
  return fn(...args)
}) as AnyFetch

for (const key of ['raw', 'create', 'native'] as const) {
  delegate[key] = (...args: unknown[]) => {
    const fn = (globalThis as unknown as { $fetch?: AnyFetch }).$fetch
    const method = fn?.[key]
    if (typeof method !== 'function') throw new Error(`$fetch.${key} не подменён в тесте`)
    return (method as (...a: unknown[]) => unknown)(...args)
  }
}

vi.mock('#build/fetch', () => ({ $fetch: delegate }))
vi.mock('#build/fetch.mjs', () => ({ $fetch: delegate }))
