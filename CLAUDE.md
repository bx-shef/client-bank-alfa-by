# CLAUDE.md

> Last reviewed: 2026-07-09

Приложение Bitrix24 для импорта выписки из клиент-банка: онлайн из Альфа-Банка
Беларусь (портал может быть в любой стране) или ручной загрузкой любой стандартной
выписки. Публичная страница — лендинг (SSG). Появилась серверная часть (Nitro):
эндпоинт вебхуков Bitrix24 (`/api/b24/events`) + хранилище токенов портала.

> **Статус:** рефакторинг legacy-приложения (план — [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md)).
> Репозиторий: **frontend** (публичный лендинг SSG + B24-iframe-UI) **и backend** (Nitro-сервис:
> приём событий установки/удаления Б24, учёт авторизации портала; дальше — OAuth Альфы, опрос,
> запись дел/чата, MCP). Заложено доменное ядро (типы выписки, абстракция банк-провайдеров, чистые
> утилиты, билдер дела, разбор/маршрутизация событий Б24) и демо-страница на mock-данных; backend
> событий Б24 реализован (этап 3, слайс), реальная интеграция Альфы — далее. **Целевая спецификация
> обработки платежей** (подбор компании/инвойса/сделки, распределение, оповещения, ошибки) —
> [`docs/PROCESSING.md`](docs/PROCESSING.md). Деплой: статика лендинга за nginx + отдельный
> backend-сервис с Postgres (как `bx-synapse`). Эталон стека — `currency-converter`.

## Стек

