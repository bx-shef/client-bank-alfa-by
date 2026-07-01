# CLAUDE.md

> Last reviewed: 2026-07-01

Приложение Bitrix24 для импорта выписки из клиент-банка: онлайн из Альфа-Банка
Беларусь (портал может быть в любой стране) или ручной загрузкой любой стандартной
выписки. Публичная страница — лендинг (SSG). Появилась серверная часть (Nitro):
эндпоинт вебхуков Bitrix24 (`/api/b24/events`) + хранилище токенов портала.

> **Статус:** рефакторинг legacy-приложения (план — [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md)).
> Репозиторий: **frontend** (публичный лендинг SSG + B24-iframe-UI) **и backend** (Nitro-сервис:
> приём событий установки/удаления Б24, учёт авторизации портала; дальше — OAuth Альфы, опрос,
> запись дел/чата, MCP). Заложено доменное ядро (типы выписки, абстракция банк-провайдеров, чистые
> утилиты, билдер дела, разбор/маршрутизация событий Б24) и демо-страница на mock-данных; backend
> событий Б24 реализован (этап 3, слайс), реальная интеграция Альфы — далее. Деплой: статика лендинга
> за nginx + отдельный backend-сервис с Postgres (как `bx-synapse`). Эталон стека — `currency-converter`.

## Стек

- **Nuxt 4** (статическая генерация, `nuxt generate`)
- **Vue 3** — `<script setup lang="ts">`
- **TypeScript** (строгий), **Tailwind CSS v4**, **Bitrix24 UI** (`b24ui`)
- **Bitrix24 JS SDK** (`@bitrix24/b24jssdk` + `-nuxt`) — встройка в портал (dual-mode, `/install`)
- **Vitest** — два проекта: `unit` (node, чистые функции) и `nuxt`
  (`@nuxt/test-utils` + happy-dom, composables и компоненты)

## Команды

