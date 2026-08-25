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
  /**
   * Прокручивается ли страница ВНУТРЕННИМ контейнером, а не документом (#630).
   *
   * ⚠ Поле обязательное и проверяется в обе стороны — это не документация, а ГАРД. `fullPage`
   * снимает документ, поэтому у страницы под b24ui-оболочкой (`B24DashboardGroup` =
   * `fixed inset-0 flex overflow-hidden`) эталон равнялся первому экрану, а всё ниже не
   * проверялось ни разу. Спека такие страницы «раскатывает» перед снимком.
   *
   * ⚠ Само по себе «раскатали — и ничего не осталось» НЕ доказывает, что мы сняли всю страницу:
   * то же самое видно на странице, которая просто не успела отрисоваться, и тогда проверка
   * проходит ВПУСТУЮ. Замерено: так и случилось — при ожидании только `load` один прогон из
   * четырёх снял короткий экран и совпал со старым эталоном. Поэтому спека сверяет ФАКТ с этим
   * полем: у `true` внутренний скроллер обязан найтись, у `false` — обязан отсутствовать.
   */
  unrolls: boolean
}

// Страницы приложения закрыты `InPortalGate` — без `?preview=1` снимется заглушка «откройте внутри
// Bitrix24», то есть эталон получился бы бесполезным МОЛЧА (ровно тот провал, ради которого
// написан docs/VISUAL_VERIFICATION.md).
export const VISUAL_ROUTES: readonly VisualRoute[] = [
  { slug: 'index', path: '/', themes: ['dark'], unrolls: false },
  { slug: 'partners', path: '/partners', themes: ['dark'], unrolls: false },
  // ⚠ Справка публична, но живёт на `portal`-layout (её открывают и слайдером портала), поэтому
  // темы у неё ДВЕ, как у портальных страниц, а не одна тёмная, как у лендинга.
  { slug: 'help', path: '/help', themes: ['light', 'dark'], unrolls: false },
  { slug: 'error', path: '/404.html', themes: ['dark'], unrolls: false },
  { slug: 'app', path: '/app?preview=1', themes: ['light', 'dark'], unrolls: false },
  { slug: 'import', path: '/import?preview=1', themes: ['light', 'dark'], unrolls: false },
  // ⚠ Единственная страница под `B24DashboardGroup`: документ 900 при содержимом 2118.
  { slug: 'settings', path: '/settings?preview=1', themes: ['light', 'dark'], unrolls: true },
  { slug: 'install', path: '/install?preview=1', themes: ['light', 'dark'], unrolls: false },
  { slug: 'queues', path: '/queues?preview=1', themes: ['light', 'dark'], unrolls: false },
  { slug: 'login', path: '/login', themes: ['light', 'dark'], unrolls: false }
]
