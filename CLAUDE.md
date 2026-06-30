# CLAUDE.md

> Last reviewed: 2026-06-30

Приложение для получения выписки из клиент-банка Альфа-Банк Беларусь.
Статическое приложение (SSG), без серверной части. Публичная страница — лендинг.

> **Статус:** рефакторинг legacy-приложения (план — [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md)).
> Этот репозиторий — **frontend**: публичный лендинг (SSG) + B24-iframe-UI. Серверная часть
> (OAuth Альфы, опрос, запись дел/чата, MCP) — отдельный backend-сервис (см. план). Сейчас
> заложено доменное ядро (типы выписки, абстракция банк-провайдеров, чистые утилиты, билдер
> универсального дела) и демо-страница просмотра выписки на mock-данных; реальная интеграция
> Альфы подключается backend'ом. Эталон стека — соседний `currency-converter`.

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

- `app/app.vue` — **корень Nuxt** (не страница): `useHead`/SEO/`theme-init`, рендерит `<NuxtLayout>`/`<NuxtPage>`.
- `app/app.config.ts` — нативный colorMode b24ui (`colorMode: true`, `colorModeInitialValue: 'auto'`);
  без этих top-level ключей `useColorMode()` = no-op stub.
- `app/assets/css/main.css` — Tailwind v4 + импорт темы b24ui.
- `app/pages/index.vue` — публичная страница лендинга (hero + преимущества + подвал). Standalone,
  без `clear`-layout (вне портала), без `B24App`.
- `app/pages/app.vue` — in-portal просмотр выписки (приходы/расходы); пока на mock-данных. Layout
  `clear`, на `onMounted` зовёт `useB24().init()` (вне фрейма — no-op), внутри портала ставит
  заголовок и `fitWindow` (best-effort, в try/catch — сбой не блокирует страницу).
- `app/pages/settings.vue` — in-portal настройки (ключ, выбор чата, правила фильтра чата) + живой
  предпросмотр; форма в `<ClientOnly>`, настройки в localStorage (демо, ключ API не сохраняется),
  реальное хранение — backend. Layout `clear` + `useB24().init()`. Роут `/settings` — в `nitro.prerender.routes`.
- `app/pages/install.vue` — обработчик установки B24 (layout `clear`): `init` → `installFinish`
  (+ диагностика портала); вне фрейма — редирект на `/`. `placement.bind` **пока не делаем** —
  плейсменты добиваем на тестовом портале (см. план).
- `app/layouts/clear.vue` — минимальный layout под in-portal-страницы (`<B24App>` для тем/тостов в iframe).
- `app/config/b24.ts` — чистые константы встройки: `B24_REQUIRED_SCOPES` (`crm`, `im`, `user_brief`, `placement`).
- `app/composables/useB24.ts` — обёртка над `B24Frame`: `init()` (идемпотентен; no-op вне фрейма —
  когда нет `window.name`), `isInit()`, `get()`/`getOrThrow()`, `targetOrigin()`, `getRequiredRights()`.
- `app/composables/useChatRules.ts` — реактивные настройки (localStorage, без `apiKey`); производит
  `rules: ChatNotifyRules` (из `app/utils/statement.ts`).