```bash
pnpm dev          # дев-сервер
pnpm lint         # ESLint
pnpm typecheck    # vue-tsc --noEmit
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
- `app/pages/index.vue` — публичная страница лендинга (hero + преимущества + подвал). Standalone,
  без `clear`-layout (вне портала), без `B24App`.
- `app/pages/app.vue` — in-portal просмотр выписки на **b24ui**: полоса статуса импорта
  (`ImportStatusBanner`) первым элементом, `B24Tabs` «Приходы»/«Расходы» (счётчики в заголовке),
  итог секции + `OperationList`. Демо-данные. Layout `clear`, `useB24().init()` (вне фрейма — no-op),
  в портале — `setTitle`/`fitWindow` (best-effort, try/catch).
- `app/pages/settings.vue` — in-portal настройки на **b24ui**: `B24Form` из трёх `B24Card`-секций
  (подключение банка `B24Input`; уведомления — `B24Select` чата + `B24Switch` приходы/расходы;
  исключения — `B24Textarea`) + живой предпросмотр (sticky `B24Card` «что попадёт в чат», `B24Badge`).
  Автосейв в localStorage (демо, ключ API не сохраняется), реальное хранение — backend (#16). Layout
  `clear` + `useB24().init()`. Роут `/settings` — в `nitro.prerender.routes`.
- `app/pages/install.vue` — обработчик установки B24 (layout `clear`): `init` → `installFinish`
  (+ диагностика портала); вне фрейма — редирект на `/`. `placement.bind` **пока не делаем** —
  плейсменты добиваем на тестовом портале (см. план).
- `app/layouts/clear.vue` — минимальный layout под in-portal-страницы (`<B24App>` для тем/тостов в iframe).
- `app/config/b24.ts` — чистые константы встройки: `B24_REQUIRED_SCOPES` (`crm`, `im`, `user_brief`, `placement`).
- `app/composables/useB24.ts` — обёртка над `B24Frame`: `init()` (идемпотентен; no-op вне фрейма —
  когда нет `window.name`), `isInit()`, `get()`/`getOrThrow()`, `targetOrigin()`, `getRequiredRights()`.
- `app/composables/useChatRules.ts` — реактивные настройки (localStorage, без `apiKey`); производит
  `rules: ChatNotifyRules` (из `app/utils/statement.ts`).
- `app/components/ImportStatusBanner.vue` — полоса статуса импорта (`B24Alert`, цвет = состояние:
  ok/running/error); «Обновлено N минут назад», «+N операций», «Записано в CRM · N в чат», при ошибке —
  действие «Проверить настройки». `app/components/OperationList.vue` — секция операций
  (`B24Card` на операцию, пустое состояние, `B24Skeleton` под загрузку).
- `app/types/importStatus.ts` + `app/utils/importStatus.ts` (relative-time RU `formatRelativeTime`,
  `pluralRu`, `importStateMeta`) + `app/composables/useImportStatus.ts` — модель и презентация статуса
  импорта; mock на клиенте до backend-опроса (#5), форма ответа = будущий `GET /import/status`.
- `app/components/BuildFooter.vue` (+ `app/utils/build.ts`, покрыт тестами) — подвал лендинга и
  `/app`: автор + ссылка на **коммит сборки** (`сборка <sha>` → GitHub commit); sha из
  `NUXT_PUBLIC_COMMIT_SHA` (CI передаёт `github.sha`, в dev — «dev»).
- `app/composables/useAppSettings.ts` — тестовая настройка уровня приложения: берёт из фрейма
  **access-токен + домен** и шлёт их в `/api/settings` (GET/POST) заголовками
  `Authorization: Bearer` + `X-B24-Domain`; backend этим токеном пишет/читает `app.option`. Вне
  портала инертна (токена нет). member_id UI не доверяет — изоляция на стороне B24 (токен скоуплен к порталу).
- `app/config/chat.ts` — заглушка списка чатов (`MOCK_CHATS`) до подключения B24 SDK.
- `app/utils/landing.ts` — чистая логика лендинга (`LANDING_*`, `copyrightYears`), покрыта тестами.
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
  - `app/utils/alfaOauth.ts` — OAuth 2.0 Альфы (Authorization Code + refresh): URL/тела запросов, парсинг.
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
    остаточный рефактор (словари ключей/DoS-гард) — issue #19.
  - `app/utils/clientBankStatement.ts` — нормализация разобранной текстовой выписки в `StatementItem`
    (`normalizeClientBank` — контракт `StatementNormalizer`; приход/расход, валюта нац/инвалюта,
    контрагент, `account|docId`-дедуп). Провайдер `manual` (и файловый путь `prior-by`) — issue #19.
    Проверено на образцах `tests/fixtures/client-bank/` (BYN `Type=400`, CNY `Type=600`).
  - `app/utils/mockStatement.ts` — демо-данные для UI до реальной интеграции.
  - `app/types/b24Events.ts` + `app/utils/b24Events.ts` — события Б24 (`ONAPPINSTALL`/
    `ONAPPUNINSTALL`): разбор wire-формата (`parseBracketForm`, PHP-скобки), вердикт
    подлинности `application_token` (`appTokenVerdict`, fail-closed, constant-time),
    маршрутизация `routeB24Event`, SSRF-гуард `isSafeClientEndpoint`, маппинг кредов
    портала `extractPortalCredentials`. Учёт авторизации/события/брокер — карточка
    [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md) (модель по backend `bx-synapse`).
- **Backend (Nitro, `server/`):** серверная часть в том же приложении (как `bx-synapse`).
  - `server/api/b24/events.post.ts` — эндпоинт вебхуков Б24: `readRawBody` → `parseBracketForm`
    → `processB24Event`; на установке пишет токены, на удалении (`CLEAN=1`) стирает портал.
  - `server/api/health.get.ts` — публичный liveness-эндпоинт `GET /api/health` →
    `{ status, time, commit, commitUrl }` (коммит = `NUXT_PUBLIC_COMMIT_SHA`, как в подвале).
    Без секретов; на нём же построен docker `healthcheck` backend'а. Чистый билдер —
    `healthInfo` в `app/utils/build.ts` (покрыт тестами).
  - `server/utils/b24EventsHandler.ts` — чистый `processB24Event(payload, deps)` (DI side-effects):
    вердикт `application_token` → HTTP 200/400/403/503 (fail-closed). Покрыт тестами.
  - `server/utils/tokenStore.ts` — хранилище токенов портала над инъектируемым `QueryFn`
    (`save`/`get`/`getApplicationToken`/`delete`, write-once `application_token`). Тесты на fake-query.
  - `server/utils/secretCrypto.ts` — AES-256-GCM шифрование `refresh_token` (ключ `B24_TOKEN_ENC_KEY`).
  - `server/db/client.ts` — ленивый pg-Pool (`DATABASE_URL`) + схема `portal_tokens`;
    `server/plugins/migrate.ts` — идемпотентная миграция на старте.
  - **Очереди (BullMQ + Redis) — шина под нагрузку/масштабирование** (`server/queue/`):
    - `topology.ts` — чистые контракты: очереди `b24-events`/`bank-fetch`/`file-parse`/`crm-sync`,
      payload'ы (`EventJob`/`FetchJob`/`ParseJob`/`CrmSyncJob`), идемпотентные `*JobId` (дедуп ретраев). Тесты.
    - `connection.ts` — ленивый `getQueue(name)`; передаёт BullMQ **опции** (парсит `REDIS_URL`), а не
      ioredis-инстанс — нет прямой зависимости от ioredis и связки версий. Гуард `queueEnabled()`.
    - `producers.ts` — `enqueueEvent/Fetch/Parse/CrmSync` (no-op без Redis).
    - `handlers.ts` — **чистые обработчики с DI** (тесты): fetch/parse → нормализованный батч в `crm-sync`;
      `crm-sync` дедупит (`account|docId`), делит приход/расход, на операцию: поиск компании →
      универсальное дело → чат. Транспорты (Альфа/Приор/парсер/REST) — заглушки до стадий 3–6.
    - `worker.ts` — BullMQ-воркеры на обработчики (`liveHandlerDeps`); `cron.ts` — план опроса
      (`planFetches`) + **демо-нагрузка** (`buildDemoFetchJobs`/`demoItems`).
    - `server/plugins/queue.ts` — на старте backend поднимает воркеры **в процессе** и (если
      `DEMO_LOAD_N>0`) крон каждые `CRON_INTERVAL_MIN` кладёт синтетические fetch-джобы (демо потока).
      Масштаб-аут (отдельный воркер-контейнер) — следующий шаг (см. REFACTOR_PLAN).
    - **Наблюдаемость сейчас:** `server/api/queues.get.ts` (`GET /api/queues` — счётчики по очередям,
      guard `B24_APPLICATION_TOKEN`, nginx `deny all`) + `scripts/queue-stats.sh`. Телеметрия в
      Grafana (Prometheus-экспортёр BullMQ / bull-board) — зафиксированное намерение, отдельный этап.
    Redis — сервис в compose на изолированной сети `queuenet` (`internal: true`, том `redisdata`).
  - **Настройка уровня приложения (`app.option`) — серверным REST по токену портала:**
    `server/utils/b24Oauth.ts` (refresh access-токена, `B24_CLIENT_ID/SECRET`, чистые URL/parse),
    `server/utils/b24Rest.ts` (`callRest`/`restUrl`), `server/utils/ensureAccessToken.ts`
    (refresh при истечении), `server/utils/appSettings.ts` (чистый `readAppSetting`/`writeAppSetting`
    с DI — изоляция по `memberId`, используется серверной проверкой), `server/utils/settingsHandler.ts`
    (чистый `{status,body}` для UI-роутов по фрейм-токену), `server/utils/liveDeps.ts` (проводка).
    UI-роуты `server/api/settings.get.ts`/`settings.post.ts` (`/app` через `useAppSettings`)
    **аутентифицируются фрейм-токеном** (`Authorization: Bearer` + `X-B24-Domain`) — B24 скоупит
    токен к порталу вызывающего, `member_id` не доверяется, чужой `app.option` недостижим. **Серверная
    проверка** `server/api/b24/app-option-check.get.ts` (guard `B24_APPLICATION_TOKEN`, читает `app.option`
    по сохранённому токену без фрейма — для `scripts/check-app-option.sh`; наружу не открыта, nginx `deny all`).
  - Backend — отдельный docker-сервис (`Dockerfile` target `backend`, `nuxt build`), Postgres рядом.
    В проде — **один домен**: nginx `app` проксирует `/api/*` в `backend:3000` (вебхук B24 на
    `https://<DOMAIN>/api/b24/events`, без CORS); CI пушит два образа (matrix `runner`+`backend`),
    `docker-compose.prod.yml` поднимает `app`+`backend`+`db`. Деплой/контракт —
    [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md), [`docs/DEPLOY.md`](docs/DEPLOY.md).

  Ссылки на доку Альфы — [`docs/ALFA_API.md`](docs/ALFA_API.md); по Приорбанку/текстовой выписке —
  [`docs/PRIOR_API.md`](docs/PRIOR_API.md).
- **Скрипты разведки (dev, не часть SSG):**
  - `scripts/alfa-oauth-test.mjs` (`pnpm oauth:test`) — живой прогон OAuth/выписки Альфы по
    `.env.sandbox` (sandbox), маскировка секретов; см. `docs/ALFA_API.md`.
  - `scripts/prior-oauth-test.mjs` (`pnpm prior:test`) — живой прогон Open Banking (СПР) Приорбанка
    по `.env.priorbank` (sandbox): `--gen-key`/`--oidc`/`--dcr`/consent→authorize→выписка; см. `docs/PRIOR_API.md`.
  - `scripts/parse-statement.ts` (`pnpm parse:statement <файл>`) — разбор текстовой выписки
    через канонический `clientBankText.ts` (Node ≥ 22, нативный TS-стриппинг).
  - `scripts/lib/*.mjs` — общая обвязка обоих банк-скриптов (одинаковые запуск/проверка/вывод):
    `demo-utils`/`env` (чистые, покрыты тестами), `http` (единый `httpRequest`, TLS-проверку не отключает),
    `cli` (цвета `C`, префиксы `ok/warn/err/head`, `die`, кросс-платформенный `openBrowser`).
- `tests/*.test.ts` — Vitest (node) на чистые утилиты.
- `tests/nuxt/**/*.test.ts` — Vitest (проект `nuxt`) на компоненты/страницы (`mountSuspended`).

Чистую логику выносим в `app/utils/*` и покрываем тестами; реактивную — в `app/composables/*`,
UI — в компонентах. Это та же раскладка, что в `currency-converter` — держим её при развитии.

## Встройка в Bitrix24 (этап 2)

Приложение работает в двух режимах: standalone (публичный лендинг `/`) и как iframe-приложение
внутри портала (`/app`, `/settings`, `/install`). SDK — `@bitrix24/b24jssdk` (+ `-nuxt`).

- `useB24().init()` молча no-op вне фрейма (нет `window.name`) — поэтому in-portal-страницы рендерятся
  и как обычные URL, и внутри портала без отдельной ветки.
- `/install` сейчас делает только `init → installFinish` + диагностику. **`placement.bind` не вызываем** —
  как именно приложение встроено в портал (плейсменты/хендлер) зависит от регистрации приложения;
  финализируем на тестовом портале. `NUXT_PUBLIC_SITE_URL` (build-arg) понадобится тогда для абсолютных
  URL хендлеров; сейчас опционален.
- **Вызовы B24 для данных/настроек — server-side REST по OAuth-токену (backend), не через фрейм** (см.
  «Хранение настроек» в [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md)). Фрейм-SDK тут — только установка
  и UI-хром (`setTitle`/`fitWindow`).
- **Серверные события — отдельный механизм** (не фрейм-`/install`): исходящие вебхуки Б24
  `ONAPPINSTALL`/`ONAPPUNINSTALL` на backend (`server/api/b24/events.post.ts`) дают `application_token`
  (подпись событий) и OAuth-креды портала; токены пишутся в Postgres (`server/utils/tokenStore.ts`).
  Доменное ядро (разбор, вердикт токена, маршрутизация) — `app/utils/b24Events.ts`; контракт и
  модель учёта авторизации — [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md).
- Тесты: чистый `tests/b24.test.ts` (скоупы); `tests/nuxt/install.nuxt.test.ts` (standalone-редирект)
  через типизированный мок `tests/nuxt/helpers/mockB24.ts` (`makeMockB24`, `ReturnType<typeof useB24>`
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
