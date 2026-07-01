# Деплой (фронтенд-лендинг + backend B24)

> Last reviewed: 2026-06-30

Фронтенд — статика (`nuxt generate`), раздаётся nginx. Схема та же, что у соседнего
`currency-converter`: **GHCR + Watchtower за общим nginx-proxy** (TLS — Let's Encrypt).

Backend (приём событий Б24 + хранилище токенов; дальше — OAuth Альфы, опрос, дела/чат) —
**отдельный docker-сервис** того же репозитория (`Dockerfile` target `backend`, `nuxt build`)
за тем же proxy, рядом — Postgres. Контракт и env — [`B24_EVENTS.md`](B24_EVENTS.md).

## Backend + база (docker-compose)

`docker compose up` (локально) поднимает три сервиса: `app` (статика лендинга, nginx, `:8081`),
`backend` (node-сервер, эндпоинт `/api/b24/events`, `:3210→3000`) и `db` (Postgres, том `pgdata`).
Перед стартом — `.env` (шаблон `.env.example`): `B24_TOKEN_ENC_KEY` (обязателен, `openssl rand -hex 32`),
`B24_APPLICATION_TOKEN` (обязателен в проде), `POSTGRES_PASSWORD`. Схема `portal_tokens` создаётся
на старте backend (`server/plugins/migrate.ts`).

**Один домен, две роли (прод).** `docker-compose.prod.yml` поднимает те же `app` + `backend` + `db`.
Наружу (за nginx-proxy) смотрит только `app`: nginx отдаёт статику лендинга/UI, а `location /api/`
проксирует в `backend:3000` по внутренней docker-сети `internal`. Поэтому **одного домена достаточно**:
`https://<DOMAIN>/` — лендинг/UI, `https://<DOMAIN>/api/b24/events` — обработчик событий Б24
(без CORS, тот же origin). `backend` и `db` host-портов не публикуют. Образы — два в GHCR
(`…/client-bank-alfa-by` — nginx-статика, `…/client-bank-alfa-by-backend` — node), оба обновляет Watchtower.

## Конвейер CI/CD (`.github/workflows/ci.yml`)

| Триггер | Что бежит |
|---|---|
| Pull request → `main` | `ci` (lint → test → typecheck → generate) + `docker-build` (matrix `runner`+`backend`, сборка обоих образов, **без** push) |
| Push в `main` | `ci` → `deploy` (matrix: push `runner`→`…/client-bank-alfa-by` и `backend`→`…/client-bank-alfa-by-backend`) |

- `deploy` гейтится по зелёному `ci` (`needs: ci`) — красный CI не пускает образы в GHCR.
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
3. **GHCR-пакеты должны быть публичными** — **оба**: `ghcr.io/bx-shef/client-bank-alfa-by` (лендинг)
   и `ghcr.io/bx-shef/client-bank-alfa-by-backend` (node). Тогда ни серверу, ни Watchtower не нужен
   `docker login`. Если приватные — перед `up -d` сделать `docker login ghcr.io` (PAT с
   `read:packages`) и настроить креды Watchtower (см. «Если репозиторий приватный»).

### Развёртывание (минимальный набор)

На сервере в рантайме нужны только **два файла из репо + `.env`** (исходник и `.git` не нужны —
образ самодостаточный в GHCR). Репозиторий публичный, поэтому тянем файлы напрямую:

```bash
mkdir -p /home/bitrix/bank-import && cd /home/bitrix/bank-import

# 1. два файла из репо
curl -fsSL -O https://raw.githubusercontent.com/bx-shef/client-bank-alfa-by/main/docker-compose.prod.yml
curl -fsSL -O https://raw.githubusercontent.com/bx-shef/client-bank-alfa-by/main/Makefile

# 2. .env (DNS A-запись DOMAIN должна указывать на сервер ДО подъёма — иначе acme не выпустит TLS)
cat > .env <<'EOF'
DOMAIN=bank-import.bx-shef.by
LETSENCRYPT_EMAIL=you@example.com
# backend + Postgres (обязательны в проде):
POSTGRES_PASSWORD=<openssl rand -hex 24>   # URL-safe: без @ : / ? # (уходит в DSN как есть)
B24_TOKEN_ENC_KEY=<openssl rand -hex 32>
B24_APPLICATION_TOKEN=<application_token приложения из B24>
EOF

# 3. поднять app + backend + db (образы из GHCR; обновления подхватит хостовый Watchtower)
make prod-up
```

После подъёма адрес обработчика событий приложения в B24 — `https://<DOMAIN>/api/b24/events`
(тот же домен, проксируется nginx в backend). Итого в папке — только `docker-compose.prod.yml`,
`Makefile`, `.env`. Обновить эти два файла
позже — повторить `curl` из шага 1 (в минимальном варианте `git pull` недоступен; образ обновляется
через Watchtower независимо от папки).

Обёртки `Makefile`: `make prod-up` / `make prod-pull` / `make prod-redeploy` (обновить образ сейчас,
без ожидания Watchtower) / `make logs` / `make ps`.

> Альтернатива: `git clone` репозитория в папку — тогда обновление `compose`/`Makefile` одним
> `git pull`, ценой лишних файлов (~400 КБ). На рантайм не влияет.

Локальная проверка образа (в клоне репо): `make build-local` = `docker compose up --build` —
раздаёт на `:8081` (порт уведён с `:80`, чтобы не конфликтовать с локальным `currency-converter`).

## Если nginx-proxy / Watchtower ещё не стоят

Реверс-прокси и Watchtower — общая инфраструктура хоста, ставится **один раз** (обычно вместе с
`currency-converter`). Сначала проверь, что уже есть:

```bash
docker network ls | grep proxy-net
docker ps --format '{{.Names}}\t{{.Image}}' | grep -E 'nginx-proxy|acme-companion|watchtower'
```

**Нет сети `proxy-net`:**
```bash
docker network create proxy-net
```

**Нет nginx-proxy + acme-companion** (TLS Let's Encrypt). Канонический compose —
`currency-converter/docker-compose.nginxproxy.yml`. Если репозиторий `currency-converter` на сервере:
```bash
cd /path/to/currency-converter
echo "LETSENCRYPT_EMAIL=you@example.com" > .env.prod   # контакт для сертификатов
docker compose -f docker-compose.nginxproxy.yml --env-file .env.prod up -d
```
`nginx-proxy` и `acme-companion` поднимутся в сети `proxy-net` и будут обслуживать все сайты хоста
по их `VIRTUAL_HOST` (наш — `DOMAIN`).

**Нет Watchtower** (автообновление образов). Один на хост, с `--label-enable`:
```bash
docker run -d --name watchtower --restart unless-stopped \
  -e DOCKER_API_VERSION=1.47 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower:1.7.1 --interval 300 --cleanup --label-enable
```
Он обновит наш контейнер по метке `com.centurylinklabs.watchtower.enable=true`. Без Watchtower
деплой работает — обновления катятся вручную: `make prod-redeploy`.

**Прокси уже есть, но в другой docker-сети** (наш контейнер на `proxy-net`, а прокси — нет; тогда
сайт снаружи не открывается, хотя оба контейнера `Up`). Подключить прокси к нашей сети:
```bash
docker network connect proxy-net <имя-контейнера-прокси>
```
или переключить `external`-сеть в `docker-compose.prod.yml` на ту, где живёт прокси. Проверить сети:
```bash
docker inspect <имя-прокси> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

## Если репозиторий приватный

При приватном репо анонимный `curl` к `raw.githubusercontent.com` и `docker pull` без логина не
сработают — нужен GitHub PAT (`read:packages` для образа; для файлов — также `repo`/`contents:read`).

**1. Файлы `compose`/`Makefile`** — `git clone` с токеном или копия вручную:
```bash
git clone https://<PAT>@github.com/bx-shef/client-bank-alfa-by.git /home/bitrix/bank-import
# или со своей машины: scp docker-compose.prod.yml Makefile bitrix@<SERVER>:/home/bitrix/bank-import/
```

**2. Логин в GHCR на сервере** (чтобы тянуть образ):
```bash
echo <PAT> | docker login ghcr.io -u <github-user> --password-stdin
make prod-up
```
Креды сохранятся в `/home/bitrix/.docker/config.json` (если на хосте нет credential-helper'а).

**3. Watchtower** должен уметь тянуть приватный образ — примонтируй ему этот docker-config
(перезапусти контейнер с доп. volume):
```bash
docker rm -f watchtower
docker run -d --name watchtower --restart unless-stopped \
  -e DOCKER_API_VERSION=1.47 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /home/bitrix/.docker/config.json:/config.json:ro \
  containrrr/watchtower:1.7.1 --interval 300 --cleanup --label-enable
```

> **Проще — сделать GHCR-пакет публичным**, оставив сам репозиторий приватным: видимость пакета
> настраивается отдельно (`github.com/orgs/bx-shef/packages` → пакет → Package settings → Change
> visibility → Public). Тогда ни логин, ни монтирование кредов не нужны — приватным остаётся только
> исходный код, а тянуть образ можно анонимно.

## Build-args (необязательные)

| Arg / env | Назначение |
|---|---|
| `NUXT_PUBLIC_AUTHOR_NAME` / `NUXT_PUBLIC_AUTHOR_URL` | автор в подвале лендинга (иначе дефолт из `nuxt.config.ts`) |
| `DOMAIN` | домен прод-образа (`VIRTUAL_HOST`/`LETSENCRYPT_HOST` для nginx-proxy) |
| `LETSENCRYPT_EMAIL` | контакт для TLS-сертификата (acme-companion); необязателен |

В CI автор берётся из `vars.NUXT_PUBLIC_AUTHOR_*` (repo variables), не из секретов — это не секреты.
