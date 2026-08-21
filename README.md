# client-bank-alfa-by

> Last reviewed: 2026-08-21

Приложение Bitrix24 для импорта выписки из клиент-банка: онлайн из Альфа-Банка
Беларусь (портал может быть в любой стране) или ручной загрузкой любой стандартной
выписки. Nuxt 4 (SSG); публичная страница — лендинг.

> **Статус:** приложение работает: ручная загрузка выписки и запись операций в CRM, разнесение
> оплат, уведомления в чат, онлайн-подключение банков (Альфа подтверждена вживую, Приор — sandbox).
> Актуальный срез — [`docs/project-map.md`](docs/project-map.md), что осталось —
> [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md), эксплуатация — [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Что это

Выписка из банка попадает в Bitrix24 сама. Приложение забирает операции — онлайн по OAuth из
Альфа-Банка Беларусь и Приорбанка либо из файла выписки, который бухгалтер загружает руками, —
находит компанию-плательщика по расчётному счёту, пишет операцию делом в её карточку CRM,
разносит оплату на счёт/сделку/заказ и сообщает о ней в чат портала.

Кому: бухгалтеру (видит платежи в CRM, а не в клиент-банке), администратору портала (настраивает),
интегратору (ставит клиентам).

```
Банк (OAuth/файл) ──▶ backend: Nitro + Postgres + Redis (очереди) ──▶ Bitrix24 (REST)
                          ▲                                              │
                          └──────── iframe-UI приложения ◀───────────────┘
```

## Быстрый старт

**Только фронт** (лендинг, страницы приложения, компоненты) — backend не нужен:

```bash
corepack enable && pnpm install
pnpm dev            # http://localhost:3000
```

Страницы приложения (`/app`, `/import`, `/install`) вне портала Bitrix24 закрыты заглушкой —
открывайте их с `?preview=1`, это штатный обход для разработки и скриншотов.

**Фронт + backend** (очереди, БД, API):

```bash
cp .env.example .env

# 1. Дописать в .env три строки. Postgres и Redis поднимаются локально, поэтому адреса —
#    localhost; ключ шифрования обязателен, без него не стартует даже compose:
cat >> .env <<'ENV'
DATABASE_URL=postgres://app:app@localhost:5432/app
REDIS_URL=redis://localhost:6379
ENV
echo "B24_TOKEN_ENC_KEY=$(openssl rand -hex 32)" >> .env

# 2. Поднять зависимости (порты открыты только на 127.0.0.1) и запустить дев-сервер:
docker compose up -d db redis
pnpm dev
```

Проверка: `curl localhost:3000/api/ready` → `{"ready":true,"status":"ok","checks":{"db":true,"redis":true}}`
(`status:"degraded"` = жив Postgres, но не Redis; `"down"` = нет Postgres).

**Что потрогать дальше** — маршрут чтения кода, разбор реального файла выписки без портала и словарь
доменных терминов: [`docs/ONBOARDING.md`](docs/ONBOARDING.md).

## Документация

| Документ | О чём |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | карта модулей и конвенции (основной справочник) |
| [`docs/ONBOARDING.md`](docs/ONBOARDING.md) | маршрут чтения кода + словарь терминов |
| [`docs/README.md`](docs/README.md) | индекс всех документов |
| [`docs/PROCESSING.md`](docs/PROCESSING.md) | целевая логика обработки платежей |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) · [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | деплой и эксплуатация |
| [`docs/PRIVACY.md`](docs/PRIVACY.md) | что храним и как чистим |

## Требования

- **Node.js 22 LTS**
- **pnpm** (через corepack; версия закреплена в `packageManager` в `package.json`)
- **Docker** — для локальных Postgres и Redis (нужен только при работе с backend)
- **Chromium** — для `pnpm screenshot` (в этом окружении предустановлен)

## Команды

```bash
corepack enable      # активирует pnpm нужной версии
pnpm install         # установка зависимостей
pnpm dev             # дев-сервер
pnpm lint            # ESLint
pnpm typecheck       # vue-tsc ×4: app + server + node (tests, скрипты, vitest.config — tsconfig.node.json)
                     #            + визуальные тесты и playwright.config (tsconfig.visual.json)
pnpm test            # Vitest (unit + nuxt)
pnpm check           # lint + typecheck + test одной командой (это же гоняет CI)
pnpm generate        # сборка статики (SSG) → .output/public
```

## Разработка

- **В `main` не пушим — только через Pull Request с зелёным CI.** Настройка защиты `main`
  (ruleset `protect-main`) — в [`docs/REPO_SETUP_CHECKLIST.md`](docs/REPO_SETUP_CHECKLIST.md).
- Перед пушем прогоняй `pnpm check` (или `bash scripts/check-app.sh`) — это же гоняет CI.
- Инструкции для AI-агентов и детали архитектуры — в [`CLAUDE.md`](./CLAUDE.md).

## Деплой

Статика собирается в Docker-образ (`nginxinc/nginx-unprivileged`) и публикуется в GHCR; на сервере
её подхватывает Watchtower за общим nginx-proxy (TLS — Let's Encrypt). Конвейер CI/CD и шаги на
сервере — в [`docs/DEPLOY.md`](docs/DEPLOY.md). Локальная проверка образа: `docker compose up --build`.

## Лицензия

[MIT](./LICENSE)
