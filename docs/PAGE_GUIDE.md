# Гайд: как создавать новые страницы в нужном виде и дизайне

> Last reviewed: 2026-08-20

Приложение живёт в **двух визуальных контекстах**. Прежде чем делать страницу,
определи, к какому она относится — от этого зависит layout, тема и стиль.

| Контекст | Что это | Layout | Тема | Примеры |
|----------|---------|--------|------|---------|
| **Публичный лендинг** | маркетинговая страница `/` | `landing` | тёмная брендовая (форс-dark) | `app/pages/index.vue` |
| **In-portal / оператор** | UI внутри iframe Bitrix24 и служебные страницы | `clear` | b24ui light/dark-auto | `/app`, `/import`, `/install`, `/login`, `/queues` |

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

<template>
  <!-- Страницы ПРИЛОЖЕНИЯ (не служебные) оборачиваем в гейт: снаружи портала нет фрейм-токена -->
  <InPortalGate>…</InPortalGate>
</template>
```

- **Страница приложения** (`/app`, `/import`, `/install`) — тело в `<InPortalGate>` (#414): снаружи
  портала вместо неработающего интерфейса показывается объяснение. Штатный обход для тестов и
  скриншотов — `?preview=1` (в тесте задаётся маршрутом: `mountSuspended(Page, { route: '/app?preview=1' })`).
  Служебные страницы оператора (`/login`, `/queues`) гейтом не закрываются — у них своя сессия.

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

## 6. Промо-блоки (cross-sell) — общие компоненты экосистемы

Три переносимых компонента для промо/cross-sell; синхронны между `currency-converter`,
`Lp` и этим репо — правим в **одном** месте (эталон — `currency-converter`) и копируем
1:1, без локальных правок:

- **`app/components/HoldRevealQr.vue`** — мобильная кнопка-«отпечаток» с QR
  (hold-to-reveal). Кладётся **внутрь** карточки с `relative overflow-hidden`; пока
  «отпечаток» удерживают, оверлей накрывает эту карточку QR-кодом `url`. Десктоп её не
  видит (`sm:hidden`) и **не грузит `qrcode`** (динамический импорт срабатывает только на
  удержании). Пропсы: `url` (цель QR), `goal` (цель Метрики), `caption`/`hint`, `dark`
  (для всегда-тёмной карточки), `orientation` (`row` — промо-карточки / `stack` — визитка).
  Акцент — бренд-токен `--color-accent-primary-ch`.
- **`app/components/CustomDevCard.vue`** — премиальная copilot-карточка «Нужна доработка
  под ваш процесс?» (ИП Шевчик, партнёр). Самодостаточна: тексты и ссылки ИП Шевчик вшиты
  (одинаковы по экосистеме), пропсами наружу — только имена целей Метрики. Внутри —
  `HoldRevealQr` (QR на сайт). `B24Card variant="filled-copilot"` (радиальный copilot-градиент),
  CTA `air-boost` → бриф `offer.bx-shef.by/#brief`.
- **`app/components/AppInBitrixCard.vue`** — карточка «Приложение для Bitrix24» (cyan,
  light/dark-auto): ссылка на листинг Маркета + мобильный `HoldRevealQr` (QR листинга).
  Контент — **через пропсы** (`eyebrow`/`title`/`text`/`ctaLabel`/`url`, опц. `qrCaption`/
  `qrHint`). Цвет CTA — проп `ctaColor` (дефолт `air-primary`; на лендинге, где рядом платный
  primary, передаём подчинённый `air-secondary-no-accent`). Цели — `clickGoal` (дефолт
  `market_click`; на лендинге, где hero уже занял `market_click`, передаём `market_card_click`)
  и `qrRevealGoal` (`market_qr_reveal`). Без зависимостей от `site.ts` — переносима как есть.

**Где показываем:**

