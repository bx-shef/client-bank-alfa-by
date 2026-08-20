import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ⚠ Юнит-тесты не типизировались НИЧЕМ (#527), и это не безобидно: тест проверяет поведение, а тип
// описывает контракт с production-кодом, и разъезжаются они молча. Живой пример, ради которого
// issue и заведена, — мок DI-порта, который ничего не возвращал (`Promise<void>` вместо
// `Promise<boolean>`): пока код результат не смотрел, разницы не было, а как только стал —
// молчаливый `undefined` начал означать «портал удалён», то есть ровно обратное тому, что
// утверждали три теста. Мок, чей неверный тип не меняет наблюдаемого результата, прошёл бы
// незамеченным и оставил зелёный тест, ничего не проверяющий.
//
// ⚠ Проверка структурная, а не «прогнали и всё хорошо»: сам прогон типов живёт в `pnpm typecheck`,
// и потерять его можно ровно одним способом — тихо сузив охват в конфиге. Именно это здесь и
// стережётся.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

describe('юнит-тесты покрыты typecheck (#527)', () => {
  const cfg = JSON.parse(read('tsconfig.tests.json')) as {
    include: string[]
    exclude: string[]
    compilerOptions?: Record<string, unknown>
  }

  it('охват включает tests/** — иначе проверять нечего', () => {
    expect(cfg.include).toContain('./tests/**/*')
  })

  it('исключены ровно те два каталога, у которых ЕСТЬ свой проход', () => {
    // ⚠ `tests/nuxt/**` покрыт app-проходом (он в `include` корневого tsconfig), `tests/visual/**` —
    // это Playwright со своим окружением и своим `lib`. Всё остальное исключать нельзя: исключение
    // здесь означает «эти тесты снова никто не типизирует», а именно так дефект и появился.
    expect(new Set(cfg.exclude)).toEqual(new Set(['./node_modules', './dist', './tests/nuxt/**', './tests/visual/**']))
  })

  it('послабление ровно одно и оно названо', () => {
    // ⚠ `noUncheckedIndexedAccess` выключен СОЗНАТЕЛЬНО, и это не «чтобы собралось». В production
    // `arr[0]` без проверки — тихий баг, поэтому там строгость нужна. В тесте `expect(calls[0])` с
    // `undefined` роняет сам тест, то есть строгость не ловит ничего, чего не поймал бы прогон, —
    // зато требует 56 восклицательных знаков по ассертам и приучает руку писать `!`, который потом
    // утекает в production, где он опасен. Остальные строгие флаги — без изменений.
    expect(cfg.compilerOptions).toEqual({ noUncheckedIndexedAccess: false })
  })

  it('проход подключён к `pnpm typecheck`, а не живёт отдельной командой, о которой забудут', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts.typecheck, 'tests-проход не в `pnpm typecheck` — CI его не запустит')
      .toContain('tsconfig.tests.json')
  })
})
