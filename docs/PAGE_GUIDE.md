# Гайд: как создавать новые страницы в нужном виде и дизайне

> Last reviewed: 2026-07-05

Приложение живёт в **двух визуальных контекстах**. Прежде чем делать страницу,
определи, к какому она относится — от этого зависит layout, тема и стиль.

| Контекст | Что это | Layout | Тема | Примеры |
|----------|---------|--------|------|---------|
| **Публичный лендинг** | маркетинговая страница `/` | `landing` | тёмная брендовая (форс-dark) | `app/pages/index.vue` |
| **In-portal / оператор** | UI внутри iframe Bitrix24 и служебные страницы | `clear` | b24ui light/dark-auto | `/app`, `/settings`, `/install`, `/login`, `/queues` |

> Родственный дизайн-гайд основного сайта — `bx-shef/Lp` → `docs/LANDING_GUIDE.md`.
> Оболочка лендинга портирована оттуда; общий вид держим синхронно.

---

## 1. Лендинг-страница (тёмная брендовая оболочка)

Так выглядит `offer.bx-shef.by`. Используем для публичных маркетинговых страниц.

**Как подключить:**

```vue
<script setup lang="ts">
definePageMeta({ layout: 'landing' })
useCardGlow() // подсветка-glow за курсором на карточках data-glow-card
</script>
```

Layout `app/layouts/landing.vue` даёт: `B24Header` (логотип `AppLogo` +
навигация), `B24Footer` (`SiteFooter` + GitHub), визитку `BusinessCardModal`.

**Тема форсится только для лендинга** — не глобально:

- `landing.vue` через `useHead` ставит `htmlAttrs: { class: 'dark',
  'data-force-dark': 'true' }`;
- `theme-init` в `app/app.vue` уважает флаг (не перекрашивает под тему ОС);
- брендовый фон/токены в `app/assets/css/main.css` скоуплены на
  `html[data-force-dark] body` и `.landing-shell` — **in-portal страницы не
  трогает** (важно: НЕ вешать эти правила на глобальный `body`/`.dark`).

**Стиль контента** (см. `app/pages/index.vue` как эталон):

- секции `px-[22px] lg:px-8 py-[56px] sm:py-[72px]`, контейнер `max-w-[1080px] mx-auto`;
- карточки `rounded-2xl border border-white/10 bg-white/[0.03]`, интерактивные —
  с атрибутом `data-glow-card`;
- заголовки `text-white`, вторичный текст `text-white/65`, моно-подписи
  `font-mono text-white/40`;
- акценты — `text-[rgb(var(--color-accent-primary-ch))]` (cyan) и т.п.
  (токены `--color-accent-*-ch` в `main.css`);
- кнопки — `B24Button` c `air-primary` / `air-secondary-no-accent` /
  `air-tertiary-no-accent`;
- анимация фона — `HeroGraph` (правила ниже, §3).

**Контент — в едином источнике** `app/utils/landing.ts` (`LANDING_*`), оттуда же
берёт SEO `app/app.vue`. Не дублируем строки в шаблоне и в `useSeoMeta` — иначе
H1 и `<title>` разъедутся. Всё покрываем тестами (`tests/landing.test.ts`).

## 2. In-portal / служебная страница (b24ui)

Для страниц внутри портала и служебной зоны оператора. Так выглядят `/app`,
`/login`, `/queues`.

```vue
<script setup lang="ts">
definePageMeta({ layout: 'clear' })
// в портале — useB24().init() (no-op вне фрейма) + setTitle/fitWindow в try/catch
</script>
```

- Layout `app/layouts/clear.vue` — `<B24App>` для тем/тостов, без хрома лендинга.
- Тема — **b24ui light/dark-auto** (`app.config.ts: colorModeInitialValue:
  'auto'`). Никакого форс-dark — эти страницы должны уважать выбор/ОС пользователя.
- Верстаем на **b24ui-компонентах** (`B24Card`, `B24Button`, `B24Input`,
  `B24Alert`, `B24Select`, …) и b24ui-токенах (`--b24ui-color-*`,
  `--ui-color-*`), а не на брендовых `--color-accent-*-ch` (те — для лендинга).
- Данные из API рендерим только через `{{ }}` (auto-escape), без `v-html`.
- Новый роут добавляем в `nitro.prerender.routes` (`nuxt.config.ts`), если на
  него не ведёт ссылка с главной (иначе SSG-краулер его пропустит).
- Служебные страницы (оператор) прячем за `middleware: auth` + `AuthGate`.

