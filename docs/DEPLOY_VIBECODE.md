# Деплой в Битрикс24 Вайбкод Black Hole (альтернативный таргет)

> Last reviewed: 2026-07-18

Как выгрузить это приложение в **Битрикс24 Vibecode Black Hole** — закрытый Bitrix-Cloud VM,
управляемый по REST (без SSH), приложение слушает `:3000` и отдаётся по HTTPS
`https://app-{id}.vibecode.bitrix24.tech`.

> Это **альтернативный** таргет деплоя. Основной путь остаётся GHCR + Watchtower за общим
> nginx-proxy ([`DEPLOY.md`](DEPLOY.md)). Артефакты Black Hole (`deploy/vibecode-deploy.sh`,
> `.github/workflows/deploy-vibecode.yml`) **не мешают** основному: workflow **opt-in** (см. ниже).

## Что такое Black Hole (кратко)

- Одна чистая **Ubuntu VM** (root, исходящий интернет открыт, входящий — только через
  туннель платформы с авторизацией Битрикс24). Публичного IP/портов нет.
- **Нет managed-БД** — Postgres/Redis поднимаются на той же VM в `preStart`.
- Управление/деплой — **по REST** (`POST /v1/infra/servers/:id/deploy`), без SSH.
- **Бэкапы** — снимок диска (код+БД+файлы) в клик/по расписанию, переживает удаление сервера.
- **Авто-сон**: сервер засыпает после часа простоя (настраивается), первый запрос будит за 30–60 с.
- **Лимиты**: 3 сервера на API-ключ, 10 деплоев/мин на сервер. Обходятся **Галактиками** (много
  приложений на одном сервере) — но только для stateless-профиля (в контейнер Галактики свой
  Postgres не поставить).
- **Биллинг**: вайбы (1 вайб = 1 ₽), RU-контур; хостинг-аккаунт — коммерческий облачный ru-Битрикс24
  с подпиской BitrixGPT + Маркетплейс. Есть demo RU/BY (14 дней, 1 сервер/портал, только `bc-micro`).
- **Обслуживаемый портал** (куда ставится само приложение) — **любой**: приложение ходит в него
  своим B24-OAuth, не через Gateway Вайбкода.

## Выполнимость для нас — ПОДТВЕРЖДЕНА (важное)

Наш стек — stateful (Postgres + Redis + BullMQ) и в проде многоролевой (SSG-лендинг за nginx +
Nitro-backend отдельно). В Black Hole это схлопывается в **один Nitro-процесс на :3000**.

**Проверено локально** (`pnpm build` → `node .output/server/index.mjs`): один процесс отдаёт
**и лендинг, и in-portal страницы, и `/api/*`**:
- `GET /` → 200 (пререндеренный лендинг, ~75 КБ);
- `GET /api/health` → `{"status":"ok",…}`;
- `GET /import` → 200 (пререндеренная in-portal страница).

Это работает, потому что `nuxt build` (node-server preset) + `nitro.prerender.routes` +
`crawlLinks` пекут лендинг/страницы в `.output/public` и обслуживают их **тем же** node-сервером,
что и серверные роуты. Отдельный `nuxt generate` для Black Hole не нужен. Одна роль (дефолт
single-container: `QUEUE_WORKERS=1`+`QUEUE_CRON=1`) — один процесс делает всё; миграции идут
в процессе на старте (`server/plugins/migrate.ts`), отдельного шага нет.

### ⚠ Что теряется без nginx — гейты перед боевым использованием (честно)

В основном деплое nginx даёт защиту и совместимость, которых в Black Hole нет (Nitro отдаёт всё сам).
Это **гейты перед тем, как делать Black Hole основным** таргетом (не «nice-to-have»):

1. **Служебная зона — закрывается только паролем оператора** (см. 🔴 выше): в Black Hole под PUBLIC
   единственная защита `/queues`,`/api/ops/*`,`/app`,`/settings` — `PUBLIC_PAGE_BASIC_AUTH_PASS`. Задать
   обязательно.
2. **POST на пререндеренные страницы может отдавать 405.** nginx специально ремапит `405→200 $uri`,
   потому что **Bitrix открывает in-portal страницы и `/install` POST-запросом**, а статический хендлер
   Nitro отвечает на GET/HEAD. Наш смоук проверял только GET (`/`,`/import`,`/api/health`) — **POST
   B24-iframe/`/install` надо прогнать вживую** на первом деплое; если 405 — понадобится Nitro-мидлвар,
   который на POST к пререндеренному роуту отдаёт его же HTML.
3. **CSP** — hash-based CSP (без `unsafe-inline`) и form-scoped CSP для `public/b24-form.html` ставит
   nginx; в Nitro их нет. Перенести в `routeRules`/мидлвар.
