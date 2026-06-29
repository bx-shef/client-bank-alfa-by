# CLAUDE.md

> Last reviewed: 2026-06-29

Приложение для получения выписки из клиент-банка Альфа-Банк Беларусь.
Статическое приложение (SSG), без серверной части. Публичная страница — лендинг.

> **Статус:** репозиторий на этапе инициализации. Сейчас здесь только каркас
> (Nuxt 4 + конфиги + страница-заглушка лендинга) и обвязка репо (CI, Dependabot,
> SessionStart-хук). Боевой код приложения придёт позже и заменит содержимое
> `app/`. Эталон реализации Bitrix24-приложения на этом стеке — соседний репозиторий
> `currency-converter`.

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

Перед пушем прогоняй `pnpm lint && pnpm typecheck && pnpm test` — это же гоняет CI.

## Архитектура (текущий каркас)

- `app/app.vue` — корень: `useHead`/SEO/`theme-init`, рендерит `<NuxtLayout>`/`<NuxtPage>`.
- `app/app.config.ts` — нативный colorMode b24ui (`colorMode: true`, `colorModeInitialValue: 'auto'`);
  без этих top-level ключей `useColorMode()` = no-op stub.
- `app/assets/css/main.css` — Tailwind v4 + импорт темы b24ui.
- `app/pages/index.vue` — страница-заглушка лендинга (hero + список преимуществ + подвал).
- `app/utils/landing.ts` — чистая логика лендинга (`LANDING_FEATURES`, `copyrightYears`), покрыта тестами.
- `tests/*.test.ts` — Vitest (node) на чистые утилиты.
- `tests/nuxt/**/*.test.ts` — Vitest (проект `nuxt`) на компоненты/страницы (`mountSuspended`).

Чистую логику выносим в `app/utils/*` и покрываем тестами; реактивную — в `app/composables/*`,
UI — в компонентах. Это та же раскладка, что в `currency-converter` — держим её при развитии.

## Настройка репозитория

- `В main не пушим — только через PR.` Защита `main` (ruleset `protect-main`) и CI как
  required-check настраиваются владельцем репо по [`docs/REPO_SETUP_CHECKLIST.md`](docs/REPO_SETUP_CHECKLIST.md).
- `.github/workflows/ci.yml` — job `ci` (lint → test → typecheck → generate). Имя `ci` — то,
  что включается в required status checks ruleset'а.
- `.github/dependabot.yml` — обновления `npm` и `github-actions`. Блок `docker` добавляем,
  когда появятся деплой-артефакты (Dockerfile).
- `.claude/` — SessionStart-хук (`hooks/session-start.sh`): в веб-сессиях Claude Code ставит
  зависимости и гоняет `nuxt prepare`, чтобы lint/typecheck/test/build работали с первого хода.

## Конвенции

- Комментарии и JSDoc — на английском; пользовательский текст и README — на русском.
- Чистые функции — в `app/utils/*` (данные/константы — в `app/config/*`), покрываем тестами;
  реактивную логику — в `app/composables/*`, UI — в компонентах.
- Данные из API рендерим только через `{{ }}` (auto-escape) — никакого `v-html` с внешними данными.
- Штамп ревью: каждый `.md`-документ в корне и `docs/` несёт строку `> Last reviewed: YYYY-MM-DD`
  блок-цитатой сразу под заголовком H1. Ключ `Last reviewed` всегда на английском (технический
  маркер). Дату бампим только при содержательном изменении.
