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
- `app/pages/index.vue` — публичная страница лендинга (hero + преимущества + подвал).
- `app/pages/app.vue` — in-portal просмотр выписки (приходы/расходы); пока на mock-данных.
- `app/pages/settings.vue` — in-portal настройки (ключ, выбор чата, правила фильтра чата) + живой
  предпросмотр; форма в `<ClientOnly>`, настройки в localStorage (демо, ключ API не сохраняется),
  реальное хранение — backend. Роут `/settings` добавлен в `nitro.prerender.routes` (`nuxt.config.ts`).
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
  - `app/utils/mockStatement.ts` — демо-данные для UI до реальной интеграции.

  Ссылки на доку Альфы и используемые методы/параметры — [`docs/ALFA_API.md`](docs/ALFA_API.md).
- `tests/*.test.ts` — Vitest (node) на чистые утилиты.
- `tests/nuxt/**/*.test.ts` — Vitest (проект `nuxt`) на компоненты/страницы (`mountSuspended`).

Чистую логику выносим в `app/utils/*` и покрываем тестами; реактивную — в `app/composables/*`,
UI — в компонентах. Это та же раскладка, что в `currency-converter` — держим её при развитии.

## Настройка репозитория

- **В main не пушим — только через PR.** Защита `main` (ruleset `protect-main`) и CI как
  required-check настраиваются владельцем репо по [`docs/REPO_SETUP_CHECKLIST.md`](docs/REPO_SETUP_CHECKLIST.md).
- `.github/workflows/ci.yml` — job `ci` (lint → test → typecheck → generate). Имя `ci` — то,
  что включается в required status checks ruleset'а.
- `.github/dependabot.yml` — обновления `npm` и `github-actions`. Блок `docker` добавляем,
  когда появятся деплой-артефакты (Dockerfile).
- `.claude/` — SessionStart-хук (`hooks/session-start.sh`): в веб-сессиях Claude Code ставит
  зависимости и гоняет `nuxt prepare`, чтобы lint/typecheck/test/build работали с первого хода.

## Визуальная верификация (Definition of Done)

> **ВАЖНО:** после любой правки UI/CSS/вёрстки снять скриншот результата и
> посмотреть на пиксели **до** того, как считать задачу выполненной — не доверять
> «собралось без ошибок». `pnpm generate && pnpm screenshot` → смотреть
> `screenshots/` (mobile/desktop × light/dark). Детали и чек-лист —
> [`docs/VISUAL_VERIFICATION.md`](docs/VISUAL_VERIFICATION.md).

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
