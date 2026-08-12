import { test, expect } from '@playwright/test'
import type { Server } from 'node:http'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VISUAL_ROUTES } from './routes'
// @ts-expect-error — общий модуль на JS (его же использует scripts/screenshot.mjs); типов нет,
// а заводить их ради одного вызова дороже этой строки.
import { startStaticServer } from '../../scripts/lib/staticServer.mjs'

// Визуальные регресс-тесты (#3): снимок ключевых экранов сравнивается с эталоном на каждом PR.
// Раньше «зрение» было только ручным (`pnpm screenshot`), то есть поехавшая вёрстка ловилась лишь
// тогда, когда кто-то догадался посмотреть на пиксели.
//
// Снимаем СОБРАННУЮ статику (`.output/public`), а не дев-сервер: проверять надо тот артефакт,
// который уедет за nginx, а не промежуточное состояние сборщика.

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PUBLIC_DIR = join(ROOT, '.output', 'public')

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 900 }
] as const

/** Внешние хосты, которые в кадре быть не должны. Дело не в скорости: пока снимок зависит от
 *  чужого сервера, «эталон» описывает не наш интерфейс, а сегодняшнюю доступность CDN — форма
 *  Б24 отрисовалась бы или нет в зависимости от сети раннера, и тест краснел бы без единой
 *  правки в репозитории. */
const THIRD_PARTY = /mc\.yandex\.ru|cdn[^/]*\.bitrix24\./

/** Всё, что меняется само по себе, — и потому сделало бы эталон мигающим. Каждая строка здесь
 *  закрывает конкретный источник недетерминизма, а не «на всякий случай». */
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  *:focus, *:focus-visible { outline-color: transparent !important; }
  /* Canvas ПРЯЧЕМ, а не маскируем. Маска накрывает bounding box локатора, а hero-граф лендинга —
     это абсолютный canvas во всю ширму: маской вместе с ним уезжали из проверки заголовок, обе
     CTA-кнопки и фото, то есть главный экран продукта не проверялся вовсе. Скрытый canvas
     оставляет ровно свой прямоугольник фона, а контент поверх него сверяется как обычно. */
  canvas { visibility: hidden !important; }
`

let server: Server
let port: number

test.beforeAll(async () => {
  if (!(await stat(PUBLIC_DIR).catch(() => null))) {
    throw new Error('.output/public не найден — сначала `pnpm generate`')
  }
  const started = await startStaticServer(PUBLIC_DIR)
  server = started.server
  port = started.port
})

test.afterAll(() => {
  // `close()` не рвёт keep-alive-соединения — без этого воркер висит до таймаута.
  server?.closeAllConnections?.()
  server?.close()
})

for (const theme of ['light', 'dark'] as const) {
  for (const vp of VIEWPORTS) {
    test.describe(`${theme} · ${vp.name}`, () => {
      // Фикстурой, а не ручным `newContext`: ручной контекст не привязан к тесту, поэтому при
      // падении (штатный исход визуального теста) он оставался открытым, а Playwright не
      // прикладывал ни трассу, ни видео — в CI на руках оставалась одна diff-картинка.
      test.use({
        colorScheme: theme,
        viewport: { width: vp.width, height: vp.height },
        reducedMotion: 'reduce'
      })

      for (const route of VISUAL_ROUTES.filter(r => r.themes.includes(theme))) {
        test(route.slug, async ({ page }) => {
          // Самый тяжёлый снимок — лендинг на десктопе (fullPage ≈ 7 Мпикс): дефолтных 30с в CI
          // на двух воркерах впритык, а плавающий красный дороже лишней минуты бюджета.
          test.setTimeout(90_000)
          await page.route(THIRD_PARTY, r => r.abort())

          const resp = await page.goto(`http://127.0.0.1:${port}${route.path}`, { timeout: 30_000 })
          // Без этой проверки выпавший из пререндера маршрут отдал бы страницу 404, а
          // `--update-snapshots` молча зафиксировал бы её как эталон.
          expect(resp?.status(), `${route.path} должен отдаваться статикой`).toBe(200)

          await page.addStyleTag({ content: FREEZE_CSS })
          // Шрифты — самая частая причина «дрожащего» снимка: без ожидания первый кадр приходит с
          // системным фолбэком, и эталон фиксирует не тот текст, что увидит пользователь.
          // `.then(() => undefined)` — чтобы не сериализовать host-объект `FontFaceSet`.
          await page.evaluate(() => document.fonts.ready.then(() => undefined))

          await expect(page).toHaveScreenshot(`${route.slug}.${theme}.${vp.name}.png`, {
            fullPage: true,
            mask: [
              // SHA сборки: локально «dev», в CI — хеш коммита, то есть отличался бы ВСЕГДА.
              page.locator('[data-testid="build-sha"]'),
              // Монитор очередей рисует шкалу времени от текущего момента.
              page.locator('[data-testid="queue-chart"]'),
              // Год в подвале лендинга — из системных часов: 1 января все снимки покраснели бы
              // по календарной причине, а «красное не по делу» — прямой путь к тому, что тест
              // отключат.
              page.locator('[data-testid="footer-year"]')
            ],
            animations: 'disabled'
          })
        })
      }
    })
  }
}
