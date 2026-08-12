import { vi } from 'vitest'

// Nuxt 4.5 перенёс `$fetch` из глобального объекта в build-модуль `#build/fetch`: авто-импорт в
// компонентах теперь резолвится туда, а не в `globalThis`. Наши тесты подменяют транспорт через
// `vi.stubGlobal('$fetch', …)` — после апгрейда подмена перестала перехватывать вызовы, и семь
// файлов молча ушли в ветку «не удалось загрузить» вместо проверяемого сценария.
//
// Мостик возвращает прежнюю семантику: модуль делегирует в `globalThis.$fetch`, поэтому и
// `stubGlobal`, и подсчёт вызовов мока работают как раньше. Делегирование ленивое — на момент
// загрузки модуля глобальная заглушка ещё не поставлена.
//
// ⚠ Гард проверяет `vi.isMockFunction`, а НЕ `typeof === 'function'`: в nuxt-окружении
// `globalThis.$fetch` — всегда живая `ofetch`, поэтому проверка на функцию не срабатывала бы
// никогда, и забытый (или сброшенный `unstubAllGlobals`) стаб уходил бы в НАСТОЯЩИЙ запрос →
// относительный URL → отказ → компонент в ветку ошибки. Это ровно та тихая подмена смысла, из-за
// которой тесты и сломались на апгрейде, только внесённая заново. Такое уже случалось: в
// `bankConnectCard.nuxt.test.ts` глобалы сбрасываются посреди файла.
type AnyFetch = (...args: unknown[]) => unknown

function stubbedFetch(): AnyFetch {
  const fn = (globalThis as unknown as { $fetch?: AnyFetch }).$fetch
  if (!vi.isMockFunction(fn)) {
    throw new Error('$fetch не подменён в тесте: поставьте vi.stubGlobal(\'$fetch\', vi.fn(…))')
  }
  return fn as AnyFetch
}

const delegate = ((...args: unknown[]) => stubbedFetch()(...args)) as AnyFetch

vi.mock('#build/fetch', () => ({ $fetch: delegate }))
vi.mock('#build/fetch.mjs', () => ({ $fetch: delegate }))
