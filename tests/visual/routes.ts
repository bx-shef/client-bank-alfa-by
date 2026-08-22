/** Маршруты визуальных регресс-тестов (#3). Вынесены из спеки отдельным модулем, чтобы юнит-тест
 *  мог сверить их со списком страниц приложения: без сверки новая страница молча осталась бы без
 *  визуальной защиты (`seoMetaPlacement.test.ts` о ней узнал бы, а этот тест — нет). */
export type VisualTheme = 'light' | 'dark'

export interface VisualRoute {
  /** Имя файла эталона. */
  slug: string
  /** Адрес на статик-сервере. */
  path: string
  /** Темы, в которых снимок ОСМЫСЛЕН. Лендинг, «Интеграторам» и страница ошибки форсируют тёмную
   *  (`data-force-dark` + `.landing-shell`), поэтому светлый снимок у них был бы бит-в-бит тем же
   *  файлом — шесть мёртвых эталонов. Перечень заодно документирует это свойство: снимут форс —
   *  набор снимков изменится, и мы об этом узнаем. */
  themes: readonly VisualTheme[]
}

// Страницы приложения закрыты `InPortalGate` — без `?preview=1` снимется заглушка «откройте внутри
// Bitrix24», то есть эталон получился бы бесполезным МОЛЧА (ровно тот провал, ради которого
// написан docs/VISUAL_VERIFICATION.md).
export const VISUAL_ROUTES: readonly VisualRoute[] = [
  { slug: 'index', path: '/', themes: ['dark'] },
  { slug: 'partners', path: '/partners', themes: ['dark'] },
  // ⚠ Справка публична, но живёт на `portal`-layout (её открывают и слайдером портала), поэтому
  // темы у неё ДВЕ, как у портальных страниц, а не одна тёмная, как у лендинга.
  { slug: 'help', path: '/help', themes: ['light', 'dark'] },
  { slug: 'error', path: '/404.html', themes: ['dark'] },
  { slug: 'app', path: '/app?preview=1', themes: ['light', 'dark'] },
  { slug: 'import', path: '/import?preview=1', themes: ['light', 'dark'] },
  { slug: 'settings', path: '/settings?preview=1', themes: ['light', 'dark'] },
  { slug: 'install', path: '/install?preview=1', themes: ['light', 'dark'] },
  { slug: 'queues', path: '/queues?preview=1', themes: ['light', 'dark'] },
  { slug: 'login', path: '/login', themes: ['light', 'dark'] }
]