4. **Security-заголовки** — `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS —
   тоже от nginx; в Nitro не выставляются.
5. **Rate-limit** `/api/auth/login` (антибрутфорс общего пароля оператора) — был `limit_req` в nginx +
   `real_ip` из `X-Forwarded-For`; в приложении лимита нет. Под PUBLIC один общий пароль без троттла —
   реальная экспозиция; нужен Nitro-мидлвар или платформенный лимит.

Функционально приложение поднимается (лендинг + `/api` из одного процесса — проверено), но пункты
1–2 — **обязательны** перед боевым PUBLIC, а 3–5 — до перевода Black Hole в основной таргет.

## Артефакты в репозитории

- **`deploy/vibecode-deploy.sh`** — идемпотентный деплой: находит сервер по `APP_NAME`, создаёт
  если нет, ждёт `running`+`CONNECTED`, ставит `accessPolicy=PUBLIC`, деплоит (install → preStart →
  start на :3000). Тянет код из публичного `codeload`-архива (репо публичный → токен не нужен).
- **`.github/workflows/deploy-vibecode.yml`** — редеплой на push в `main` / вручную. **OPT-IN**:
  джоба идёт только когда repo-переменная `VIBECODE_DEPLOY == 'true'` — до этого мерж workflow
  **не** запускает деплой и **не** красит CI.

## Разовая настройка репозитория

Settings → Secrets and variables → Actions:

| Тип | Имя | Значение |
|---|---|---|
| Secret | `VIBE_KEY` | `vibe_api_...` (личный ключ, владеет сервером + биллингом) |
| Secret | `APP_ENV_JSON` | JSON рантайм-env (ниже) |
| Variable | `APP_NAME` | `client-bank-alfa-by` (имя сервера) |
| Variable | `PRESTART_CMD` | строка провижна pg+redis (ниже) |
| Variable | `VIBECODE_DEPLOY` | `true` — включатель workflow (opt-in) |

### `PRESTART_CMD` (провижн БД, идемпотентно)

```bash
apt-get update && apt-get install -y --no-install-recommends postgresql redis-server && \
service postgresql start && service redis-server start && \
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='app'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER app PASSWORD 'app'; CREATE DATABASE app OWNER app;"
```

### `APP_ENV_JSON` (рантайм-env; секрет)

```json
{
  "DATABASE_URL": "postgres://app:app@127.0.0.1:5432/app",
  "REDIS_URL": "redis://127.0.0.1:6379",
  "B24_CLIENT_ID": "...",
  "B24_CLIENT_SECRET": "...",
  "B24_TOKEN_ENC_KEY": "<openssl rand -hex 32>",
  "SESSION_SECRET": "<openssl rand -hex 32>",
  "PUBLIC_PAGE_BASIC_AUTH_PASS": "<пароль оператора — ОБЯЗАТЕЛЬНО под PUBLIC>",
  "NUXT_PUBLIC_SITE_URL": "https://app-XXXX.vibecode.bitrix24.tech",
  "B24_APPLICATION_TOKEN": ""
}
```

> 🔴 **`PUBLIC_PAGE_BASIC_AUTH_PASS` под PUBLIC — ОБЯЗАТЕЛЕН.** Без него `operatorAllowed()`
> считает служебную зону **открытой** (пароль пуст ⇒ вход выключен ⇒ зона распахнута), и под
> публичным сервером `/queues`, `/api/ops/*`, `/app`, `/settings` доступны **кому угодно** по `appUrl`.
> В основном nginx-деплое это прикрывал ещё и `deny`/сеть; в Black Hole nginx нет — единственная
> защита служебной зоны — этот пароль (+ `SESSION_SECRET` для подписи cookie). Диагностические
> `/api/queues` и `/api/b24/app-option-check` **fail-closed** app-гардом (`B24_APPLICATION_TOKEN`
> пуст ⇒ 403), их PUBLIC не открывает — а вот операторскую зону открывает.

`B24_APPLICATION_TOKEN` — **пустой**: он приходит в `ONAPPINSTALL` и пишется в **БД** (per-portal,
write-once) — `process.env` остаётся пустым, это нормально (подпись событий проверяется по
сохранённому в БД токену). `NUXT_PUBLIC_SITE_URL` подставь после первого деплоя (когда узнаешь
`appUrl`) и передеплой — из него строится абсолютный URL хендлера событий `/api/b24/events`
(иначе `/install` откажется биндить).

## Первый деплой (проверить вручную)

API-вызовы против живого аккаунта здесь не прогонялись — **первый деплой делаем руками** (по докам
платформы `vibecode.bitrix24.tech/llms-full.txt`). Кратко:

```bash
export VIBE_KEY="vibe_api_..."           # не коммитить
export BASE="https://vibecode.bitrix24.tech/v1"
alias vibe='curl -fsS -H "X-Api-Key: $VIBE_KEY"'

# 1. Доступ/зона (см. коды гейта ниже)
vibe "$BASE/me" | python3 -m json.tool | grep -iA3 servers
# 2. Дальше проще всего — скрипт (он делает create → wait → access-policy → deploy идемпотентно):
VIBE_KEY="$VIBE_KEY" APP_NAME=client-bank-alfa-by \
  SOURCE_URL="https://codeload.github.com/bx-shef/client-bank-alfa-by/tar.gz/$(git rev-parse HEAD)" \
  ENV_JSON="$(cat app-env.json)" PRESTART_CMD="$(cat prestart.sh)" \
  bash deploy/vibecode-deploy.sh
```

В первые 20 минут смотри: `GET /:id/logs` (старт Nitro/падения), открой `appUrl` → лендинг,
`appUrl/api/health` → `ok`, `appUrl/api/ready` → проверка pg/redis. Сделай снимок диска
(`POST /:id/backups`).

### Коды гейта зоны (`POST /infra/servers` вернул ошибку)

| Код | Значит |
|---|---|
| `MARKETPLACE_REQUIRED` (402) | нет подписки BitrixGPT + Маркетплейс |
| `COMMERCIAL_PLAN_REQUIRED` (402) | бесплатный тариф без подписки |
| `TRIAL_PORTAL_LIMIT` (402) | demo RU/BY: 1 сервер на портал |
| `PLAN_NOT_ALLOWED_ON_TRIAL` (402) | на demo разрешён только `bc-micro` |
| `REGION_NOT_SUPPORTED` (403) | подписка недоступна в регионе портала |

## Уровень доступа = «Публичный» (обязательно)

`PATCH /v1/infra/servers/:id/access-policy` → `{"accessPolicy":"PUBLIC"}` (скрипт делает сам).
Нашему приложению нужен **Публичный**: оно принимает вебхук `POST /api/b24/events` (Bitrix стучится
извне) и открывается iframe'ом из чужого портала; первые 5 уровней проверяют личность через Gateway
Вайбкода (`X-Vibe-*`), которого мы не используем, — с ними вебхук/iframe срежутся.

⚠ «Публичный» открывает **сетевой доступ ко всем HTTP-эндпоинтам**. Собственную авторизацию
приложение делает внутри, **но только если она включена**: служебную зону закрывает
`PUBLIC_PAGE_BASIC_AUTH_PASS` (пустой ⇒ зона распахнута, см. 🔴 выше), CRM-данные — фрейм-токен/
OAuth. То есть «PUBLIC = только сеть, не данные» **верно лишь при заданном пароле оператора** и
работающих внутренних гардах — иначе `/queues`/`/api/ops/*`/`/app`/`/settings` открыты. Задай пароль.

## Связка с обслуживаемым порталом

Задеплоил → получил `appUrl` → в B24-приложении (в обслуживаемом портале) прописал обработчик и
redirect на `appUrl`, вебхук на `appUrl/api/b24/events` → переустановил приложение в портале
(прилетит `ONAPPINSTALL` с `application_token`).

## Когда это уместно (и когда нет)

- **Уместно**: клиент на облачном ru-Битрикс24 с подпиской, нужен in-portal сервис с **нулём
  администрирования** (нет SSH/обновлений ОС, HTTPS/встраивание/бэкапы из коробки, офбординг ключа).
- **Компромисс для нас**: stateful (pg+redis) → выделенный Black Hole VM (БД ставим сами, плотности
  Галактик нет); active.by-класс VPS дешевле и без вайб-биллинга; оплата — ₽ через РФ-контур, не BYN.
- Полноценный паритет с nginx-деплоем (CSP/rate-limit) — follow-up (см. выше).

## Compose-режим (запасной)

VM — обычная Ubuntu; можно поставить Docker и поднять наш `docker-compose.prod.yml` (app+backend+db+
redis), туннель навести на фронт-контейнер :3000. Это «Black Hole как VPS» — сохраняет текущую сборку,
но теряет смысл дыры. Делать только если единый Nitro почему-то не подходит (у нас — подходит, см. выше).

## Источники

- Платформа: `https://vibecode.bitrix24.tech/llms-full.txt`, `/pricing`, `/blackhole`, `/blackhole/galaxy`.
- Гайд Битрикс24 (16.07.2026): `https://www.bitrix24.ru/journal/vaybkod-bitrix24-gayd-novichkov/`.
