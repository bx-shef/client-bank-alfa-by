# client-bank-alfa-by

> Last reviewed: 2026-07-17

Приложение Bitrix24 для импорта выписки из клиент-банка: онлайн из Альфа-Банка
Беларусь (портал может быть в любой стране) или ручной загрузкой любой стандартной
выписки. Nuxt 4 (SSG); публичная страница — лендинг.

> **Статус:** рефакторинг legacy-приложения (план — [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md);
> срез состояния — [`docs/project-map.md`](docs/project-map.md)).
> **frontend**: публичный лендинг (SSG) + B24-iframe-UI (просмотр выписки на демо-данных, настройки —
> через backend `app.option`) +
> доменное ядро (типы/утилиты/нормализаторы всех провайдеров/билдер дел, покрыто тестами). **backend**
> (Nitro, слайс): приём событий портала Б24 (`/api/b24/events`, install/uninstall), хранилище токенов
> портала (Postgres, refresh шифруется), настройка через `app.option`, health-эндпоинт `/api/health`.
> Сборка/деплой готовы для обоих (Docker + GHCR + Watchtower, см. [`docs/DEPLOY.md`](docs/DEPLOY.md)).
> На backend уже есть: очереди (BullMQ+Redis), поиск компании и **запись операции настраиваемым делом**
> в CRM (`crm.activity.configurable.add`, дедуп по маркеру, подтверждено вживую), разнесение оплат (#109)
> и настройки чата (`app.option`). Дальше — **онлайн-опрос** Альфы/Приора (транспорт пока заглушка),
> живые чат-уведомления в бою и MCP.

## Требования

- **Node.js 22 LTS**
- **pnpm** (через corepack; версия закреплена в `packageManager` в `package.json`)

## Команды

```bash
corepack enable      # активирует pnpm нужной версии
pnpm install         # установка зависимостей
pnpm dev             # дев-сервер
pnpm lint            # ESLint
pnpm typecheck       # vue-tsc: app (.nuxt/tsconfig.json) + server (.nuxt/tsconfig.server.json)
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