> **Официальные AI-ресурсы b24ui и b24jssdk — сверяться перед вёрсткой in-portal-страниц.**
> Разработчики b24ui ведут гайд для агентов, набор навыков и `llms.txt`-индексы:
> - [`bitrix24/b24ui/AGENTS.md`](https://github.com/bitrix24/b24ui/blob/main/AGENTS.md) — конвенции
>   компонентов, **семантические цвет-токены** (`text-default` и т.п., НЕ сырые Tailwind-палитры),
>   `useComponentProps()` для тем-осознанных дефолтов, паттерны форм/размеров, чек-лист компонента;
> - [`bitrix24/b24ui/skills/`](https://github.com/bitrix24/b24ui/tree/main/skills) — трекаемые
>   agent-скиллы по работе с b24ui;
> - [b24ui `llms.txt`](https://bitrix24.github.io/b24ui/llms.txt) — LLM-индекс: 125+ компонентов,
>   composables, темизация/CSS-переменные, i18n, интеграции;
> - [b24jssdk `llms.txt`](https://bitrix24.github.io/b24jssdk/llms.txt) — LLM-индекс SDK встройки:
>   `B24Frame` (iframe-приложения), `callV2/callBatch`, `fetchList`, вебхуки/OAuth, примеры.
>
> Это первоисточник по «как правильно» на b24ui/b24jssdk. Наш `PAGE_GUIDE` — как оно ложится на
> **это** приложение (layout `clear`, темы, `useB24`, авторизация); по самим компонентам/токенам и
> API SDK — сверяемся с `AGENTS.md`/`skills`/`llms.txt`. Точные сигнатуры REST-методов — через
> MCP `b24-dev-mcp`.

## 3. Анимация фона (`HeroGraph`) — обязательные правила

Красиво, но не грузит браузер. Любая canvas-анимация обязана:

- уважать `prefers-reduced-motion` (один статичный кадр);
- пауза при скрытой вкладке (`visibilitychange`) и когда канвас вне вида
  (`IntersectionObserver`);
- троттлинг **рендера** до ~30fps (физика может каждый кадр — дёшево);
- полная очистка в `onUnmounted` (RAF/обсерверы/слушатели);
- репеллер зоны фото и на desktop, и на мобиле (узлы/частицы не лезут на портрет);
- статичные градиенты (glow узлов) — pre-baked offscreen-спрайты + `drawImage`,
  не `createRadialGradient` каждый кадр.

Текущая анимация — «импульсы из внешних узлов (банки/выписка/CRM) в центральный
хаб Bitrix24». Хаб держим в открытой зоне, не за фото.

## 4. Форма заявки и CSP

- Форма — встроенная CRM-форма Bitrix24 в **изолированном** same-origin
  документе `public/b24-form.html`, который nginx отдаёт со **своим**
  form-scoped CSP (`location = /b24-form.html`). Строгий CSP страницы при этом
  не ослабляем.
- URL iframe строит чистый `app/utils/b24Form.ts` (`buildB24FormSrc` — allowlist
  хостов Б24 + валидация id/secret, покрыт тестами). Пустой конфиг ⇒ слот-плейсхолдер.
- Любые внешние домены (Метрика, капча и т.п.) добавляем в CSP **точечно**: для
  страницы — в основной CSP `nginx.conf`; для формы — только в её `location`-CSP.
- Inline-скрипты (Метрика/theme-init) разрешаются по sha256, которые
  `scripts/csp-hashes.mjs` считает из собранного HTML — новый inline-скрипт
  подхватывается автоматически, руками хэш вписывать не надо.

## 5. Доступность (a11y) модалок

Модалка (напр. визитка) — настоящий диалог: `role="dialog"`, `aria-modal`,
`aria-labelledby`; фокус переводится внутрь при открытии и возвращается на
триггер при закрытии; focus-trap на `Tab`; `Esc` закрывает; скролл body
блокируется. Эталон — `app/components/BusinessCardModal.vue`.

## 6. Конвенции репозитория (кратко)

- Чистая логика → `app/utils/*` (+тесты), реактивная → `app/composables/*`,
  данные/константы → `app/config/*`, типы → `app/types/*`, UI → компоненты/страницы.
- Комментарии/JSDoc — на английском; пользовательский текст и `.md` — на русском.
- Каждый `.md` в корне и `docs/` несёт штамп `> Last reviewed: YYYY-MM-DD` сразу
  под H1 (проверяет `tests/mdReviewStamp.test.ts`).
- Цели Метрики — только через `useMetrikaGoal().reachGoal()`, snake_case.

## 7. Процесс и Definition of Done

1. Определи контекст страницы (лендинг vs in-portal) и возьми нужный layout.
2. Контент лендинга — в `app/utils/landing.ts` (единый источник), покрой тестом.
3. Реализуй; чистые куски вынеси в `utils` + тесты.
4. **Визуальная верификация обязательна:** `pnpm generate && pnpm screenshot` →
   смотреть `screenshots/` (mobile/desktop × light/dark), для модалок/анимации —
   отдельный кадр. Не верить «собралось без ошибок».
5. Прогони `pnpm check` (= `lint` + `typecheck` + `test`) — зелёные.
6. **5 проверяющих ревью** (perf/lifecycle, ссылки/навигация, визуал/UX,
   deploy/CSP/тема, correctness/a11y) → замечания устранить.
7. PR (в `main` только через PR); после зелёного CI — squash-merge. Деплой —
   GHCR + Watchtower (см. `docs/DEPLOY.md`).

## 8. Частые грабли

- Глобальный форс-dark ломает in-portal страницы — форсим тему **только** на
  лендинге через `data-force-dark`.
- Брендовый фон, повешенный на `.landing-shell` (клиентский класс на `B24App`),
  появляется после гидрации — вешаем на `html[data-force-dark] body`, чтобы он
  был в SSR-кадре.
- Хардкод H1 в шаблоне расходится с SEO-`title` — держим единый источник.
- Инлайн-копия проверок в `public/b24-form.html` может разойтись с
  `app/utils/b24Form.ts` — их сверяет drift-тест `tests/b24FormHtml.test.ts`.
- «Похоже на образец» ≠ «как в образце»: если просят повторить дизайн — берём
  оболочку 1:1 и меняем только контент.
