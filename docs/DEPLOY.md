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
- CSP: `frame-ancestors`/`connect-src` разрешают облачные домены Б24 (раздельные wildcard по TLD —
  `*.bitrix24.ru`, `*.bitrix24.by`, `*.bitrix24.com` и др.; CSP не поддерживает двойной `*.bitrix24.*`) и backend
  (`bank-import.bx-shef.by`). **Self-hosted порталы** на своём домене добавляют origin в оба списка вручную.

## Прод (на сервере)

На сервере уже крутится `currency-converter` по той же схеме, поэтому **общая инфраструктура
ставится один раз** и переиспользуется:

1. **Reverse-proxy** (`nginx-proxy` + `acme-companion`, docker-сеть `proxy-net`) — канонический
   compose в `currency-converter/docker-compose.nginxproxy.yml`. Здесь не дублируем.
2. **Watchtower** — один на хост (тоже из `currency-converter`, запущен с `--label-enable`). Он сам
   подхватит наш контейнер по метке `com.centurylinklabs.watchtower.enable=true`. Поэтому в нашем
   `docker-compose.prod.yml` своего `watchtower` **нет** — второй экземпляр конфликтует по
   `container_name: watchtower` и плодит двойные перезапуски.
3. **GHCR-пакет должен быть публичным** (`ghcr.io/bx-shef/client-bank-alfa-by`) — тогда ни серверу,
   ни Watchtower не нужен `docker login`. Если пакет приватный — перед `up -d` сделать
   `docker login ghcr.io` (PAT с `read:packages`) и настроить креды Watchtower.

Развёртывание:

1. Положить `docker-compose.prod.yml` в `/home/bitrix/bank-import/`, задать `.env` с `DOMAIN` и
   (опц.) `LETSENCRYPT_EMAIL` (см. `.env.example`). DNS A-запись `DOMAIN` должна указывать на сервер
   **до** подъёма, иначе acme-companion не выпустит TLS.
2. `docker compose -f docker-compose.prod.yml up -d` — поднимет только app-контейнер (GHCR-образ);
   обновления подтянет хостовый Watchtower.

Локальная проверка образа: `docker compose up --build` (раздаёт на `:8081` — порт уведён с `:80`,
чтобы не конфликтовать с локальным `currency-converter`).

## Build-args (необязательные)

| Arg / env | Назначение |
|---|---|
| `NUXT_PUBLIC_AUTHOR_NAME` / `NUXT_PUBLIC_AUTHOR_URL` | автор в подвале лендинга (иначе дефолт из `nuxt.config.ts`) |
| `DOMAIN` | домен прод-образа (`VIRTUAL_HOST`/`LETSENCRYPT_HOST` для nginx-proxy) |
| `LETSENCRYPT_EMAIL` | контакт для TLS-сертификата (acme-companion); необязателен |

В CI автор берётся из `vars.NUXT_PUBLIC_AUTHOR_*` (repo variables), не из секретов — это не секреты.
