# Деплой фронтенда (лендинг + B24-iframe-UI)

> Last reviewed: 2026-06-30

Фронтенд — статика (`nuxt generate`), раздаётся nginx. Схема та же, что у соседнего
`currency-converter`: **GHCR + Watchtower за общим nginx-proxy** (TLS — Let's Encrypt).
Backend (OAuth Альфы, опрос, запись дел/чата) — отдельный сервис за тем же proxy, здесь не
рассматривается (этапы 3–6 — [`REFACTOR_PLAN.md`](REFACTOR_PLAN.md)).

## Конвейер CI/CD (`.github/workflows/ci.yml`)

| Триггер | Что бежит |
|---|---|
| Pull request → `main` | `ci` (lint → test → typecheck → generate) + `docker-build` (сборка образа, **без** push) |
| Push в `main` | `ci` → `deploy` (сборка + push в `ghcr.io/bx-shef/client-bank-alfa-by`) |

- `deploy` гейтится по зелёному `ci` (`needs: ci`) — красный CI не пускает образ в GHCR.
- Push в GHCR — встроенным `GITHUB_TOKEN` (`packages: write`), без отдельного секрета.
- Watchtower на сервере опрашивает реестр (~5 мин) и подменяет контейнер на свежий `:latest`.
- Сторонние actions запинены на commit SHA (issue #2); SHA обновляет Dependabot
  (экосистема `github-actions`) по комментарию `# vX.Y.Z`.

## Образ

Multi-stage `Dockerfile`: `node:22-alpine` (сборка `pnpm generate`) → `nginxinc/nginx-unprivileged:1.31-alpine`
(раздача статики). Образ non-root, слушает `:8080`.

`scripts/csp-hashes.mjs` на этапе сборки считает sha256-хэши inline-скриптов Nuxt из собранного
HTML и подставляет в `nginx.conf` (плейсхолдер `__CSP_SCRIPT_HASHES__`) — так CSP отдаётся
**без** `script-src 'unsafe-inline'`.

## nginx (`nginx.conf`)

- `:8080`, `absolute_redirect off` (за TLS-проксей — иначе редиректы утекают `http://host:8080`
  и ловят Mixed-Content внутри HTTPS-iframe Б24).
- `error_page 405 =200 $uri` — Б24 открывает in-portal-страницы POST'ом; статик-хендлер nginx
  отдал бы `405`, поэтому переотдаём ту же пререндеренную HTML (серверной логики на запрос нет).
- CSP: `frame-ancestors`/`connect-src` разрешают облачные домены Б24 (`*.bitrix24.*`) и backend
  (`bank-import.bx-shef.by`). **Self-hosted порталы** на своём домене добавляют origin в оба списка вручную.

## Прод (на сервере)

1. Общий reverse-proxy (`nginx-proxy` + `acme-companion`, docker-сеть `proxy-net`) ставится на
   сервере **один раз** — канонический compose в `currency-converter/docker-compose.nginxproxy.yml`
   (здесь не дублируем, чтобы не плодить два инстанса proxy).
2. Положить `docker-compose.prod.yml` в `/home/bitrix/client-bank-alfa-by/`, задать `.env` с `DOMAIN`
   (см. `.env.example`).
3. `docker compose -f docker-compose.prod.yml up -d` — поднимет контейнер (GHCR-образ) и Watchtower.

Локальная проверка образа: `docker compose up --build` (раздаёт на `:80`).

## Build-args (необязательные)

| Arg / env | Назначение |
|---|---|
| `NUXT_PUBLIC_AUTHOR_NAME` / `NUXT_PUBLIC_AUTHOR_URL` | автор в подвале лендинга (иначе дефолт из `nuxt.config.ts`) |
| `DOMAIN` | домен прод-образа (`VIRTUAL_HOST`/`LETSENCRYPT_HOST` для nginx-proxy) |

В CI автор берётся из `vars.NUXT_PUBLIC_AUTHOR_*` (repo variables), не из секретов — это не секреты.
