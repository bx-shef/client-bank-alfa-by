# client-bank-alfa-by

> Last reviewed: 2026-06-29

Приложение для получения выписки из клиент-банка Альфа-Банк Беларусь.
Статическое приложение (Nuxt 4, SSG); публичная страница — лендинг.

> **Статус:** инициализация репозитория. Сейчас здесь каркас (Nuxt 4 + конфиги +
> страница-заглушка лендинга) и обвязка репозитория (CI, Dependabot, SessionStart-хук
> для Claude Code на вебе). Боевой код придёт позже и заменит содержимое `app/`.

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

## Лицензия

[MIT](./LICENSE)