- `app/config/chat.ts` — заглушка списка чатов (`MOCK_CHATS`) до подключения B24 SDK.
- `app/utils/landing.ts` — чистая логика лендинга (`LANDING_*`, `copyrightYears`), покрыта тестами.
- **Доменное ядро (чистое, переносимо в backend, покрыто тестами):**
  - `app/types/statement.ts` — модель выписки (`Statement`/`StatementItem`/`StatementParty`,
    `OperationDirection`, `BankProviderId`).
  - `app/config/banks.ts` — абстракция `BankProvider` + реестр банков (Альфа/Приор/ручной импорт).
  - `app/utils/statement.ts` — классификация приход/расход, дедуп (`account|docId`), фильтр чата,
    `parseRuleLines` (textarea → массив правил).
  - `app/utils/activity.ts` — билдер **универсального дела** (`crm.activity.todo.add`) + origin-маркер для дедупа.
  - `app/utils/alfaOauth.ts` — OAuth 2.0 Альфы (Authorization Code + refresh): URL/тела запросов, парсинг.
  - `app/utils/alfaStatement.ts` — нормализация выписки Альфы (`partner.accounts 1.2.0`) в `StatementItem`.
  - `app/utils/clientBankText.ts` — парсер текстовой выписки client-bank (CP1251, `***** ^Type=`)
    для провайдеров `prior-by`/`manual`. ⚠️ Портированный пример, рефакторинг — issue #19.
  - `app/utils/mockStatement.ts` — демо-данные для UI до реальной интеграции.

  Ссылки на доку Альфы — [`docs/ALFA_API.md`](docs/ALFA_API.md); по Приорбанку/текстовой выписке —
  [`docs/PRIOR_API.md`](docs/PRIOR_API.md).
- **Скрипты разведки (dev, не часть SSG):**
  - `scripts/alfa-oauth-test.mjs` (`pnpm oauth:test`) — живой прогон OAuth/выписки Альфы по
    `.env.sandbox` (sandbox), маскировка секретов; см. `docs/ALFA_API.md`.
  - `scripts/parse-statement.ts` (`pnpm parse:statement <файл>`) — разбор текстовой выписки
    через канонический `clientBankText.ts` (Node ≥ 22, нативный TS-стриппинг).
  - `scripts/lib/*.mjs` — переиспользуемые чистые помощники скриптов (`demo-utils`, `env`), покрыты тестами.
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

## Деплой

Фронтенд (лендинг + B24-iframe-UI) деплоится как статика за nginx — по той же схеме, что
`currency-converter`: **GHCR + Watchtower за общим nginx-proxy**. Подробности — [`docs/DEPLOY.md`](docs/DEPLOY.md).

- Прод-образ — `nginxinc/nginx-unprivileged` (non-root, слушает `:8080`), статика из `nuxt generate`.
- CSP отдаётся **без** `script-src 'unsafe-inline'`: два inline-скрипта Nuxt (`theme-init` в `app.vue`
  и `window.__NUXT__.config` с меняющимся `buildId`) разрешаются по sha256-хэшам, которые
  `scripts/csp-hashes.mjs` считает из собранного HTML и подставляет в `nginx.conf` (плейсхолдер
  `__CSP_SCRIPT_HASHES__`) на этапе сборки. `frame-ancestors`/`connect-src` разрешают облачные
  домены Б24 (iframe-встройка `/app`,`/settings`) и backend (`bank-import.bx-shef.by`).
- `docker-compose.yml` — локальная сборка; `docker-compose.prod.yml` — прод (GHCR-образ + Watchtower
  за nginx-proxy). Общий reverse-proxy (`nginx-proxy` + `acme-companion`, сеть `proxy-net`) ставится
  на сервере один раз — см. `currency-converter/docker-compose.nginxproxy.yml`, не дублируем здесь.
- **Backend** (OAuth Альфы, опрос, запись дел/чата) — отдельный сервис за тем же nginx-proxy; пока
  не реализован (этапы 3–6 плана).

## Отчётность (reporting-kit)

Вендорный бандл для работы с AI-агентом и отчётов в Telegram — в
[`reporting-kit/`](reporting-kit/) (карточка интеграции —
[`docs/REPORTING_KIT.md`](docs/REPORTING_KIT.md)). Держим как есть для синхронизации
с источником; у него **свои конвенции и свой CI**, поэтому он **не линтуется**
нашими проверками: исключён из ESLint и `tests/mdReviewStamp.test.ts`, добавлен в
`.dockerignore` (чтобы не попадал в Docker-образ). Навыки `/report-status`,
`/report-digest`, `/report-questions` и `tg-send.sh` — внутри бандла. Telegram
пока не заведён (нужен `.env` с токеном, локально, см. README кита).

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
