import { test, expect } from '@playwright/test'
import type { Server } from 'node:http'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VISUAL_ROUTES } from './routes'
// Общий модуль на JS (его же использует scripts/screenshot.mjs) — своих типов не несёт, но под
// проверкой (#542) выводится из самого JS, так что подавлять больше нечего: `@ts-expect-error`
// здесь стал ЛОЖНЫМ и сам ронял проход.
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

/** Всё, что не наш статик-сервер, обрывается. Не перечислением хостов, а по принципу «разрешён
 *  только localhost»: список всегда отстаёт от реальности, а цена промаха высокая — пока снимок
 *  зависит от чужого сервера, эталон описывает не наш интерфейс, а сегодняшнюю доступность CDN.
 *  Живой пример: форма Б24 грузится с `cdn-ru.bitrix24.by` и занимает 800×620 — отрисуйся она на
 *  раннере, и снимок разошёлся бы на 7% площади, причём диагноз выглядел бы как регрессия вёрстки.
 *  Побочно это вчетверо ускоряет прогон: почти весь его бюджет уходил на ожидание третьей стороны. */
const LOCAL_ORIGIN = 'http://127.0.0.1'

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
      // ⚠ `reducedMotion` здесь НЕ повторяем: опции с таким именем у раннера нет (она живёт в
      // `contextOptions` и задана один раз в `playwright.config.ts`), а `contextOptions` при
      // повторе не сливается, а ЗАМЕЩАЕТСЯ — то есть «продублировав для надёжности», мы бы
      // затёрли конфиг. Прежняя строка молча не делала ничего (#542).
      test.use({
        colorScheme: theme,
        viewport: { width: vp.width, height: vp.height }
      })

      for (const route of VISUAL_ROUTES.filter(r => r.themes.includes(theme))) {
        test(route.slug, async ({ page }) => {
          // Самый тяжёлый снимок — лендинг на десктопе (fullPage ≈ 7 Мпикс): дефолтных 30с в CI
          // на двух воркерах впритык, а плавающий красный дороже лишней минуты бюджета.
          test.setTimeout(90_000)
          await page.route('**', r => (
            r.request().url().startsWith(LOCAL_ORIGIN) ? r.continue() : r.abort()
          ))

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
              // Маска нужна ровно двум вещам — обе меняются от прогона к прогону. Графику
              // (ECharts, шкала времени от «сейчас») маска НЕ нужна: он рисуется в canvas, а
              // canvas прячется целиком, и на его месте остаётся детерминированная пустота.
              // SHA сборки: локально «dev», в CI — хеш коммита, то есть отличался бы ВСЕГДА.
              page.locator('[data-testid="build-sha"]'),
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
