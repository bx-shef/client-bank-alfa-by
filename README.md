# client-bank-alfa-by

> Last reviewed: 2026-07-01

Приложение Bitrix24 для импорта выписки из клиент-банка: онлайн из Альфа-Банка
Беларусь (портал может быть в любой стране) или ручной загрузкой любой стандартной
выписки. Nuxt 4 (SSG); публичная страница — лендинг.

> **Статус:** рефакторинг legacy-приложения (план — [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md)).
> Здесь **frontend**: публичный лендинг (SSG) + B24-iframe-UI (просмотр выписки/настройки на
> демо-данных) + доменное ядро (типы/утилиты/билдер дел, покрыто тестами). Сборка/деплой статики
> готовы (Docker + GHCR + Watchtower, см. [`docs/DEPLOY.md`](docs/DEPLOY.md)). Серверная часть
> (OAuth Альфы, опрос, запись дел/чата, MCP) — отдельный backend-сервис, пока не реализован.

## Требования

- **Node.js 22 LTS**
- **pnpm** (через corepack; версия закреплена в `packageManager` в `package.json`)

## Команды

```bash
corepack enable      # активирует pnpm нужной версии
pnpm install         # установка зависимостей
pnpm dev             # дев-сервер
pnpm lint            # ESLint
pnpm typecheck       # vue-tsc --noEmit
pnpm test            # Vitest (unit + nuxt)
pnpm generate        # сборка статики (SSG) → .output/public
```

## Разработка

- **В `main` не пушим — только через Pull Request с зелёным CI.** Настройка защиты `main`
  (ruleset `protect-main`) — в [`docs/REPO_SETUP_CHECKLIST.md`](docs/REPO_SETUP_CHECKLIST.md).
- Перед пушем прогоняй `pnpm lint && pnpm typecheck && pnpm test` — это же гоняет CI.
- Инструкции для AI-агентов и детали архитектуры — в [`CLAUDE.md`](./CLAUDE.md).

## Деплой

Статика собирается в Docker-образ (`nginxinc/nginx-unprivileged`) и публикуется в GHCR; на сервере
её подхватывает Watchtower за общим nginx-proxy (TLS — Let's Encrypt). Конвейер CI/CD и шаги на
сервере — в [`docs/DEPLOY.md`](docs/DEPLOY.md). Локальная проверка образа: `docker compose up --build`.

## Лицензия

[MIT](./LICENSE)