- **Nuxt 4** (статическая генерация, `nuxt generate`)
- **Vue 3** — `<script setup lang="ts">`
- **TypeScript** (строгий), **Tailwind CSS v4**, **Bitrix24 UI** (`b24ui`) —
  первоисточник по «как правильно» на b24ui: официальные AI-ресурсы
  [`bitrix24/b24ui/AGENTS.md`](https://github.com/bitrix24/b24ui/blob/main/AGENTS.md)
  (семантические цвет-токены, `useComponentProps()`, чек-лист компонента),
  [`bitrix24/b24ui/skills/`](https://github.com/bitrix24/b24ui/tree/main/skills) и
  [`llms.txt`](https://bitrix24.github.io/b24ui/llms.txt) (LLM-индекс компонентов/composables/тем);
  наш [`docs/PAGE_GUIDE.md`](docs/PAGE_GUIDE.md) — как это ложится на приложение.
- **Bitrix24 JS SDK** (`@bitrix24/b24jssdk` + `-nuxt`) — встройка в портал (dual-mode, `/install`);
  первоисточник по SDK — [`llms.txt`](https://bitrix24.github.io/b24jssdk/llms.txt) (LLM-индекс:
  `B24Frame`, `callV2/callBatch`, `fetchList`, вебхуки/OAuth, примеры). Точные REST-сигнатуры — MCP `b24-dev-mcp`.
- **Vitest** — два проекта: `unit` (node, чистые функции) и `nuxt`
  (`@nuxt/test-utils` + happy-dom, composables и компоненты)

## Команды

```bash
pnpm dev          # дев-сервер
pnpm lint         # ESLint
pnpm typecheck    # vue-tsc --noEmit (app) + vue-tsc -p .nuxt/tsconfig.server.json (server/**)
pnpm test         # Vitest (оба проекта; быстрый прогон node: pnpm test --project unit)
pnpm generate     # сборка статики (nuxt generate, SSG) — то же гоняет CI
```

Перед пушем прогоняй `pnpm check` (= `lint` + `typecheck` + `test`) или запусти
готовый скрипт: `bash scripts/check-app.sh` (Linux/macOS) / `pwsh scripts/check-app.ps1`
(Windows) — он сразу отдаёт итог. Те же проверки гоняет CI (порядок шагов не важен —
они независимы).

## Архитектура

- `app/app.vue` — **корень Nuxt** (не страница): `useHead`/SEO (вкл. `og:image`/`twitter:card` →
  `public/og.png`, абсолютный URL из `siteUrl` в проде)/`theme-init`, рендерит `<NuxtLayout>`/`<NuxtPage>`.
- `app/app.config.ts` — нативный colorMode b24ui (`colorMode: true`, `colorModeInitialValue: 'auto'`);
  без этих top-level ключей `useColorMode()` = no-op stub.
- `app/assets/css/main.css` — Tailwind v4 + импорт темы b24ui.
- **Как создавать новые страницы в нужном виде** (лендинг vs in-portal, темы, анимация, форма, a11y,
  процесс) — [`docs/PAGE_GUIDE.md`](docs/PAGE_GUIDE.md). Родственный дизайн-гайд основного сайта — в репо
  `bx-shef/Lp` (`docs/LANDING_GUIDE.md`).
- `app/pages/index.vue` — публичный лендинг (маркетинговый, по issue #110): hero+CTA (фото+граф+
  `PartnerBadge`), боль→результат, «Как это работает» (3 шага), **демо `#demo` (`LandingDemo`)**,
  «Почему мы» (6 карточек, glow), блок интеграторам, форма заявки (`BriefForm`), `MobileBriefCta`.
  Тексты — из `app/utils/landing.ts`. CTA скроллит к `#brief`, вторичная кнопка hero — к `#demo`; цели
  Метрики через `useMetrikaGoal`; glow за курсором — `useCardGlow`.
- `app/components/LandingDemo.vue` + чистое ядро `app/utils/demoExtract.ts` (карта — [`docs/DEMO_LANDING.md`](docs/DEMO_LANDING.md))
  — **демо на лендинге «Попробуйте на своей выписке»**: прикрепить файл выписки → **разбор в браузере**
  (windows-1251, через готовое `importUpload.ts`: `processUploadBatch`/`dedupItems`/`deferToEventLoop`) →
  панель извлечения (операции, контрагенты, суммы **по валютам** — округление в чистом слое, распознанные
  **по матрицам** номера счетов/заказов через реальный `recognizeByMatrices`). **Онлайн-подключение**
  к Альфе/Приору показано **яркими инфо-карточками** (`LANDING_BANK_CONNECT` в `landing.ts`, рендер в
  `index.vue` над `LandingDemo`) — интерактивные кнопки-«песочницы» убраны (живой OAuth банков гео-
  блокируется из облака; sample-функции `demoAlfaExtraction`/`demoPriorExtraction` остаются в
  `demoExtract.ts` под юнит-тестами как доказательство нормализаторов, но к UI не подключены).
  Тёмный самодостаточный UI (не тащим b24ui-`OperationList`,
  чтобы не смешивать light/dark-токены с брендовой оболочкой); подводка/тексты ошибок — `LANDING_DEMO` в
  `landing.ts`, интерактивные подписи (кнопки, метки сводки, `KIND_LABEL`) пока в компоненте (черновик,
  дошлифуется). Гонку источников снимает токен `runSeq` (медленный разбор не затирает позже выбранный
  источник), рендер операций и распознанных строк капнут (`MAX_RENDERED_OPS`). Тесты —
  `tests/demoExtract.test.ts` (ядро на реальных нормализаторах) +
  `tests/nuxt/landingDemo.nuxt.test.ts` (рендер/проводка). **Follow-up:** маскировка блока результатов в
  вебвизоре Метрики (приватность реальных выписок) — см. `DEMO_LANDING.md`.
- **Визуальная оболочка лендинга портирована с `offer.bx-shef.by` (репо `bx-shef/Lp`)** —
  тёмная брендовая тема (vibecode-палитра, #030022 + радиальное сияние, self-hosted шрифты Rubik/
  Roboto Mono). Живёт в отдельном **layout `landing`** (`app/layouts/landing.vue`: `B24Header` с
  `AppLogo`+навигацией, `B24Footer` с `SiteFooter`+GitHub, `BusinessCardModal`), который вешается
  только на `/` (`definePageMeta({ layout: 'landing' })`) — **in-portal страницы (`/app`,`/settings`,
  `/login`,`/queues`) не трогает**, у них своя light/dark-auto тема. Dark форсится только для лендинга
  через `htmlAttrs data-force-dark` (учитывает `theme-init` в `app.vue`) + класс `.landing-shell` в
  `main.css` (фон/токены скоуплены на этот класс). `HeroGraph.vue` — canvas-анимация фона hero:
  внешние узлы (банки/выписка/CRM-сущности) шлют **импульсы в центральный хаб Bitrix24** (спицы +
  бегущие точки с хвостом + кольца-волны на приходе); хаб пришпилен к центру тяжести, внешние узлы —
  лёгкая физика (гравитация к хабу, взаимное отталкивание, репеллер зоны фото). Уважает
  `prefers-reduced-motion` (статичный кадр), пауза вне видимости/при скрытой вкладке, троттлинг 30fps.
- `app/components/BusinessCardModal.vue` — визитка (тёмная, vibecode): фото, **QR (десктоп + мобильный
  hold-to-reveal «отпечаток»)**, контакты, «Назначить созвон» (`booking.ts`) + копия ссылки
  (`clipboard.ts`), vCard (`buildVCard` из `app/utils/vcard.ts`), «Реквизиты» — внешней ссылкой.
  `app/composables/useMetrikaGoal.ts` — обёртка `ym reachGoal` (no-op без Метрики).
- `app/components/BriefForm.vue` — встроенная CRM-форма Bitrix24. Форма живёт в отдельном
  same-origin документе `public/b24-form.html` (iframe), который nginx отдаёт со **своим**
  form-scoped CSP (`location = /b24-form.html`) — официальный B24-загрузчик (inline + cdn-скрипт)
  работает, а строгий CSP страницы не ослабляется. URL iframe строит чистый `app/utils/b24Form.ts`
  (`buildB24FormSrc` — allowlist хостов Б24 + валидация id/secret, тесты); пустой конфиг ⇒ слот-плейсхолдер.
  Событие `b24:form:submit` iframe ретранслирует через `postMessage` → цель Метрики `brief_submit`.
  Контейнер тёмный (под брендовую оболочку лендинга); `app/utils/booking.ts` — общая ссылка онлайн-записи Б24.
- `app/pages/app.vue` — in-portal просмотр выписки на **b24ui** (по образцу B24-списка «Последние
  операции»): полоса статуса (`ImportStatusBanner`), карточка «Последние операции» с чип-фильтром
  Все/Приходы/Расходы (счётчики в подписи), шапкой колонок «Операция/Сумма», `OperationList` и
  `B24Pagination` (при переполнении страницы). Шестерёнка открывает **слайдер настроек снизу**
  (`B24Slideover` `side="bottom"` с `SettingsForm` — удобно в узком iframe/на мобильном) — основной
  вход; ниже — карточка тестовой настройки `app.option`.
  Демо-данные. Layout `clear`, `useB24().init()`, в портале — `setTitle`/`fitWindow` (try/catch).
  Итоги приходов/расходов — компактной строкой над списком. Интерактив (раскрытие строки,
  слайдер настроек) автотестами не покрыт — проверяется вручную в портале; `B24Pagination` видна
  только на реальных данных (демо-операций мало).
- `app/components/SettingsForm.vue` — форма настроек чата (#16 PR-C): два пикера чатов на
  **`AsyncSearchSelect`** (чат уведомлений `chat.dialogId` + **чат ошибок** `errorChat.dialogId`,
  поиск через `/api/chat-search`), `B24Switch` приходы/расходы, исключения `B24Textarea` + живой
  предпросмотр («что попадёт в чат», `B24Badge`). Один компонент для двух точек входа: слайдер на
  `/app` и полная страница `/settings`. **Хранение — backend** (`app.option` через `useChatSettings`),
  **автосейв** (debounced) с индикатором «Сохранение…/Сохранено ✓» (aria-live) + flush на unmount.
  **Гейт админа** (`useIsAdmin` → `$b24.auth.isAdmin`, default-closed до проверки): в портале не-админу —
  предупреждение вместо формы; вне фрейма — предпросмотр (persistence инертна).
- `app/components/StatementUpload.vue` + `app/pages/import.vue` (роут `/import`, layout `clear`,
  в `nitro.prerender.routes`) — **UI ручной загрузки выписки (P4, слайс 1)**: drag-drop/`<input>`
  мульти-файл, парсинг **в браузере** (детерминированный, без backend/AI) через `importUpload` →
  статус по каждому файлу (разобрано N / ошибка) + объединённый предпросмотр через `OperationList`.
  Ссылка «Загрузить выписку» — в шапке `/app`. **Слайс 2 (запись в CRM) — сделан:** кнопка «Записать в
  CRM» шлёт **сам файл** на `POST /api/import` (`useImport`, фрейм-токен) → очередь `file-parse`→`crm-sync`;
  сервер — единственный авторитет разбора (парсит в воркере), браузерный разбор = только предпросмотр.
  Обратная связь — fire-and-forget («принято, N операций», N из предпросмотра); фон пишет дело по операции.
  **v1:** клиент не найден → `unmatched`, не пишем (каскад «моя компания»/смарт-процесс — #109). Разбор
  покрыт тестами на реальных `tests/fixtures/*`; UI — render-тест + визуальная проверка (свет/тёмная).
- `app/pages/settings.vue` — полная страница настроек (прямая ссылка): заголовок + `<SettingsForm/>`
  + промо-карточка `CustomDevCard` (cross-sell, как на `/app`). Layout `clear` + `useB24().init()`.
  Роут `/settings` — в `nitro.prerender.routes`.
- `app/pages/import.vue` — страница `/import` **ручной загрузки выписки** (P4, слайс 1): когда нет
  онлайн-подключения к банку — перетащить файл(ы), приложение разбирает их **в браузере**
  (детерминированно, без backend/AI) и показывает предпросмотр операций. Layout `clear` +
  `useB24().init()` (в портале `setTitle`/`fitWindow`). Вход — кнопка «Загрузить выписку» в шапке
  `/app`. Роут `/import` — в `nitro.prerender.routes`. UI — `StatementUpload.vue`; чистое ядро —
  `app/utils/importUpload.ts` (`validateUploadFile` — расширение+размер `MAX_UPLOAD_BYTES` 2 МБ,
  `decodeAndParse` — windows-1251 декод → `normalizeManualStatement`, `processUploadBatch` — усечение
  по `MAX_UPLOAD_FILES` + изоляция разбора каждого файла + `defer`-yield, `dedupItems` по `account|docId`).
  Компонент: дропзона, список результатов по файлам (успех — бейдж «разобрано: N», ошибка — переносимый
  текст), сводка, предпросмотр `OperationList`, `role=status aria-live`, кнопка **«Записать в CRM»**
  (`useImport` → `POST /api/import`, слайс 2 выше). Тесты — `tests/importUpload.test.ts` (реальные
  фикстуры) + `tests/nuxt/statementUpload.nuxt.test.ts` (рендер/проводка).
- `app/pages/install.vue` — обработчик установки B24 (layout `clear`): `init` → `event.bind`
  (`ONAPPINSTALL`/`ONAPPUNINSTALL` → `${siteUrl}/api/b24/events`, до `installFinish` — так текущая
  установка доставляет `application_token`) → `installFinish` (+ диагностика портала, блок «События»);
  вне фрейма — редирект на `/`. Билдер батча привязок — чистый `app/utils/b24EventBind.ts`
  (идемпотентен: пропуск верных, перепривязка устаревших). Требует `NUXT_PUBLIC_SITE_URL` в проде
  (иначе откажется биндить относительный URL — ошибка с retry). `placement.bind` **пока не делаем** —
  плейсменты добиваем на тестовом портале (см. план).
- `app/layouts/clear.vue` — минимальный layout (`<B24App>` для тем/тостов, light/dark) под in-portal-страницы
  (`/install`, `/app`, `/settings` в iframe) **и** standalone-страницы оператора (`/login`, `/queues`).
- `app/config/b24.ts` — чистые константы встройки: `B24_REQUIRED_SCOPES` (`crm`, `im`, `user_brief`,
  `placement`), `B24_EVENT_HANDLER_PATH` (`/api/b24/events`), `B24_BOUND_EVENTS` (события для `event.bind`).
- `app/composables/useB24.ts` — обёртка над `B24Frame`: `init()` (идемпотентен; no-op вне фрейма —
  когда нет `window.name`), `isInit()`, `get()`/`getOrThrow()`, `targetOrigin()`, `getRequiredRights()`.
- `app/composables/useChatSettings.ts` — **синглтон** настроек чата (слайдер `/app` и страница
  `/settings` делят состояние): `load()`/`save()` `PortalSettings` через `/api/chat-settings` по
  фрейм-токену + `chatFetcher` (транспорт для `AsyncSearchSelect`, ходит в `/api/chat-search`) +
  сид-метки выбранных чатов (кэш-`title` из настроек → недавние → id-фолбэк). Вне фрейма инертна
  (defaults, persistence — no-op). `AsyncSearchSelect` эмитит `update:selected-option` (выбранная
  строка) → форма кладёт имя в `ChatSettings.title`/`ChatTarget.title` (UI-подсказка, воркеру не нужна;
  переживает reload без лишнего REST).
- `app/composables/useIsAdmin.ts` — `check()` → `$b24.auth.isAdmin` (синхронно, из `IS_ADMIN`
  init-handshake); `inPortal`/`isAdmin` для гейта формы (в портале не-админ → предупреждение).
- `app/components/ImportStatusBanner.vue` — полоса статуса импорта (`B24Alert`, цвет = состояние:
  ok/running/error); «Обновлено N минут назад», «+N операций», «Записано в CRM · N в чат», при ошибке —
  действие «Проверить настройки». `app/components/OperationList.vue` — список операций строками
  (группировка по дню, плитка-направление ↑приход/↓расход, контрагент+назначение, сумма со знаком
  и цветом; строка раскрывается в `B24Collapsible` → `B24DescriptionList` с реквизитами; пустое состояние).
- `app/types/importStatus.ts` + `app/utils/importStatus.ts` (relative-time RU `formatRelativeTime`,
  `pluralRu`, `importStateMeta`) + `app/composables/useImportStatus.ts` — модель и презентация статуса
  импорта; mock на клиенте до backend-опроса (#5), форма ответа = будущий `GET /import/status`.
- `app/components/BuildFooter.vue` (+ `app/utils/build.ts`, покрыт тестами) — подвал лендинга и
  `/app`: автор + ссылка на **коммит сборки** (`сборка <sha>` → GitHub commit); sha из
  `NUXT_PUBLIC_COMMIT_SHA` (CI передаёт `github.sha`, в dev — «dev»).
- **Промо-компоненты (cross-sell), общие по экосистеме** — переносимы 1:1 из `currency-converter`
  (правим в одном месте, копируем без правок; каталог в `docs/PAGE_GUIDE.md` §6):
  - `app/components/HoldRevealQr.vue` — мобильная кнопка-«отпечаток» с QR (hold-to-reveal): кладётся
    внутрь карточки `relative overflow-hidden`, удержание накрывает её QR-оверлеем. Десктоп не видит
    (`sm:hidden`) и не грузит `qrcode` (динамический импорт только на удержании). Пропсы `url`/`goal`/
    `caption`/`hint`/`dark`/`orientation` (`row` — промо-карточки / `stack` — визитка). Акцент —
    бренд-токен `--color-accent-primary-ch`.
  - `app/components/CustomDevCard.vue` — премиальная copilot-карточка «Нужна доработка под ваш
    процесс?» (ИП Шевчик, партнёр): `B24Card variant="filled-copilot"`, CTA `air-boost` → бриф
    `offer.bx-shef.by/#brief`, внутри `HoldRevealQr` (QR на сайт). Самодостаточна — тексты/ссылки
    вшиты (одинаковы по экосистеме), пропсами наружу только имена целей Метрики. Показывается **на
    in-portal-странице приложения** (`app/pages/app.vue`, над `BuildFooter`, `max-w-[520px]`) —
    предложение доработки актуально и внутри портала; на лендинге не дублируем (там своя `BriefForm`).
  - `app/components/AppInBitrixCard.vue` — карточка «Приложение для Bitrix24» (cyan, light/dark-auto):
    ссылка на листинг Маркета + мобильный `HoldRevealQr` (QR листинга). Контент — **через пропсы**
    (`eyebrow`/`title`/`text`/`ctaLabel`/`url` + опц. цели/подписи QR; `clickGoal` по умолчанию
    `market_click`). На лендинге (`app/pages/index.vue`, после «Почему мы») тексты — из
    `LANDING_MARKET_PROMO`, url — `LANDING_MARKET_URL` (`shef.bankimport`), своя цель клика
    `market_card_click` (чтобы не сливаться с целью кнопки hero). Лендинг standalone → карточку в
    iframe не прячем (в отличие от `currency-converter`, где `/` dual-mode).
- `app/composables/useAppSettings.ts` — тестовая настройка уровня приложения: берёт из фрейма
  **access-токен + домен** и шлёт их в `/api/settings` (GET/POST) заголовками
  `Authorization: Bearer` + `X-B24-Domain`; backend этим токеном пишет/читает `app.option`. Вне
  портала инертна (токена нет). member_id UI не доверяет — изоляция на стороне B24 (токен скоуплен к порталу).
- **Авторизация оператора** (вход для сотрудников в служебную зону — `/queues`, дальше страницы импорта;
  лендинг и B24-встройку не закрывает) — [`docs/AUTH.md`](docs/AUTH.md). Чистое ядро `server/utils/session.ts`
  (`resolveAuthConfig`/`checkCredentials` constant-time, `signSession`/`verifySession` — HMAC-подпись cookie;
  статус-матрикс роутов `decideLogin`/`decideLogout`/`sessionStatus` — тонкие `server/api/auth/*` только I/O,
  тестируются без сервера; тесты). Роуты `server/api/auth/login|logout|session`. Клиент — `app/composables/useAuth.ts`,
  форма `app/pages/login.vue` на **b24ui** (`B24Card`/`B24Input`/`B24Button`/`B24Alert`, layout `clear` → light/dark),
  публичная `noindex` (маппинг ошибок → сообщение в чистом `app/utils/loginError.ts`, покрыт тестом). Гвард
  `app/middleware/auth.ts` (клиентский редирект; реальная защита — на API), а
  `app/components/AuthGate.vue` прячет контент служебных страниц за «Проверка доступа…» до подтверждения сессии
  (SSG-статику красит колор-мод, поэтому иначе защищённый контент мелькал бы до редиректа). Cookie `cba_sess`
  HttpOnly/SameSite=Lax/Secure, CSRF-заголовок `X-CBA-Auth`. Пароль пуст ⇒ вход выключен. Модель портирована
  из `postroyka/purchase-ai-chat`. B24 silent-сессия — далее.
- `app/utils/landing.ts` — тексты и чистая логика лендинга (`LANDING_TITLE/DESCRIPTION`,
  `LANDING_PAIN_RESULT`, `LANDING_STEPS`, `LANDING_FEATURES`, `LANDING_INTEGRATORS`, `copyrightYears`),
  покрыта тестами. Единый источник контента (issue #110) — из него же берёт SEO `app.vue`.
- **Доменное ядро (чистое, переносимо в backend, покрыто тестами):**
  - `app/types/statement.ts` — модель выписки (`Statement`/`StatementItem`/`StatementParty`,
    `OperationDirection`, `BankProviderId`) + **единый интерфейс**: `StatementFetchQuery` (вход:
    банк/счёт/диапазон; батч-`StatementQuery` для `BankProvider` — в `banks.ts`),
    `StatementNormalizer` (`raw,ctx → StatementItem[]`) — один выход на все банки (см. REFACTOR_PLAN
    «Единый интерфейс выписки»).
  - `app/config/banks.ts` — абстракция `BankProvider` + реестр банков (Альфа/Приор/ручной импорт).
  - `app/utils/statement.ts` — классификация приход/расход, дедуп (`account|docId`), фильтр чата,
    `parseRuleLines` (textarea → массив правил).
  - `app/utils/activity.ts` — билдер **универсального дела** (`crm.activity.todo.add`) + origin-маркер для дедупа.
    **Безопасность:** внешние поля (назначение/контрагент/номер документа — контролирует плательщик)
    прогоняются через `neutralizeBb` (BB-скобки → полноширинные) и в заголовке, и в описании дела —
    CRM-таймлайн рендерит BB, иначе `[url=…]`/упоминания попали бы в карточку. `neutralizeBb` живёт
    здесь (шарится в `chatMessage.ts`, чтобы не было цикла импорта activity↔chatMessage).
  - `app/utils/allocation.ts` — **чистое ядро разнесения оплат** (#109, спека — `docs/PROCESSING.md` §2):
    `resolveAllocation` над кандидатами, уже отфильтрованными по компаниям **и по стадии** (инвойсы/сделки
    с отрицательной стадией исключены; Этап C/D), решает по критерию владельца (совпали **сумма** — точно,
    в минорных единицах — **и валюта**): нет точного совпадения → `manual` (очередь ручного разбора); одно →
    `allocate`; несколько → `allocate` на **минимальный ID** с флагом `ambiguous` (вызывающий шлёт
    оповещение в чат). `collapseSameTarget` схлопывает только заведомо одну цель (инвойс поверх оплаты той
    же сделки по `parentId`; буквальный повтор `kind`+`id`) — разные сущности одной суммы остаются
    раздельными (→ `ambiguous`). `allocationFactKey` — идемпотентный ключ факта «платёж→сущность».
    `ALLOCATION_TARGET_ROLE` (`Record<AllocationTargetKind,'amount'|'trigger'>`) — **единый
    компиляторно-проверяемый источник** разбиения целей: amount (инвойс/оплата — через `resolveAllocation`)
    vs trigger (сделка/смарт-процесс — безусловно, минуя сумму); новый вид не скомпилируется без
    классификации (ретайрит дублирующий `AMOUNT_GATED_KINDS` в `itemByIdLookup`). `summarizeAllocation(payment)` —
    чистая свёртка кандидатов в исход (`allocatable`/`ambiguous`/`manual`/`none` + decision + число trigger-целей);
    её зовёт `crm-sync` (лог/счётчики) и переиспользует будущий слайс записи.
    `filterByAccountNumber(candidates, number)` — точный отбор кандидата по `accountNumber` (для распознанного
    `payment-number` в company-пуле оплат, собранном по компании, а не по номеру; пустой номер → `[]`, не сметает
    пул). `order-number` так не матчится: `accountNumber` оплаты имеет форму `<заказ>/<seq>` — нужен связь-нюанс,
    подтверждённый вживую (#172). Без I/O; проводка в `crm-sync` — следующий слайс.
  - `app/utils/purposeMatch.ts` — **чистое распознавание идентификатора из назначения платежа по МАТРИЦАМ**
    (#109, спека — `docs/PROCESSING.md` §4): `recognizeByMatrices(purpose, matrices, alphabet)` — матрица
    (`MatchMatrix { mask, kind }`) описывает формат номера маской (`d`=цифра, остальное — литерал: буквы/
    `-`/`/`), напр. `dddd`, `СЧ-dddd`, `BOPC-ddd/dd`. Извлекает совпавшую подстроку (граница по алфанум —
    не хватает фрагмент длинного токена; составные `123/45`; регистронезависимо; дедуп). `foldHomoglyphs`
    приводит визуально-одинаковые кир↔лат (`ВОРС`↔`BOPC`) к выбранному алфавиту (`Alphabet`) — и назначение,
    и маску перед сравнением. `IdentifierKind` — таксономия §4. Матрицы/алфавит — из настроек портала, без
    хардкода; без I/O; сам lookup id→сущность — REST-слайс. DoS-гард `MAX_PURPOSE_CHARS`/`MAX_ID_CHARS`.
  - `app/utils/identifierDispatch.ts` — **чистый роутинг `IdentifierKind → цель+стратегия поиска`** (#109,
    между распознаванием §4 и REST-lookup): исчерпывающая таблица `IDENTIFIER_ROUTES`
    (`Record<IdentifierKind, IdentifierRoute>` — новый вид не скомпилируется без маршрута) → `targetKind`
    (`AllocationTargetKind` или `null` для моста-документа) + `LookupStrategy` (`by-id`/`by-number`/
    `by-config-field`/`via-order`/`via-payment`/`via-document`) + `needsConfiguredField` (поле из карты
    сопоставления — только `deal-field`/`smart-field`). Без I/O и без хардкода имён полей; сам REST-поиск
    и поле из настроек — REST-слайс. `AllocationTargetKind` расширен до `invoice|deal-payment|deal|smart-process`.
  - `app/utils/priorOauth.ts` — Open Banking (СПР) Приора: чистое OAuth/DCR/consent-ядро (префиксы API,
    `buildPriorAuthorizeUrl`/claims/тела токенов/`buildConsentRequest`/`buildResourceRequestBody` + парсеры
    `parsePriorTokenResponse`/`extractIntentId`/`extractResourceId`/`extractAccounts`). Без `node:crypto` —
    подпись `request`-JWT и транспорт у вызывающего (браузеро-безопасно, аналог `alfaOauth.ts`). Три имени,
    совпадающие с Альфой, несут префикс `Prior` (Nuxt авто-импортит `app/utils/**` в один неймспейс).
  - `app/utils/alfaStatement.ts` — нормализация выписки Альфы (`partner.accounts 1.2.0`) в `StatementItem`
    (`normalizeAlfa` — контракт `StatementNormalizer`).
  - `app/utils/priorStatement.ts` — нормализация операции Приорбанка (Open Banking СПР) в `StatementItem`
    (`normalizePrior`); подтверждено на живом sandbox — см. [`docs/PRIOR_API.md`](docs/PRIOR_API.md).
  - `app/utils/clientBankText.ts` — парсер **формата** текстовой выписки client-bank (CP1251,
    `***** ^Type=`) → секции/строки; для провайдеров `prior-by`/`manual`. Портированный пример,
    вход ограничен по размеру (`MAX_CLIENT_BANK_CHARS`, DoS-гард #19); остаточный рефактор
    (словари ключей) — issue #19.
  - `app/utils/clientBankStatement.ts` — нормализация разобранной текстовой выписки в `StatementItem`
    (`normalizeClientBank` — контракт `StatementNormalizer`; приход/расход, валюта нац/инвалюта,
    контрагент, `account|docId`-дедуп). Провайдер `manual` (и файловый путь `prior-by`) — issue #19.
    Проверено на образцах `tests/fixtures/client-bank/` (BYN `Type=400`, CNY `Type=600`) и на реальных
    выгрузках трёх форматов: `Type=3` «за день» (`demo-type3-vpsk`), `Type=4` «за период»
    (`demo-type4-alfa`) и валютный `Type=5` «за день» (`demo-type5-vpsk`). Ключ дедупа (`rowDocId`):
    `DocID` → `OperationID` (уникальный id в `Type=4`, где `Num` повторяется — иначе коллизия/потеря
    операции, #73) → фолбэк `Num|DocDate`. **Валюта** (`detectStatementCurrency`): альфа-маркер `I3`/`I1`
    → `ctx.currency` → числовой ISO `CurrCode`/`I3`/`I1` (`643`=RUB, `933`=BYN — единственный маркер на
    валютных «за день» выписках, #169) → BYN-дефолт для BY-счёта. Для инвалютной операции сумма берётся
    из `…Q`-поля (`CreQ`/`DebQ`, в валюте счёта), а не из BYN-эквивалента `Cre`/`Deb` (подтверждено на
    реальной RUB-выписке `Type=5`, #169). BIC контрагента из `Cod`/`Code` — только BIC-образный токен
    (`Code` бывает и числовым кодом валюты).
  - `app/utils/oneCExchange.ts` + `app/utils/oneCStatement.ts` — формат обмена 1С «Клиент-банк»
    (`1CClientBankExchange`, версии 1.01–1.03): парсер секций (`parseOneCExchange`) + нормализатор
    (`normalizeOneC` — контракт `StatementNormalizer`; направление по «наш счёт = плательщик/получатель»,
    валюта из кода счёта RU/BY, дедуп `Номер|Дата`). Второй `manual`-формат — issue #21.
  - `app/utils/manualImport.ts` — точка входа ручной загрузки: детект формата (`detectManualFormat`)
    → парсер+нормализатор (`normalizeManualStatement`: `1CClientBankExchange` или `***** ^Type=`).
  - `app/utils/importUpload.ts` — чистое ядро UI ручной загрузки (P4): `validateUploadFile`
    (расширение/размер), `decodeAndParse` (windows-1251 `TextDecoder` → `normalizeManualStatement`;
    работает в браузере и node — тесты на реальных фикстурах), `dedupItems` (`account|docId` по
    нескольким файлам), `uploadErrorMessage`. Без DOM.
  - `app/utils/mockStatement.ts` — демо-данные для UI до реальной интеграции.
  - `app/types/b24Events.ts` + `app/utils/b24Events.ts` — события Б24 (`ONAPPINSTALL`/
    `ONAPPUNINSTALL`): разбор wire-формата (`parseBracketForm`, PHP-скобки), вердикт
    подлинности `application_token` (`appTokenVerdict`, fail-closed, constant-time),
    SSRF-гуард `isSafeClientEndpoint`, маппинг кредов портала `extractPortalCredentials`.
    Верификация+решение для реального события — в backend (`processB24Event`). Учёт авторизации/
    события/брокер — карточка [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md) (модель по backend `bx-synapse`).
- **Backend (Nitro, `server/`):** серверная часть в том же приложении (как `bx-synapse`).
  - `server/api/b24/events.post.ts` — эндпоинт вебхуков Б24: `readRawBody` → `parseBracketForm`
    → `handleEventRequest` (верификация без записи в БД) → кладёт пакет в очередь `b24-events`
    (register/unregister; refresh шифруется перед Redis). **Консьюмер — единственный писатель.**
    Онлайн-события Б24 **не ретраятся** — поэтому если очередь недоступна (Redis нет/упал), роут пишет
    в БД **синхронным фолбэком** (тот же токен-стор), чтобы установка/удаление не потерялись.
  - `server/api/health.get.ts` — публичный liveness-эндпоинт `GET /api/health` →
    `{ status, time, commit, commitUrl }` (коммит = `NUXT_PUBLIC_COMMIT_SHA`, как в подвале).
    Без секретов; на нём же построен docker `healthcheck` backend'а. Чистый билдер —
    `healthInfo` в `app/utils/build.ts` (покрыт тестами).
  - `server/api/import.post.ts` (+ чистое ядро `server/utils/importIngest.ts`, DI, тесты) — **приём
    ручной загрузки выписки (P4, слайс 2)**: multipart `file` + фрейм-токен (`Bearer` + `X-B24-Domain`).
    `handleImportUpload`: гейт файла (расширение+размер) → **проверка ключа портала** (`getMemberIdByDomain`
    по домену; нет токена ⇒ приложение не установлено ⇒ 409, как брак пакета в воркере) → **валидация
    фрейм-токена** (`profile` — успех доказывает принадлежность порталу, блок спуфинга `X-B24-Domain`,
    даёт id инициатора) → кладёт файл (base64) в очередь `file-parse`; `202` fire-and-forget. Воркер
    (`parseFile` → `parseManualFileBase64`) декодирует windows-1251 и парсит → `crm-sync`. Файл едет в
    пакете (≤2 МБ; nginx `client_max_body_size 3m` в `snippets/proxy-backend.conf`).
  - `server/utils/b24EventsHandler.ts` — чистый `processB24Event(payload, deps)` — **только чтение**
    (вердикт `application_token`, fail-closed → 200/400/403/503) и решение `action` (`register`/
    `unregister`); ничего не пишет. Роут кладёт `action` в очередь, консьюмер применяет. **Удаление
    приложения всегда стирает всё** для портала (флаг `CLEAN` не смотрим). Покрыт тестами.
  - `server/utils/tokenStore.ts` — хранилище токенов портала над инъектируемым `QueryFn`
    (`save`/`get`/`getApplicationToken`/`delete`, write-once `application_token`). Тесты на fake-query.
  - `server/utils/activityDedupStore.ts` — персистентный стор дедупа дел `{dedupKey→activityId}`
    (issue #9, таблица `activity_dedup`, скоуп по `member_id`): `getActivityId`/`rememberActivity`
    (write-once, `ON CONFLICT DO NOTHING`)/`deleteDedupForPortal`. Над `QueryFn`, тесты на fake-query.
    Переживает рестарт воркера и повторную доставку джобы (in-batch `Set` — нет). Проводка
    read-before-write вокруг `writeActivity` — стадия 4; удаление приложения чистит и его (always-purge).
  - `server/utils/secretCrypto.ts` — AES-256-GCM шифрование `refresh_token` (ключ `B24_TOKEN_ENC_KEY`).
  - `server/utils/envCheck.ts` (+ плагин `server/plugins/envCheck.ts`) — валидация env на старте
    (чистая `checkBackendEnv`, тесты): `B24_TOKEN_ENC_KEY` есть и декодируется в 32 байта; `DATABASE_URL`
    задан; `B24_APPLICATION_TOKEN` не плейсхолдер (`CHANGE_ME` и т.п. → реальный токен не совпадёт → 403);
    отсутствие `B24_CLIENT_ID/SECRET` — warning (приём событий работает, refresh/`app.option` — нет).
    Логирует, **не роняет** процесс (конвенция как `authGuard.ts`); no-op при prerender.
  - `server/db/client.ts` — ленивый pg-Pool (`DATABASE_URL`) + схема (`portal_tokens`, `activity_dedup`,
    `allocation_fact`, `import_result`); `server/plugins/migrate.ts` — идемпотентная миграция на старте.
  - `server/utils/importResultStore.ts` + `server/api/import/status.get.ts` (+ чистый
    `server/utils/importStatusHandler.ts`, DI, тесты) — **статус импорта для UI (#5)**: `crm-sync`-джоба
    **апсертит** сводку последнего прогона портала (`import_result`, один ряд на `member_id`: state/
    операции/дела/в-чат/ошибки) через воркер (демо-счета не пишут; best-effort — сбой статуса не роняет
    джобу). `GET /api/import/status` по **фрейм-токену** (`Bearer`+`X-B24-Domain`, `profile`-валидация,
    блок спуфинга домена; нет прогона → `neverSummary`) отдаёт `ImportRunSummary`. UI `useImportStatus`:
    в портале — реальный fetch, вне фрейма — демо-mock. Счётчик `notified` в `handleCrmSyncJob` (⊆ created).
    Удаление приложения чистит `import_result`.
  - **Очереди (BullMQ + Redis) — шина под нагрузку/масштабирование** (`server/queue/`;
    справка-обзор с диаграммой потока и метриками — [`docs/QUEUES.md`](docs/QUEUES.md)):
    - `topology.ts` — чистые контракты: очереди `b24-events`/`bank-fetch`/`file-parse`/`crm-sync`,
      payload'ы (`EventJob`/`FetchJob`/`ParseJob`/`CrmSyncJob`), идемпотентные `*JobId` (дедуп ретраев). Тесты.
    - `connection.ts` — ленивый `getQueue(name)`; передаёт BullMQ **опции** (парсит `REDIS_URL`), а не
      ioredis-инстанс — нет прямой зависимости от ioredis и связки версий. Гуард `queueEnabled()`.
    - `producers.ts` — `enqueueEvent/Fetch/Parse/CrmSync` (no-op без Redis).
    - `handlers.ts` — **чистые обработчики с DI** (тесты): `handleEventJob` регистрирует
      (`savePortal`, ONAPPINSTALL) / удаляет (`deletePortal`, ONAPPUNINSTALL — всегда) портал;
      fetch/parse → нормализованный батч в `crm-sync`; `crm-sync` дедупит in-batch (`account|docId`),
      читает `PortalSettings` **один раз на джобу** (`getPortalSettings` — один app.option-чтение кормит и
      чат, и распознавание), затем **read-before-write** по персистентному стору (#9): `getActivityId`→skip
      уже записанных, иначе `findCompany`→`writeActivity` (возвращает id дела)→`rememberActivity`→`notifyChat`;
      счётчики `created/skipped/unmatched/recognized/resolved/allocatable/ambiguous/manual`. **Распознавание
      намерения (#109, §4, слайс 1 капстоуна):** на каждую уникальную операцию — `recognizePurposeIntents` (чистый
      композит `recognizeByMatrices`→`routeIdentifier`, `app/utils/recognitionIntent.ts`) по матрицам портала →
      `onRecognized` **логирует намерение** (пред-скип, для покрытия). **Резолюция намерения в кандидаты (§4 lookup,
      слайс 3):** для операции с найденной компанией и распознанным id — `resolveIntents` (воркерная обёртка над
      `resolveIntentCandidates`) находит кандидатов на разнесение → `onResolved` **логирует**, счётчик `resolved`.
      **Решение разнесения (§2, слайс 4):** отфильтрованные по стадии кандидаты → `summarizeAllocation` →
      `onAllocationDecision` **логирует** исход, счётчики `allocatable`/`ambiguous`/`manual` (amount-цели по
      сумме+валюте, trigger-цели безусловно). **Гейт**: после dedup-skip (redelivery не пере-запрашивает B24) и
      только при совпавшей компании (IDOR-скоуп); **пока log/count — без записи разнесения** (стор факта +
      autoDistribute-гейт + идемпотентность #184 — следующий под-слайс, за live-verify). CRM-депсы берут `memberId` явно
      (депсы строятся один раз). Транспорт **разбора файла (`parseFile`) — живой** (ручной импорт, слайс 2);
      заглушка осталась только у **онлайн-опроса банков** (`fetchStatement`, Альфа/Приор — стадия 5). Стор дедупа живой.
    - `worker.ts` — BullMQ-воркеры на обработчики (`liveHandlerDeps`; `savePortal` расшифровывает
      refresh и пишет `saveToken`). CRM-sync транспорты **живые**: `findCompany`→`findCompanyByAccount`,
      `writeActivity`→`writeActivityViaRest` (`crm.activity.todo.add`) по per-portal `RestCall`
      (`makePortalRestCall`: `getToken`+`ensureAccessToken`+`callRest`), с **гейтом демо-счётов**
      (`isDemoAccount` — демо-нагрузка не пишет в реальный портал) и skip без токена портала.
      `cron.ts` — план опроса (`planFetches`) + **демо-нагрузка** (`buildDemoFetchJobs`/`demoItems`,
      `isDemoAccount`; каденция `demoTickMs` — секунды, пауза обработки `demoDelayMs` — чтобы очереди
      были видимы на графике). Для демо-счётов в `worker.ts` `fetchStatement`/`findCompany` держат
      `DEMO_DELAY_MS`-паузу (реальные джобы не тормозятся) → на графике виден backlog.
    - `server/plugins/queue.ts` — на старте поднимает воркеры и/или крон **по роли** (чистый парсер
      `server/queue/runtime.ts` `queueRuntimeConfig`: `QUEUE_WORKERS`/`QUEUE_CRON`/`QUEUE_CONCURRENCY`,
      покрыт тестами). Один образ — три роли: одиночный контейнер (дефолт — всё вместе), HTTP/primary
      (`QUEUE_WORKERS=0` — API+крон), **worker** (`QUEUE_CRON=0`+`RUN_MIGRATION=0`, масштабируется).
      **Scale-out сделан:** `docker-compose.prod.yml` разводит роли — `backend` (HTTP+крон) + сервис
      `worker` (обработка, `--scale worker=N`); все воркеры на одном Redis тянут из одной очереди (Redis
      отдаёт джоб ровно одному). Крон — ровно на одном инстансе; миграцию гоняет только backend
      (`RUN_MIGRATION`). `startWorkers(deps, {concurrency})` — `QUEUE_CONCURRENCY` на fetch/parse/crm-sync
      (события всегда 1). Детали — [`docs/QUEUES.md`](docs/QUEUES.md) «Масштабирование».
    - **Наблюдаемость сейчас:** чтение счётчиков — общий `server/queue/stats.ts` (`readQueueCounts`,
      DI, тесты). Два guard'а: `GET /api/queues` (`server/api/queues.get.ts`) — токен `B24_APPLICATION_TOKEN`
      **только заголовком** `X-Check-Token` (без `?token=` в логах), nginx `deny all`, для консоли
      (`scripts/queue-stats.sh`); `GET /api/ops/queues` (`server/api/ops/queues.get.ts`) — по **сессии
      оператора** (`operatorAllowed`), это путь для браузера. **Живой график** — страница `/queues`
      (`app/pages/queues.vue`, за `middleware: auth` + обёртка `AuthGate`, layout `clear`) →
      `app/components/QueueMonitor.vue` в хроме **b24ui** (`B24Card`/`B24Button`/`B24Select`, иконки
      `@bitrix24/b24icons-vue`) на **ECharts** (Apache-2.0, tree-shaken: `echarts/core` +
      Line/Grid/Tooltip/Legend/Canvas, динамический импорт; оси/сетка перекрашиваются под light/dark по
      классу `.dark`), чистая логика ряда — `app/utils/queueChart.ts` (тесты). Ряд строит клиент (снапшот без истории)
      из `/api/ops/queues`; `?preview=1` — превью на синтетике (для скриншотов/дев). Глубокая телеметрия
      (Prometheus-экспортёр BullMQ / bull-board / Grafana) — issue #78. Обзор — [`docs/QUEUES.md`](docs/QUEUES.md).
    Redis — сервис в compose на изолированной сети `queuenet` (`internal: true`, том `redisdata`).
  - `server/utils/companyLookup.ts` — **чистое ядро поиска компании CRM по счёту** (DI над `RestCall`,
    тесты): `crm.requisite.bankdetail.list` по `RQ_ACC_NUM`→фолбэк `RQ_IIK` (ИИК Беларуси) → id реквизитов →
    `crm.requisite.list` (`ENTITY_TYPE_ID=4`) → id компании (шаги 1-2 вынесены в `resolveCompanyIdsByAccount`).
    `findCompanyByAccount` — компания контрагента (первая; `RQ_ACC_NUM` не уникален). `findMyCompanyByAccount`
    — **моя компания по нашему счёту** (§2 Этап C): те же шаги + фильтр `crm.item.list` `isMyCompany='Y'`
    (подтверждён вживую). Проведено в `crm-sync` `findCompany`. `null` ⇒ `unmatched` (клиент) / «моя компания
    не найдена» → чат ошибок (§5).
  - `server/utils/portalRest.ts` — `makePortalRestCall(memberId, deps)`: связывает `RestCall` с порталом
    (загрузка токена → `ensureAccessToken` → `callRest` с домен+access). DI, тесты; `null` без токена.
  - `server/utils/b24Sdk.ts` — **адаптер транспорта на `@bitrix24/b24jssdk` (#191, ещё НЕ подключён к hot-path):**
    per-portal `B24OAuth` → наш `RestCall`. У SDK встроенный RestrictionManager (leaky-bucket 2 req/s, адаптивная
    задержка, retry-backoff на `QUERY_LIMIT_EXCEEDED`) **по умолчанию** и **per-instance** — один `B24OAuth` на портал
    на джобу даёт сразу пер-портальный лимит **и** bind-`RestCall`-once. `oauthParamsFromToken` (наш `PortalToken`→
    `B24OAuthParams`, сверено `typecheck:server` против реальных типов SDK), `makeSdkRestCall` (unwrap `getData()` —
    контракт `{result,…}` тот же; throw на ошибке → джоба падает, чистый retry), `buildRefreshPersist`+
    `setCallbackRefreshAuth` (SDK сам рефрешит → сохраняем свежий токен в стор), `makePortalSdkCall` (drop-in для
    `makePortalRestCall`). Модуль **серверный** — SDK используется обычным `import` и `new B24OAuth(...)`; чистые мапперы
    и `makeSdkRestCall` (структурный клиент) тестируются фейком без живого портала, а типизация `new B24OAuth` как
    `OAuthCallClient` служит compile-time drift-guard'ом (`typecheck:server`). Свап транспорта
    `crm-sync` — следующий PR после смоук-теста на живом портале (`pnpm sdk:test`); детали — `docs/QUEUES.md` §REST-бюджет.
  - `server/utils/crmActivityWrite.ts` — чистое `writeActivityViaRest(item, companyId, call)`:
    `buildTodoActivity`→`crm.activity.todo.add`→`extractActivityId` (id дела из `{result:{id}}`). Тесты.
  - **REST-фундамент разнесения оплат (#109, первый слайс; чистое ядро + стор, DI, тесты):**
    - `server/utils/invoiceLookup.ts` — чистый lookup смарт-счёта `findInvoicesByNumber(accountNumber,
      {companyId, isNegativeStage?}, call)`: `crm.item.list` `entityTypeId=31`, фильтр по номеру **И
      компании** (IDOR-скоуп), отбрасывает отрицательные стадии (предикат от вызывающего) → массив
      `AllocationCandidate` (сумма=`opportunity`, валюта=`currencyId`). **Имена полей подтверждены на
      живом портале**: `accountNumber`/`companyId`/`mycompanyId`/`stageId`/`opportunity`/`currencyId`.
    - `server/utils/allocationFactStore.ts` — персистентный **стор факта разнесения** «платёж→сущность»
      над `QueryFn` (таблица `allocation_fact`, скоуп по `member_id`): `getAllocationFact`/`recordAllocation`
      (write-once `ON CONFLICT DO NOTHING`)/`revertAllocation` (`allocated`→`reverted` на сторно, история не
      трётся)/`deleteFactsForPortal`. Отличается от `activity_dedup` (op-level): фиксирует цель разнесения и
      допускает откат. Удаление приложения чистит и его. Тесты на fake-query.
    - `server/utils/stageLoader.ts` — чистый **loader «отрицательных» стадий** (DI над `RestCall`, тесты):
      `loadNegativeStages(stageEntityId, call)` — `crm.status.list` → множество `STATUS_ID` с `SEMANTICS='F'`;
      билдеры `ENTITY_ID`: `invoiceStageEntityId(catId)` (`SMART_INVOICE_STAGE_<catId>`), `dealStageEntityId(catId)`
      (`DEAL_STAGE` для воронки 0 / `DEAL_STAGE_<catId>` — **не** `DYNAMIC_…`, подтверждено вживую) и
      `smartProcessStageEntityId(etid, catId)` (**кастомный смарт-процесс** — `DYNAMIC_<etid>_STAGE_<catId>`, стадии
      `DT<etid>_<cat>:FAIL`=`SEMANTICS='F'`; **всегда** реальный id категории — даже СП «без направлений» имеет свою
      дефолт-категорию, не `0`; подтверждено вживую на `DYNAMIC_1032_STAGE_67` и `DYNAMIC_1030_STAGE_63`);
      `makeIsNegativeStage(set)` строит предикат, который принимает `findInvoicesByNumber` (раньше инъектировался
      «снаружи»); `loadInvoiceNegativeStage`/`loadDealNegativeStage`/`loadSmartProcessNegativeStage` — loader+предикат
      одним вызовом. Читает **оба** формата семантики (легаси верхний `SEMANTICS='F'` — он и на живом портале; и
      современный `EXTRA.SEMANTICS='failure'`).
      **Подтверждено вживую**: инвойс «Не оплачен» `DT31_11:D`; сделка `LOSE`/`APOLOGY`; смарт-процесс `DT1032_67:FAIL` = `SEMANTICS='F'`. ⚠ **fail-open**:
      пустое множество = «ничего не отрицательно» (неотличимо от битого запроса) — на проводке в `crm-sync` алертить,
      если для известной категории пусто.
    - `server/utils/itemByIdLookup.ts` — чистый **резолвер цели по id** `findCandidateById(kind, entityTypeId, id,
      {companyId, isNegativeStage?}, call)` для стратегии `by-id` — три идентификатора, у которых значение = собственный
      id целевой сущности: `invoice-id`→инвойс, `deal-id`→сделка, `smart-id`→смарт-процесс (все — один `crm.item.list`,
      разный `entityTypeId`). **Не** `order-id`/`payment-id` — те идут `via-order`/`via-payment` к `deal-payment`
      (объект `crm.item.payment.*`, отдельный резолвер). Запрос фильтром **id+companyId** (id из назначения недоверенный →
      IDOR-скоуп в запросе, чужая сущность не вернётся) + отсев отрицательной стадии → `AllocationCandidate`.
      `crm.item.list`, а не `crm.item.get` (тот бросает `NOT_FOUND`; список отдаёт пусто). Подтверждено вживую: стадия
      категорийной сделки несёт префикс `C<cat>:` (`C5:LOSE`) — совпадает с `DEAL_STAGE_<cat>`. Amount-цели
      (invoice/deal-payment) сверяют сумму (нефинитная → `null`, fail-closed как в `invoiceLookup`), триггер-цели
      (deal/smart-process) её игнорируют.
    - `server/utils/paymentLookup.ts` — чистый **резолвер оплаты сделки** `findDealPayments(dealId, {includePaid?}, call)`
      для цели `deal-payment` (§2, действие `payment.pay`): `crm.item.payment.list` по **известной** сделке
      (`entityId`+`entityTypeId=2`) → кандидаты `deal-payment` (`id`=id оплаты, `amount`=`sum`, `currency`, `dealId`).
      **Подтверждено вживую** (seed-сделка с реальной оплатой): ответ — массив **прямо** в `result` (не `result.items`),
      поля `id`/`accountNumber`/`paid`(`Y`/`N`)/`sum`/`currency`; оплаченные (`paid='Y'`) в кандидаты не берём
      (нечего проводить), нефинитная сумма — пропуск. Разрешает `deal-payment` **когда сделка уже известна и
      скоуплена по компании**; сам company-скоуп в `crm.item.payment.list` не встроить (нет поля `companyId`) —
      предусловие на вызывающем. **`findCompanyDealPayments(companyId, {includePaid?, isNegativeStage?}, call)`** —
      **company-scoped пул** кандидатов `deal-payment` (IDOR-safe путь для `order-number`/`payment-number` и источник
      amount-матчинга §2): `crm.item.list` сделки компании (фильтр `companyId`) → отсев отрицательной стадии → на
      каждую сделку `findDealPayments` (N+1; `crm.item.payment.list` **не батчится**, per-deal вызовы **последовательны**
      — rate-safe by construction; bounded concurrency — за лимитером #191). **Список сделок пагинируется** (`start`/top-level
      `total`, кап `MAX_DEAL_PAGES`; #191): у компании с >50 сделками часть пула иначе молча терялась → неверный
      `manual`/`none`. Нет `total` → одностраничный фолбэк. **Сделка проксирует заказ**: `crm.item.payment.list`
      по сделке отдаёт оплаты заказа (та же `sale.payment` id, `orderId` за ними) — «оплата заказа» = «оплата сделки»,
      отдельного lookup заказа нет. **Глобальный** `sale.payment.list` находит оплату по номеру, но её `sale.order` **не
      несёт связки со сделкой/компанией** (`companyId=null` у CRM-заказов) — привязать к компании плательщика нельзя,
      поэтому используем company-scoped обход (не `sale.*`). `sale`-scope есть (для сторно `payment.pay`/отмены), для
      lookup не нужен — #172.
    - `server/utils/documentLookup.ts` — **мост-документ** `findDocumentEntities(number, call)`: `document-number` из
      назначения → `crm.documentgenerator.document.list` (фильтр `number`) → **массив** привязанных сущностей
      `{entityTypeId, entityId}[]` (ответ `result.documents[]`; номер документа **не** уникален по порталу —
      нумерация генератора per-шаблон/редактируема, поэтому список, как в `invoiceLookup`). Дальше вызывающий
      **перебирает** и **роутит** каждый ref по `entityTypeId` (2→сделка, 31→инвойс, кастом→смарт) через
      `itemByIdLookup` **с проверкой компании**, берёт первый прошедший — номер недоверенный, метод без
      company-фильтра, IDOR-скоуп на вызывающем (как by-id в `identifierDispatch`, `strategy: 'via-document'`).
      **Защитный гард**: `doc.number` сверяется с запрошенным после ответа (обратный фильтр `number` в офдоке не
      показан — если портал тихо проигнорит фильтр, не свяжемся с чужим документом). `select` — только id-поля (не
      `*UrlMachine`, те несут живой access-токен в URL). Поля — **из офдоки**, вживую не подтверждено (в seed 0
      документов); **live-verify реального шаблона+документа — жёсткий гейт PR с wiring `via-document` в crm-sync**.
      Scope `crm` (`crm.documentgenerator.*`).
    - `server/utils/intentResolver.ts` — **чистый диспетчер `resolveIntentCandidates(intent, ctx, call, deps)`** (слайс 2
      капстоуна): по распознанному `RecognitionIntent` (§4) вызывает нужный резолвер сущности и отдаёт `IntentResolution`
      (`status: 'resolved'|'unsupported'`, `candidates`, `reason`). Резолверы **инъектируются** (чистый роутинг тестируется
      без сети). Диспатчатся подтверждённые вживую стратегии: `invoice-number`→`findInvoicesByNumber`, `invoice-id`/`deal-id`→
      `findCandidateById` (фиксированный `entityTypeId` 31/2), `payment-number`→`findCompanyDealPayments`+`filterByAccountNumber`
      (по `ctx.companyId` — IDOR-скоуп плательщика, отсев отрицательных стадий). Остальные — `unsupported` с `reason`
      (не роняем интент молча): `smart-id`/`deal-field`/`smart-field` (нужен `entityTypeId`/поле из «карты сопоставления»),
      `order-id`/`order-number` (#172), `payment-id` (резолв по own-id не подтверждён), `document-number` (гейт live-verify).
      Свитч по `kind` покрывает все виды — исчерпывающий by construction (нет `default`, каждая ветка `return`):
      пропущенный вид роняет `typecheck:server` (TS2366; `server/**` теперь в typecheck, #187), плюс страхует тест
      (гоняет каждый `IdentifierKind` через диспетчер). **Батч-резолвер `resolveIntentsForOp(intents, ctx, call, deps)`**
      резолвит все интенты одной операции, **тянет пул оплат один раз** (`findCompanyDealPayments` company-scoped и не
      зависит от значения → не сканируем компанию на каждый `payment-number`, #191); общий `resolvePaymentNumber`-хелпер
      у одиночного и батч-путей (нет дрейфа). **Встроен в `crm-sync` (слайс 3):** `resolveIntents`-обёртка воркера зовёт
      `resolveIntentsForOp` на матч-компанию → лог кандидатов (`onResolved`), счётчик `resolved`; пока log/count без
      записи. **Отсев отрицательных стадий (`isNegativeStage`) — сделан** (`negativeStages.ts`, ниже): предикат
      грузится ленивым `loadNegativeStagePredicate` ровно один раз на джобу и прокидывается в `resolveIntentsForOp`.
      Запись разнесения (`resolveAllocation`→факт/дело, идемпотентность #184) — следующий под-слайс.
    - `server/utils/negativeStages.ts` — чистый билдер **единого предиката `isNegativeStage` на весь портал**
      (инвойсы + сделки) над `stageLoader`: `crm.category.list` (на тип объекта) → на каждую воронку
      `crm.status.list` → **объединение** отрицательных стадий. Namespace'ы стадий не пересекаются
      (инвойс `DT31_<cat>:…`, сделка `LOSE`/`C<cat>:LOSE`; candidate.stageId ≡ STATUS_ID, подтверждено вживую) →
      один предикат обслуживает инвойсы, сделки и company-пул оплат. `crm.category.list` **пагинируется**
      (метод одностраничный, max 50; >50 воронок иначе молча теряются — fail-open). Диагностика по типу (число
      воронок/отрицательных стадий) → **симметричный fail-open алерт** `failOpenEntities` (0 отрицательных стадий
      **инвойсов ИЛИ сделок** при ≥1 воронке = битый запрос/урезанные права → воркер логирует warning; инвойс —
      основная цель, поэтому не только сделки). Грузится **раз на джобу** (ленивo, только когда первая операция
      реально резолвит намерение). **`stripDealCategoryPrefix`** — предикат матчит и сырой `stageId`, и без
      `C<cat>:`-префикса (форма stage-id дефолтной воронки сделки — `LOSE` vs `C0:LOSE` — вживую не подтверждена;
      strip false-negative-safe: только добавляет матч по фиксированным `LOSE`/`APOLOGY`, валидного кандидата не
      теряет). ⚠ **live-verify формы дефолтной воронки — гейт перед записью разнесения** (сейчас log/count).
      Смарт-процессы пока не включены (их `entityTypeId` портало-специфичен, интенты `unsupported`). DI, тесты
      (`tests/negativeStages.test.ts`).
    Осталось: **rate-limit/bounded-concurrency воркера + bind-`RestCall`-once на джобу +
    батчинг `callBatch` + retry/backoff на `QUERY_LIMIT_EXCEEDED`** — остаток #191 (пул оплат раз-на-op **и пагинация
    списка сделок** уже сделаны; negativeStages грузится раз на джобу, но добавляет `crm.category.list`×2 +
    `crm.status.list`×N — учесть в лимитере; глобальный лимит нужен до реального опроса портала; дизайн —
    `docs/QUEUES.md` «REST-бюджет проводки платежей»); `order-number`-матчинг (связь заказ↔оплата по `<заказ>/<seq>`, live-verify — #172); **следующий
    под-слайс проводки в `crm-sync`** — **запись** разнесения (`summarizeAllocation` уже даёт решение log/count):
    стор факта (`allocationFactStore`) + `autoDistribute`-гейт в настройках + идемпотентность (#184) + действие
    в портале (`payment.pay`/стадия) — за live-verify.
    Поиск моей компании, стадии инвойса/сделки/смарт-процесса, резолв по id (invoice/deal/smart-process), оплаты
    известной сделки, company-пул оплат (**с пагинацией списка сделок**, #191), мост-документ, `payment-number`-фильтр
    по `accountNumber`, **хранение матриц/карты в настройках**, **распознавание намерения в `crm-sync`** (слайс 1),
    **диспетчер intent→кандидаты** (слайс 2: `intentResolver.ts`), **резолюция намерения в кандидаты в `crm-sync`**
    (слайс 3: `resolveIntents`/`onResolved`, log/count) — **готовы**.
  - `app/utils/chatMessage.ts` — чистый `buildChatMessage(item)` (BB-текст операции для чата) +
    `server/utils/chatNotifyWrite.ts` — `notifyChatViaRest(item, dialogId, call)` (`im.message.add`,
    `URL_PREVIEW=N` → `extractMessageId`, id — целое >0). **Ядро стадии 6** (чат-уведомления), тесты.
    **Безопасность:** назначение/контрагент из выписки контролирует плательщик, поэтому внешние поля
    прогоняются через `neutralizeBb` (BB-скобки → полноширинные; общий с `activity.ts`, где он и определён) —
    иначе `[url=…]`/упоминания/кнопки попали бы в чат. Фильтр «что в чат» — `shouldNotifyChat` (в `statement.ts`). Проводка `notifyChat`
    ждёт хранения настроек (#16: dialog id + правила из `app.option`; see worker TODO про 3 нюанса) —
    до этого заглушка.
  - **Настройка уровня приложения (`app.option`) — серверным REST по токену портала:**
    `server/utils/b24Oauth.ts` (refresh access-токена, `B24_CLIENT_ID/SECRET`, чистые URL/parse),
    `server/utils/b24Rest.ts` (`callRest`/`restUrl`), `server/utils/ensureAccessToken.ts`
    (refresh при истечении, **конкуренто-безопасно (#35)**: рефреш сериализован per-portal через
    pg advisory-lock `server/utils/dbLock.ts` + double-checked re-read внутри лока — при scale-out
    N воркеров рефрешат портал ровно один раз, не гоняясь на ротации refresh-токена; DI + тесты),
    `server/utils/appSettings.ts` (чистый `readAppSetting`/`writeAppSetting`
    с DI — изоляция по `memberId`, используется серверной проверкой), `server/utils/settingsHandler.ts`
    (чистый `{status,body}` для UI-роутов по фрейм-токену), `server/utils/liveDeps.ts` (проводка).
    UI-роуты `server/api/settings.get.ts`/`settings.post.ts` (`/app` через `useAppSettings`)
    **аутентифицируются фрейм-токеном** (`Authorization: Bearer` + `X-B24-Domain`) — B24 скоупит
    токен к порталу вызывающего, `member_id` не доверяется, чужой `app.option` недостижим. **Серверная
    проверка** `server/api/b24/app-option-check.get.ts` (guard `B24_APPLICATION_TOKEN`, читает `app.option`
    по сохранённому токену без фрейма — для `scripts/check-app-option.sh`; наружу не открыта, nginx `deny all`).
    `settingsHandler` параметризован ключом `app.option` (дефолт — тест-ключ; чат-настройки — `SETTINGS_KEY`).
  - **Настройки чата (#16 PR-C) — фрейм-токеном под `SETTINGS_KEY`:** `server/api/chat-settings.get.ts`/
    `.post.ts` читают/пишут весь `PortalSettings`-JSON (чат уведомлений + правила + **чат ошибок** +
    **`recognition`** — матрицы/алфавит/карта полей §4), нормализуя через `parsePortalSettings` (никогда не
    пишем мусор); воркер читает тот же ключ/форму. Чистое ядро схемы — `app/utils/settings.ts`
    (`PortalSettings`/`RecognitionSettings`, `parsePortalSettings` — защитный коэрс любого поля к дефолту,
    не бросает; `recognition` растёт без миграции ключа `app.option`; матрицы/карта клампятся по DoS-капам
    `purposeMatch`). `recognition` предназначен для `recognizeByMatrices` (§4) — сама проводка (матрицы/
    алфавит из настроек → распознавание) делается на этапе `crm-sync` (см. «Осталось» выше).
    Поиск чатов для пикера — `server/utils/chatSearch.ts` (чистое ядро над `RestCall`: `im.search.chat.list`
    для запроса ≥3 симв., `im.recent.list` для дефолтного списка недавних групп; только куда можно писать;
    `nextOffset`-курсор) + роут `server/api/chat-search.get.ts` (фрейм-токен). UI-пикер — `AsyncSearchSelect`
    (+ `useRemoteSearch`/`app/utils/remoteSearch.ts`: дебаунс, гонка, курсор-пагинация, «Показать ещё»).
  - Backend — отдельный docker-сервис (`Dockerfile` target `backend`, `nuxt build`), Postgres рядом.
    В проде — **один домен**: nginx `app` проксирует `/api/*` в `backend:3000` (вебхук B24 на
    `https://<DOMAIN>/api/b24/events`, без CORS); CI пушит два образа (matrix `runner`+`backend`),
    `docker-compose.prod.yml` поднимает `app`+`backend`+`db`. Деплой/контракт —
    [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md), [`docs/DEPLOY.md`](docs/DEPLOY.md).

  Ссылки на доку Альфы — [`docs/ALFA_API.md`](docs/ALFA_API.md); по Приорбанку/текстовой выписке —
  [`docs/PRIOR_API.md`](docs/PRIOR_API.md).
- **Скрипты разведки (dev, не часть SSG):**
  - `scripts/alfa-oauth-test.mjs` (`pnpm oauth:test`) — живой прогон OAuth/выписки Альфы по
    `.env.alfabankby` (sandbox), маскировка секретов; см. `docs/ALFA_API.md`.
  - `scripts/prior-oauth-test.mjs` (`pnpm prior:test`) — живой прогон Open Banking (СПР) Приорбанка
    по `.env.priorbank` (sandbox): `--gen-key`/`--oidc`/`--dcr`/consent→authorize→выписка; см. `docs/PRIOR_API.md`.
  - **Оба банк-скрипта импортят чистые OAuth-ядра напрямую** (`alfaOauth.ts`/`priorOauth.ts`) —
    инлайн-копий билдеров URL/тел/claims больше нет, дрейф невозможен by construction (#45; раньше
    так возник баг auth Альфы #26). Node стрипает `.ts`-типы на лету (`--experimental-strip-types`
    в `oauth:test`/`prior:test`; ядра без импортов, лоадер не нужен). RS256-подпись и `node:crypto` —
    у Приора локально. Реальный путь скриптов теперь покрыт тестами ядер (`tests/{alfa,prior}Oauth.test.ts`).
  - `scripts/parse-statement.ts` (`pnpm parse:statement <файл>`) — разбор ручной выписки через
    канонический диспетчер `manualImport.ts` (оба формата: client-bank `***** ^Type=` и
    `1CClientBankExchange`) → печатает единый `StatementItem[]` (+ секционный вид для текстового
    формата). Node ≥ 22, нативный TS-стриппинг; `~/`-алиасы резолвит `scripts/lib/alias-loader.mjs`.
  - `scripts/fuzz-allocation.ts` (`pnpm fuzz:allocation [seed] [N]`) — **исследовательский фузз-прогон
    алгоритма разнесения** (#109): прогоняет N случайных платежей против синтетической «CRM» через
    **реальные** чистые ядра (`recognizeByMatrices` → `routeIdentifier` → `resolveAllocation`) +
    mock-проводку по `PROCESSING.md` §2, сводит **логическую модель исходов** (распределение по 11
    категориям + «просадки»). Детерминированно (seeded PRNG). Dev-only, охват демонстрационный (5 из 11
    `IdentifierKind`, один id на назначение); mock `classify()` — **черновик** будущей `crm-sync`-проводки,
    свериться при её появлении (#109). **CI-gate композиции** ядер — не скрипт, а `tests/allocationPipeline.test.ts`.
  - `scripts/b24-sdk-test.mjs` (`pnpm sdk:test` / `--burst`) — **дев-смоук транспорта `@bitrix24/b24jssdk`** (#191):
    строит `B24Hook` из вебхука `.env.b24test`, делает пару REST-вызовов + батч и печатает статистику лимитера;
    `--burst` — 60 быстрых вызовов, чтобы увидеть само-троттлинг (без `QUERY_LIMIT_EXCEEDED`). Гейт перед свапом
    транспорта `crm-sync` на SDK (см. `server/utils/b24Sdk.ts`). Dev-only, не часть SSG; токен только в git-ignored `.env.b24test`.
  - `scripts/seed-test-b24.mjs` (`pnpm seed:b24` / `--list` / `--purge`) — **идемпотентный посев тестовых
    данных в живой тестовый портал Б24** для ручной проверки #109 (стадия 4/§2 `PROCESSING.md`): смарт-
    процессы (с направлениями / без — `entityTypeId` назначается автоматически, на подтверждённом
    портале вышли `1032`/`1030`), смарт-счета (оплачен `DT31_11:P` /
    открытый `:N` / не оплачен `:D`=SEMANTICS=F, исключается `invoiceLookup`), сделки в разных воронках
    (сделка Опт несёт **реальную оплату** — объект `crm.item.payment`, цель `deal-payment` #109: товарная
    позиция → `payment.add` → `payment.product.add` → `payment.pay` — плюс привязанный оплаченный счёт;
    Розница без оплаты), товары, компании-клиенты (с реквизитами и без → путь
    UNMATCHED), «мои компании» (`isMyCompany=Y` + наш счёт для §2 Этап C). Всё под тегом `[TEST]`/XML_ID
    `CBATEST_`; повторный прогон обновляет, а не дублирует (восстановление при смене портала). Хук — из
    **git-ignored** `.env.b24test` (`B24_TEST_WEBHOOK`, шаблон `.env.b24test.example`; токен не коммитим).
    **Порядок purge важен**: банк-деталь → реквизит → компания, ПОКА компания жива — иначе Б24 осиротит
    реквизиты без прав на удаление, и «зомби»-банк-деталь навсегда испортит поиск по счёту. **Расчётный
    счёт `RQ_ACC_NUM` не уникален** (может быть на нескольких компаниях). **Ограничение:** удалить сделку с
    оплаченной оплатой нельзя без scope `sale` (`crm`-only токен → `insufficient_scope`); purge такую сделку
    пропускает с предупреждением. Подтверждено вживую: `companyLookup` (счёт→компания), поля смарт-счёта,
    реальная оплата сделки. Dev-only, не часть SSG.
  - **Тестовый портал Б24 и скоупы вебхука** (для ручной проверки #109; сам портал сменный —
    восстанавливаем данные `pnpm seed:b24`). Вебхук храним **только** в git-ignored `.env.b24test`
    (`B24_TEST_WEBHOOK`), в репозиторий он не попадает; при смене портала переписываем эту строку.
    Скоупы вебхука (гейт того, что можно проверить руками):
    - **`crm`** — есть; хватает для всего текущего seed (компании/реквизиты/счета/сделки/смарт-процессы/
      товары) и путей #109 (поиск компании, инвойс, оплата сделки — создание/проведение, company-пул оплат).
    - **`sale`** — **добавлен на тестовый вебхук** (владелец, #172). Пригодился для пробы: подтвердил, что
      глобальный `sale.payment.list` находит оплату по номеру, но `sale.order` **не несёт** связки со
      сделкой/компанией (`companyId=null`) → к плательщику не привязать (IDOR) → для lookup используем
      company-scoped обход в `crm`, не `sale.*`. Реальная роль `sale` — **сторно** (`sale.payment.update PAID=N`,
      отмена оплаченной оплаты; без него `--purge` пропускает такую сделку).
    - **`documentgenerator`** — **добавлен** (владелец); под мост-документ (`crm.documentgenerator.document.list`,
      `document-number` → сущность). В seed пока 0 документов — проверка при появлении образца.
    - **`im`** — понадобится позже для уведомлений в чат (стадия 6, `im.message.add`); на текущем тестовом
      хуке не проверялось.
    Требуемые скоупы **самого приложения** (не вебхука) — `app/config/b24.ts` `B24_REQUIRED_SCOPES`
    (`crm`, `im`, `user_brief`, `placement`); `sale`/`documentgenerator` там пока **нет** (в коде приложение
    их ещё не вызывает — lookup идёт по `crm`); добавить в контракт при внедрении сторно/моста — `PROCESSING.md §8`.
  - `scripts/lib/*.mjs` — общая обвязка банк- и seed-скриптов (одинаковые запуск/проверка/вывод):
    `demo-utils`/`env` (чистые, покрыты тестами), `http` (единый `httpRequest`, TLS-проверку не отключает),
    `cli` (цвета `C`, префиксы `ok/warn/err/head`, `die`, кросс-платформенный `openBrowser` — URL-гейт
    `openBrowser` покрыт тестом `tests/cliOpenBrowser.test.ts`, #45).
- `tests/*.test.ts` — Vitest (node) на чистые утилиты.
- `tests/nuxt/**/*.test.ts` — Vitest (проект `nuxt`) на компоненты/страницы (`mountSuspended`).

Чистую логику выносим в `app/utils/*` и покрываем тестами; реактивную — в `app/composables/*`,
UI — в компонентах. Это та же раскладка, что в `currency-converter` — держим её при развитии.

## Встройка в Bitrix24 (этап 2)

Приложение работает в двух режимах: standalone (публичный лендинг `/`) и как iframe-приложение
внутри портала (`/app`, `/settings`, `/install`). SDK — `@bitrix24/b24jssdk` (+ `-nuxt`).

- `useB24().init()` молча no-op вне фрейма (нет `window.name`) — поэтому in-portal-страницы рендерятся
  и как обычные URL, и внутри портала без отдельной ветки.
- `/install` делает `init → event.bind (ONAPPINSTALL/ONAPPUNINSTALL) → installFinish` + диагностику.
  Привязка событий — до `installFinish`, чтобы текущая установка доставила `application_token`
  на backend `/api/b24/events`. **`placement.bind` не вызываем** — как именно приложение встроено
  (плейсменты) зависит от регистрации; финализируем на тестовом портале. `NUXT_PUBLIC_SITE_URL`
  (build-arg) в проде **обязателен** — из него строится абсолютный URL хендлера событий (без него
  `/install` откажется биндить относительный URL и покажет ошибку с retry).
- **Вызовы B24 для данных/настроек — server-side REST по OAuth-токену (backend), не через фрейм** (см.
  «Хранение настроек» в [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md)). Фрейм-SDK тут — только установка
  и UI-хром (`setTitle`/`fitWindow`). **Учёт всех REST-вызовов** (метод, поколение/версия, scope,
  транспорт фрейм/сервер, файл-владелец, батч) — [`docs/REST_METHODS.md`](docs/REST_METHODS.md); правим
  при добавлении/замене метода (для точечной миграции при депрекейте).
- **Серверные события — отдельный механизм** (не фрейм-`/install`): исходящие вебхуки Б24
  `ONAPPINSTALL`/`ONAPPUNINSTALL` на backend (`server/api/b24/events.post.ts`) дают `application_token`
  (подпись событий) и OAuth-креды портала; токены пишутся в Postgres (`server/utils/tokenStore.ts`).
  Доменное ядро (разбор, вердикт токена, маршрутизация) — `app/utils/b24Events.ts`; контракт и
  модель учёта авторизации — [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md).
- Тесты: чистый `tests/b24.test.ts` (скоупы) + `tests/b24EventBind.test.ts` (билдер привязок —
  свежая установка/идемпотентность/перепривязка/чужие события/регистр); `tests/nuxt/install.nuxt.test.ts`
  (standalone-редирект + `event.bind` двух событий на `…/api/b24/events` до `installFinish`) через
  типизированный мок `tests/nuxt/helpers/mockB24.ts` (`makeMockB24`, `ReturnType<typeof useB24>`
  ловит дрейф). Реальный install-flow в портале автотестами не покрыть — проверяется вручную.
- CSP в `nginx.conf` уже разрешает облачные домены Б24 (`frame-ancestors`/`connect-src`).

## Настройка репозитория

- **В main не пушим — только через PR.** Защита `main` (ruleset `protect-main`) и CI как
  required-check настраиваются владельцем репо по [`docs/REPO_SETUP_CHECKLIST.md`](docs/REPO_SETUP_CHECKLIST.md).
- `.github/workflows/ci.yml` — пайплайн `CI/CD`: job `ci` (lint → test → typecheck → generate),
  `docker-build` (валидирует сборку образа на каждом PR, без push) и `deploy` (push в GHCR на
  `main`, gate по зелёному `ci`). Имя `ci` — то, что включается в required status checks ruleset'а.
  Сторонние actions запинены на commit SHA (issue #2; SHA обновляет Dependabot по комментарию `# vX.Y.Z`).
- `.github/dependabot.yml` — обновления `npm`, `github-actions` и `docker` (база `node` / `nginx-unprivileged`;
  major `node` игнорируется — 25+ убрал corepack).
- `.claude/` — SessionStart-хук (`hooks/session-start.sh`): в веб-сессиях Claude Code ставит
  зависимости и гоняет `nuxt prepare`, чтобы lint/typecheck/test/build работали с первого хода.

## Визуальная верификация (Definition of Done)

> **ВАЖНО:** после любой правки UI/CSS/вёрстки снять скриншот результата и
> посмотреть на пиксели **до** того, как считать задачу выполненной — не доверять
> «собралось без ошибок». `pnpm generate && pnpm screenshot` → смотреть
> `screenshots/` (mobile/desktop × light/dark). Детали и чек-лист —
> [`docs/VISUAL_VERIFICATION.md`](docs/VISUAL_VERIFICATION.md).

OG-картинка (`public/og.png`, 1200×630) генерируется из HTML-шаблона через
пред-установленный Chromium — `pnpm og` (`scripts/make-og.mjs`); коммитим как
статику. Перегенерировать при смене заголовка/брендинга.

## Деплой

Фронтенд (лендинг + B24-iframe-UI) деплоится как статика за nginx — по той же схеме, что
`currency-converter`: **GHCR + Watchtower за общим nginx-proxy**. Подробности — [`docs/DEPLOY.md`](docs/DEPLOY.md).

- Прод-образ — `nginxinc/nginx-unprivileged` (non-root, слушает `:8080`), статика из `nuxt generate`.
- CSP отдаётся **без** `script-src 'unsafe-inline'`: два inline-скрипта Nuxt (`theme-init` в `app.vue`
  и `window.__NUXT__.config` с меняющимся `buildId`) разрешаются по sha256-хэшам, которые
  `scripts/csp-hashes.mjs` считает из собранного HTML и подставляет в `nginx.conf` (плейсхолдер
  `__CSP_SCRIPT_HASHES__`) на этапе сборки. `frame-ancestors`/`connect-src` разрешают облачные
  домены Б24 (iframe-встройка `/app`,`/settings`); backend — **тот же origin** (`/api/*`, покрыт `'self'`).
  Лендинг несёт **Яндекс.Метрику** (инлайн-счётчик из `nuxt.config.ts`, `NUXT_PUBLIC_METRIKA_ID`;
  его sha256 подхватывает `csp-hashes.mjs`, CSP разрешает `mc.yandex.ru` в script/img/connect/frame-src)
  и **встроенную CRM-форму Б24** (iframe на `public/b24-form.html` со своим form-scoped CSP —
  `location = /b24-form.html`; `NUXT_PUBLIC_B24_FORM_*`, пустые → слот).
  Метрика-сниппет **самозаглушается в iframe** (`window.self !== window.top`): in-portal-страницы
  (`/app`,`/settings`,`/install`) внутри портала Б24 Метрику **не** инициализируют — иначе webvisor
  писал бы session-replay CRM клиента, а цели пачкали бы аналитику лендинга портальным трафиком
  (`ym` тогда не определён → `useMetrikaGoal` no-op). Тот же приём, что в `currency-converter`
  (там — в `public/metrika.js`).
  `POST /api/auth/login` дросселируется `limit_req` (зона `login`, ~10r/m по IP клиента через
  `real_ip` из `X-Forwarded-For`, `burst=5 nodelay` → 429) — антибрутфорс общего пароля оператора (#64, см. `docs/AUTH.md`).
- `docker-compose.yml` — локальная сборка: `app` (статика лендинга, nginx), `backend` (node-сервер,
  эндпоинт вебхуков Б24) и `db` (Postgres). `docker-compose.prod.yml` — прод `app`+`backend`+`db`
  (GHCR-образы + Watchtower за nginx-proxy); один домен — nginx `app` проксирует `/api/*` в backend.
  Общий reverse-proxy (`nginx-proxy` + `acme-companion`, сеть `proxy-net`) ставится на сервере один
  раз — см. `currency-converter/docker-compose.nginxproxy.yml`, не дублируем здесь.
- **Backend** — `Dockerfile` target `backend` (`nuxt build`, node-сервер). Приём событий Б24 и хранилище
  токенов **реализованы** (этап 3, слайс; #35); OAuth Альфы/опрос/дела/чат — далее (этапы 4–6). Env и
  запуск — `.env.example`, [`docs/DEPLOY.md`](docs/DEPLOY.md), [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md).

## Отчётность (reporting-kit)

Вендорный бандл для работы с AI-агентом и отчётов в Telegram — в
[`reporting-kit/`](reporting-kit/) (карточка интеграции —
[`docs/REPORTING_KIT.md`](docs/REPORTING_KIT.md)). Держим как есть для синхронизации
с источником; у него **свои конвенции и свой CI**, поэтому он **не линтуется**
нашими проверками: исключён из ESLint и `tests/mdReviewStamp.test.ts`, добавлен в
`.dockerignore` (чтобы не попадал в Docker-образ). Навыки `/report-status`,
`/report-digest`, `/report-questions` и `tg-send.sh` — внутри бандла. Telegram
пока не заведён (нужен `.env` с токеном, локально, см. README кита).

Канонический **срез состояния проекта** (цель/шаги/сделано/дальше/блокеры) — [`docs/project-map.md`](docs/project-map.md);
на него опираются `/report-status` и `/report-questions`. Держим синхронно с `REFACTOR_PLAN.md`.

## Конвенции

- Комментарии и JSDoc — на английском; пользовательский текст и README — на русском.
- Чистые функции — в `app/utils/*`, данные/константы — в `app/config/*` (уже есть:
  `banks.ts`), типы — в `app/types/*`; всё покрываем тестами. Реактивную логику — в
  `app/composables/*` (появится по мере роста), UI — в компонентах/страницах.
- Данные из API рендерим только через `{{ }}` (auto-escape) — никакого `v-html` с внешними данными.
- Штамп ревью: каждый `.md`-документ в корне и `docs/` несёт строку `> Last reviewed: YYYY-MM-DD`
  блок-цитатой сразу под заголовком H1. Ключ `Last reviewed` всегда на английском (технический
  маркер). Дату бампим только при содержательном изменении. Наличие штампа во всех отслеживаемых
  `.md` (кроме вендорного `reporting-kit/`) проверяет `tests/mdReviewStamp.test.ts`.