- `CustomDevCard` — **на in-portal-странице приложения** (`/app`): предложение доработки
  актуально и внутри портала. Оборачиваем в `<div class="mx-auto mt-8 w-full max-w-[520px]">`
  над подвалом (`BuildFooter`). На лендинг **не** дублируем — там своя форма заявки `BriefForm`.
- `AppInBitrixCard` — карточка «Приложение для Bitrix24» на **лендинге** (после «Почему мы»):
  ссылка на листинг Маркета `shef.bankimport` + мобильный QR. Тексты — `LANDING_MARKET_PROMO`,
  url — `LANDING_MARKET_URL`, своя цель клика `market_card_click` (не сливается с целью hero).
  Лендинг standalone → карточку в iframe **не** прячем (в отличие от `currency-converter`, где `/`
  dual-mode). Копия текстов — в `POSITIONING.md` («Карточка "Приложение для Bitrix24"»).

> **Требование к обёртке:** карточка-контейнер должна быть `relative overflow-hidden`,
> иначе QR-оверлей `HoldRevealQr` (`absolute inset-0`) схлопнется не на неё. Не оборачивать
> `HoldRevealQr` в ещё один `relative`-элемент.

## 7. Конвенции репозитория (кратко)

- Чистая логика → `app/utils/*` (+тесты), реактивная → `app/composables/*`,
  данные/константы → `app/config/*`, типы → `app/types/*`, UI → компоненты/страницы.
- Комментарии/JSDoc — на английском; пользовательский текст и `.md` — на русском.
- Каждый `.md` в корне и `docs/` несёт штамп `> Last reviewed: YYYY-MM-DD` сразу
  под H1 (проверяет `tests/mdReviewStamp.test.ts`).
- Цели Метрики — только через `useMetrikaGoal().reachGoal()`, snake_case.

## 8. Процесс и Definition of Done

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

## 9. Частые грабли

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
- **`--ui-color-accent-main-*` — цвет ЗАЛИВКИ, а не текста.** Тема сама так их и
  использует (`--ui-color-design-filled-success-bg: var(--ui-color-accent-main-success)`),
  поэтому текстом на светлом фоне они дают **2.07:1** (приход) и **3.12:1** (расход)
  при пороге 4.5:1 — то есть хуже всего читается самое важное, сумма. Замерено на
  живом списке операций (#528). Берём пару «светлая/тёмная»:
  `text-(--ui-color-green-95) dark:text-(--ui-color-accent-main-success)` (7.28 / 5.27) и
  `text-(--ui-color-red-80) dark:text-(--ui-color-red-50)` (6.07 / 4.86).
  ⚠ Проверять надо и **hover-фон** строки: на нём `green-90` давал 4.48 — на 0.02 ниже
  порога, то есть текст «портился» ровно под курсором. ⚠ `green-90`/`green-95` зелёные
  только в light-контексте: в `dark` и `edge-*` это олива `#506900`, поэтому пара обязана
  идти с `dark:`-переопределением, а внутри `.edge-*`-обёртки её надо перемерять.
- **`--ui-color-design-tinted-*-content` не проходит 3:1 на своём же `tinted-*-bg`**
  (2.44:1 для прихода). Пара задумана под бейдж с ТЕКСТОМ рядом; если глиф в плитке —
  единственный носитель смысла, красим его тем же text-grade цветом, что и сумму.
- **Проп `title` у `B24Card` рендерится обычным `div`, а не заголовком.** Единственный
  заголовок блока так выпадает из навигации по заголовкам у скринридера — нужен слот
  `#title` с настоящим `<h2>`.
- **Штатная кнопка очистки `B24SelectMenu` (`clear`) рендерится как `span` с
  `tabindex="-1"`** и без обработчика клавиш. Строки «ничего» в меню нет, поэтому с
  клавиатуры значение не снять вовсе. `clear` принимает объект, чьи пропы биндятся
  ПОСЛЕ `tabindex`, — но одного `tabindex: 0` мало: Tab остановится на элементе, который
  не реагирует ни на Enter, ни на Space. Нужен и `role`, и собственный обработчик клавиш.
