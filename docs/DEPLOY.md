# Деплой (фронтенд-лендинг + backend B24)

> Last reviewed: 2026-08-20

Фронтенд — статика (`nuxt generate`), раздаётся nginx. Схема та же, что у соседнего
`currency-converter`: **GHCR + Watchtower за общим nginx-proxy** (TLS — Let's Encrypt).

> **Эксплуатация после запуска** (health, диагностика очередей, типовые сбои, откат, эскалация) —
> отдельный runbook [`OPERATIONS.md`](OPERATIONS.md) (#246). Здесь — только как *развернуть*.

> **Альтернативный таргет — Битрикс24 Вайбкод Black Hole** (закрытый Bitrix-Cloud VM, деплой по
> REST, приложение одним Nitro-процессом на :3000): [`DEPLOY_VIBECODE.md`](DEPLOY_VIBECODE.md).
> Артефакты (`deploy/vibecode-deploy.sh`, workflow) — **opt-in**, основной путь не трогают.

Backend (приём событий Б24 + хранилище токенов; дальше — OAuth Альфы, опрос, дела/чат) —
**отдельный docker-сервис** того же репозитория (`Dockerfile` target `backend`, `nuxt build`)
за тем же proxy, рядом — Postgres. Контракт и env — [`B24_EVENTS.md`](B24_EVENTS.md).

## Backend + база (docker-compose)

`docker compose up` (локально) поднимает сервисы: `app` (статика лендинга, nginx, `:8081`),
`backend` (node-сервер, эндпоинт `/api/b24/events`, `:3210→3000`), `db` (Postgres, том `pgdata`)
и `redis` (BullMQ-очереди, том `redisdata`). Перед стартом — `.env` (шаблон `.env.example`):
`B24_TOKEN_ENC_KEY` (обязателен, `openssl rand -hex 32`), `POSTGRES_PASSWORD`.
`B24_APPLICATION_TOKEN` — **требует осознанного решения в проде** (#242 P3): его значение —
ожидаемый `application_token`, с которым сверяется подлинность **события установки**.
- **Один портал / self-hosted (не Маркет):** **ЗАДАТЬ ОБЯЗАТЕЛЬНО.** Без него установка идёт в
  режиме TOFU (trust-on-first-install) — принимается **первый** непустой токен, то есть знающий URL
  вебхука может «установить» произвольный `member_id` (см. [`B24_EVENTS.md`](B24_EVENTS.md) §брокер).
  Заданный env-токен закрывает это окно полностью.
- **Мультитенант (Маркет, много порталов):** оставляем **пустым** — у каждого портала свой
  per-portal `application_token`, приходящий в `ONAPPINSTALL` и сохраняемый (последующие события
  сверяются с сохранённым), поэтому одно env-значение всем порталам не подойдёт. Остаточный риск —
  **только окно установки** (TOFU), его снижают атомарный write-once токена и секретность URL вебхука.
  Пустое значение здесь — **сознательный выбор**, а не «по умолчанию».
Также токен служит guard'ом серверной диагностики (`/api/queues`); при пустом
`B24_APPLICATION_TOKEN` эти эндпоинты недоступны (и без того закрыты nginx `deny all`).

⚠ Троттлинг зоны `import` вешается **отдельным exact-match блоком на каждый роут**
(`= /api/import`, `= /api/import/status`, `= /api/import/batch`, `= /api/import/metrics*`):
`= /api/import` — точное совпадение и подпути **не** покрывает, поэтому забытый роут провалился бы
в незадросселированный `location /api/`.
`REDIS_URL` compose проставляет сам (внутренний сервис `redis`). Схема
`portal_tokens` создаётся на старте backend (`server/plugins/migrate.ts`). `redis` и `db` host-портов
не публикуют и сидят на изолированных сетях (`queuenet`/`dbnet`, `internal: true`) — наружу не смотрят.

**Очереди (BullMQ), роли и масштабирование.** Роль контейнера решается env
(`QUEUE_WORKERS`/`QUEUE_CRON`, чистый `server/queue/runtime.ts`). В **проде** (`docker-compose.prod.yml`)
роли разведены: `backend` = API + крон (`QUEUE_WORKERS=0`), отдельный сервис **`worker`** тянет очереди
(`QUEUE_CRON=0`, `RUN_MIGRATION=0`) и **масштабируется** — `docker compose up -d --scale worker=N` (все
реплики на одном Redis, каждый джоб уходит ровно одному воркеру). `QUEUE_CONCURRENCY` — параллелизм внутри
воркера. **Локально** (`docker-compose.yml`) один backend делает всё (дефолт). Детали — [`QUEUES.md`](QUEUES.md) «Масштабирование».
⚠ **`QUEUE_WORKERS=0` на backend требует живого `worker`-сервиса.** Иначе события/импорты enqueue'ятся
(Redis жив), но никем не обрабатываются — **встают молча** (синхронный фолбэк ловит только *недоступный*
Redis, не отсутствие воркера). Поэтому compose поднимать **целиком** (`docker compose -f docker-compose.prod.yml up -d`),
а не править руками только env backend; после деплоя проверить сток очередей (`/queues` / `make queue-stats`).
Событийный воркер (`b24-events`) и крон — на backend (единственный инстанс, порядок install/uninstall); реплики `worker` тянут только fetch/parse/crm-sync.
`DEMO_LOAD_N>0` включает демонстрацию: крон каждые `CRON_INTERVAL_MIN` минут кладёт
столько синтетических fetch-джобов, чтобы поток шёл `bank-fetch → crm-sync`. **Смотреть поток
сейчас:** `make queue-stats` (счётчики очередей из работающего
backend; эндпоинт `/api/queues` наружу закрыт nginx, скрипт ходит внутрь контейнера). В проде после
подключения реального опроса выставить `DEMO_LOAD_N=0`. Полноценная телеметрия — **OpenTelemetry**
(#78, `docs/OBSERVABILITY.md`): app-side инструментирование сделано (DEFAULT OFF); приёмная станция (коллектор + ClickHouse + Grafana) собрана в [`telemetry-station/`](../telemetry-station/README.md) и разворачивается отдельно.

**Один домен, три роли-контейнера (прод).** `docker-compose.prod.yml` поднимает `app` + `backend` + `worker` + `db` + `redis`.
Наружу (за nginx-proxy) смотрит только `app`: nginx отдаёт статику лендинга/UI, а `location /api/`
проксирует в `backend:3000` по внутренней docker-сети `internal`. Поэтому **одного домена достаточно**:
`https://<DOMAIN>/` — лендинг/UI, `https://<DOMAIN>/api/b24/events` — обработчик событий Б24
(без CORS, тот же origin). `backend` и `db` host-портов не публикуют. Образы — **два** в GHCR
(`…/client-bank-alfa-by` — nginx-статика, `…/client-bank-alfa-by-backend` — node), оба обновляет
Watchtower.
⚠ Крипто-шлюз к проду Приорбанка мы больше НЕ собираем и НЕ публикуем: он живёт в
[bx-shef/bee2-tls-gateway](https://github.com/bx-shef/bee2-tls-gateway) и выпускает свой образ.
Сервис в нашем compose закомментирован и тянет его по ЯВНОМУ тегу, а не `latest` — TLS-терминатор
на платёжном пути не должен молча обновляться под Watchtower.

> **Требование к внешнему прокси (для rate-limit логина, #64).** `app` восстанавливает
> реальный IP клиента из `X-Forwarded-For` (`real_ip`, доверяя приватным диапазонам), и на
> этом IP строится `limit_req` для `POST /api/auth/login`. Это безопасно только если внешний
> `nginx-proxy` **дописывает** реальный peer-IP в конец `X-Forwarded-For`
> (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` — поведение по умолчанию у
> `nginxproxy/nginx-proxy`), а не пробрасывает клиентский заголовок как есть: тогда крайний
> правый (недоверенный) адрес — настоящий клиент, и подделать его нельзя. Если прокси
> настроить на проброс сырого XFF, атакующий сможет распылить брутфорс по фейковым IP и обойти
> лимит. Стандартный образ append'ит — менять эту настройку нельзя.
>
> **`X-Forwarded-Proto` (для `Secure`-cookie логина, #242 P2).** TLS терминируется на внешнем
> `nginx-proxy`, а `app` видит только plain http на :8080, поэтому `Secure`-флаг сессионной cookie
> оператора (`server/api/auth/login.post.ts` `isSecure`) выводится из `X-Forwarded-Proto`. Внутренний
> `app`-nginx **сохраняет** значение внешнего прокси (map `$forwarded_proto` в `nginx.conf`, фолбэк на
> `$scheme` при отсутствии — для локального compose без edge), а не перетирает его на `http`. Требование
> к внешнему прокси: он должен ставить `X-Forwarded-Proto https` (у `nginxproxy/nginx-proxy` — по
> умолчанию). Доверие тем же обоснованием, что и XFF: `app`/`backend` наружу не опубликованы, дотянуться
> до них можно только через edge.

## Конвейер CI/CD (`.github/workflows/ci.yml`)

| Триггер | Что бежит |
|---|---|
| Pull request → `main` | `ci` (lint → test → typecheck → generate) + `docker-build` (matrix `runner`+`backend`, сборка обоих образов, **без** push) |
| Push в `main` | `ci` → `deploy` (matrix: push `runner`→`…/client-bank-alfa-by`, `backend`→`…/client-bank-alfa-by-backend`) |

- Обе матрицы идут с `fail-fast: false`: сборка одного образа не должна отменять сборку
  другого — иначе диагностика падения на PR обрывается на первом же таргете.

- `deploy` гейтится по зелёному `ci` (`needs: ci`) — красный CI не пускает образы в GHCR.
- Push в GHCR — встроенным `GITHUB_TOKEN` (`packages: write`), без отдельного секрета.
- Watchtower на сервере опрашивает реестр (~5 мин) и подменяет контейнер на свежий `:latest`.
- Ручной редеплой без code-commit — `workflow_dispatch` на `main` (перечитывает репо-переменные/секреты).
- Сторонние actions запинены на commit SHA (issue #2); SHA обновляет Dependabot
  (экосистема `github-actions`) по комментарию `# vX.Y.Z`.

> **Репо-переменные (GitHub → Settings → Secrets and variables → Actions → Variables)** пекутся во фронт
> на сборке как build-args. **`NUXT_PUBLIC_SITE_URL` в проде обязателен** (`https://<DOMAIN>`) — иначе
> фронт печёт пустой `siteUrl`, и `/install` откажется биндить события (относительный URL). Также
> `NUXT_PUBLIC_AUTHOR_NAME`/`NUXT_PUBLIC_AUTHOR_URL` (подвал). Незаданная переменная = пустое значение,
> без ошибки сборки — проверить можно в `window.__NUXT__.config.public` на задеплоенной странице.
>
> **`docker-compose.prod.yml` на сервере обновляется вручную** — Watchtower подменяет только образы, не
> compose-файл. После изменений в compose (новые сервисы/переменные, напр. redis #48, `B24_APPLICATION_TOKEN`
> `:?`→`:-` #53, **сервис `worker` + `QUEUE_WORKERS=0` на backend** — вводить оба **вместе**, иначе очереди
> встанут молча; **`TELEGRAM_ALERT_*` на сервисе `backend`** #426 — их надо и добавить в `.env` на
> сервере, и пробросить в compose, иначе переменные просто не доедут в контейнер и канал оповещений
> молча останется выключенным) синхронизировать файл на сервере руками, иначе `docker compose up`
> падёт на устаревшем.

> **`NUXT_PUBLIC_BUILD_DATE`** (#425) — build-arg, а не серверная переменная: дата коммита для
> `<lastmod>` в `sitemap.xml`, CI подставляет её сам (`git show -s --format=%cs`). На сервере ей
> делать нечего — статика уже запечена в образ; в `.env` и в compose добавлять НЕ надо. Пусто ⇒
> элемент `<lastmod>` просто опускается (неверная дата хуже отсутствующей).
>
> **После первого выката** пройдите чек-лист [`SEO.md`](SEO.md): robots/sitemap доступны, служебные
> страницы закрыты, несуществующий адрес отдаёт 404, превью ссылки в мессенджерах не пустое.

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
3. **GHCR-пакеты должны быть публичными** — **оба наших**: `ghcr.io/bx-shef/client-bank-alfa-by`
   (лендинг) и `ghcr.io/bx-shef/client-bank-alfa-by-backend` (node). Плюс **чужой**
   `ghcr.io/bx-shef/bee2-tls-gateway` ([репозиторий шлюза](https://github.com/bx-shef/bee2-tls-gateway)) — но только
   если сервис `crypto-gw` включён; выключенный (как сейчас) в `pull` не участвует. Тогда ни серверу, ни Watchtower не нужен
   `docker login`. Если приватные — перед `up -d` сделать `docker login ghcr.io` (PAT с
   `read:packages`) и настроить креды Watchtower (см. «Если репозиторий приватный»).

### ⚠ После выката #496: права приложения изменились (ре-consent)

В `B24_REQUIRED_SCOPES` добавлен **`imbot`** — без него сообщения в чаты идут от имени владельца
OAuth-токена, а не приложения. Скоуп относится к правам, которые портал выдаёт **при установке**,
поэтому **уже установленные порталы его не получат**: старый грант останется прежним, и бот на них
не появится.

Что это значит на практике:

- Импорт, запись дел, опрос банков — **работают как раньше**, скоуп аддитивен и ничего не гейтит.
- Сообщения в чаты продолжают **доходить**: при отказе бота работает откат на прежний метод. Меняется
  только подпись.
- Чтобы появился бот, портал должен **переустановить приложение**, подтвердив запрошенные права.
  Это владельческое действие, кодом не закрывается.
- В карточке локального приложения на портале список прав тоже нужно обновить — иначе повторная
  установка выдаст тот же старый набор (`docs/B24_EVENTS.md`, шаг «Регистрация локального приложения»).
- ⚠ Решение «бота нет» кэшируется в памяти процесса. После переустановки на портале перезапустите
  `worker`, иначе бот подхватится только со следующим рестартом.

Диагностика — `docs/OPERATIONS.md`, строка «Сообщения в чат приходят от имени сотрудника».

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
# Служебная зона оператора (/queues, /api/ops/*). ⚠ ОБЯЗАТЕЛЬНО В ПРОДЕ: пустой пароль means
# «вход выключен», и `operatorAllowed` пропускает ВСЕХ — зона окажется открыта миру
# (nginx `deny all` стоит только на /api/queues, на /api/ops/* его нет). См. docs/AUTH.md.
PUBLIC_PAGE_BASIC_AUTH_PASS=<openssl rand -hex 24>
SESSION_SECRET=<openssl rand -hex 32>
# OAuth-приложение Б24. ⚠ ОБЯЗАТЕЛЬНЫ В ПРОДЕ, хотя установка «пройдёт» и без них: без пары
# не работают refresh access-токена, keep-alive (простаивающий портал теряет авторизацию на
# 180-й день) и привязка member_id к гранту — авария тихая и отложенная.
B24_CLIENT_ID=<из карточки приложения>
B24_CLIENT_SECRET=<из карточки приложения>
# B24_APPLICATION_TOKEN оставляем пустым: токен придёт per-portal в ONAPPINSTALL и сохранится.
# Задать (сильное случайное) стоит лишь чтобы включить серверную диагностику /api/queues.
EOF

# 3. поднять app + backend + worker + db + redis (образы из GHCR; обновления подхватит Watchtower).
#    ⚠ `worker` обязателен: backend идёт с QUEUE_WORKERS=0, без воркера очереди молча встанут.
make prod-up
```

URL приёма событий приложения — `https://<DOMAIN>/api/b24/events` (тот же домен, проксируется
nginx в backend). Он указывается **один раз** — в форме регистрации приложения (обработчик
`ONAPPINSTALL`/`ONAPPUNINSTALL`), это же ваш домен из `NUXT_PUBLIC_SITE_URL`. Per-portal вручную
ничего вводить не нужно; прочие обработчики (`event.bind`) приложение регистрирует само при установке
(URL строится из env). Итого в папке — только `docker-compose.prod.yml`,
`Makefile`, `.env`. Обновить эти два файла
позже — повторить `curl` из шага 1 (в минимальном варианте `git pull` недоступен; образ обновляется
через Watchtower независимо от папки).

Обёртки `Makefile`: `make prod-up` / `make prod-pull` / `make prod-redeploy` (обновить образ сейчас,
без ожидания Watchtower) / `make logs` / `make ps` / **`make doctor`** (диагностика стенда одним
прогоном, домен берётся из `.env`) / **`make queue-stats`** (счётчики очередей). Последние две
скачивают скрипт с GitHub во временный файл — репозитория в этой папке нет, а сами скрипты в
образ не кладутся; подробности — [`OPERATIONS.md`](OPERATIONS.md) и комментарий в `Makefile`.

> Альтернатива: `git clone` репозитория в папку — тогда обновление `compose`/`Makefile` одним
> `git pull`, ценой лишних файлов (~400 КБ). На рантайм не влияет.

Локальная проверка образа (в клоне репо): `make build-local` = `docker compose up --build` —
раздаёт на `:8081` (порт уведён с `:80`, чтобы не конфликтовать с локальным `currency-converter`).

## Проверка каркаса на двух порталах (изоляция доступов)

Цель — убедиться, что доступы и настройки **не пересекаются** между разными Bitrix24.

1. Установить приложение на **портал A** и **портал B** (событие `ONAPPINSTALL` → backend сохранит
   токены каждого портала отдельной строкой в `portal_tokens`, ключ — `member_id`).
2. В настройках приложения (`/app` → шестерёнка → слайдер портала со страницей `/settings`) каждого портала выбрать **разные**
   чаты уведомлений и сохранить. UI шлёт на backend **фрейм-токен** портала (заголовки
   `Authorization: Bearer` + `X-B24-Domain`), а не `member_id` — B24 сам скоупит токен к порталу
   вызывающего, так что дотянуться до чужого `app.option` из браузера нельзя (настройки хранятся
   в `app.option` под ключом `SETTINGS_KEY`, отдельным пространством на каждый портал).
3. Открыть настройки на каждом портале заново — каждый показывает **свой** выбранный чат и никогда
   чужой. Строки токенов в `portal_tokens` — раздельные по `member_id` (`member_id` виден в
   диагностике `/install` или в логах backend при установке: `[b24 events] ONAPPINSTALL member_id=…`).
4. Деинсталляция (`ONAPPUNINSTALL`) стирает строку портала и его `app.option`-настройки — после неё
   портал начинает с чистого листа.

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

⚠ Это же ломает **`make doctor` и `make queue-stats`**: они тем же анонимным `curl` качают скрипт
из `scripts/`. Отказ громкий (`curl -f` → ненулевой код, `make` обрывает цель — вчерашний скрипт не
подхватится), но диагностики не будет ровно тогда, когда она нужна. Вариант на этот случай — держать
`prod-doctor.sh`/`queue-stats.sh` рядом с `compose` (тем же `git clone` с токеном из шага 1) и звать
их напрямую, `bash ./prod-doctor.sh`.

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
