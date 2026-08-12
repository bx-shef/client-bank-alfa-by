import { defineConfig, devices } from '@playwright/test'

// Визуальные регресс-тесты (#3). «Зрение» у нас было только ручным (`pnpm screenshot`), поэтому
// поехавшая вёрстка ловилась лишь тем, что кто-то догадался посмотреть на пиксели. Здесь тот же
// снимок, но сравниваемый с эталоном на каждом PR.
//
// ⚠ Эталоны привязаны к КОНКРЕТНОЙ сборке Chromium (её пинит версия playwright) и к рендерингу
// шрифтов в окружении. Поэтому джоба в CI ставит браузер тем же `playwright install`, а не берёт
// системный: иначе эталоны, снятые локально, не сойдутся с CI ни разу и тест выродится в шум.
export default defineConfig({
  testDir: './tests/visual',
  outputDir: './tests/visual/.artifacts',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Ретраи НЕ ставим: визуальный тест детерминирован по построению, и «со второго раза сошлось»
  // означало бы, что снимок мигает — то есть эталон бесполезен и это надо чинить, а не прятать.
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  expect: {
    toHaveScreenshot: {
      // Допуск на сглаживание и субпиксельный рендер шрифтов: попиксельное равенство между
      // машинами недостижимо, а нулевой допуск дал бы красный CI на каждом прогоне. Порог мал
      // настолько, что реальные регрессии (уехавший блок, пропавшая кнопка, чёрное по чёрному)
      // выходят за него на порядки.
      maxDiffPixelRatio: 0.01,
      threshold: 0.2
    }
  },
  use: {
    ...devices['Desktop Chrome'],
    // Анимации глушим на уровне браузера (плюс CSS-врезка в самом тесте): без этого снимок ловит
    // случайный кадр и «регрессия» появляется на ровном месте.
    reducedMotion: 'reduce',
    timezoneId: 'Europe/Minsk',
    locale: 'ru-RU'
  }
})
