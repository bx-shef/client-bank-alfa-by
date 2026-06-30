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
EOF

# 3. поднять (образ тянется из GHCR; обновления подхватит хостовый Watchtower)
make prod-up
```

Итого в папке — только `docker-compose.prod.yml`, `Makefile`, `.env`. Обновить эти два файла
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

## Build-args (необязательные)

| Arg / env | Назначение |
|---|---|
| `NUXT_PUBLIC_AUTHOR_NAME` / `NUXT_PUBLIC_AUTHOR_URL` | автор в подвале лендинга (иначе дефолт из `nuxt.config.ts`) |
| `DOMAIN` | домен прод-образа (`VIRTUAL_HOST`/`LETSENCRYPT_HOST` для nginx-proxy) |
| `LETSENCRYPT_EMAIL` | контакт для TLS-сертификата (acme-companion); необязателен |

В CI автор берётся из `vars.NUXT_PUBLIC_AUTHOR_*` (repo variables), не из секретов — это не секреты.
