# Операции: пост-запускной runbook (#246)

> Last reviewed: 2026-07-17

Как понять, что приложение живо, где смотреть диагностику, что делать при типовых сбоях,
как откатиться и куда эскалировать. Дополняет [`DEPLOY.md`](DEPLOY.md) (как деплоить) и
[`QUEUES.md`](QUEUES.md) (устройство очередей). Все команды — на прод-сервере из каталога
деплоя (`docker compose -f docker-compose.prod.yml …`).

## Что крутится в проде

Один образ, поднимается несколькими сервисами (`docker-compose.prod.yml`):

| Сервис | Что делает | Роль по env |
|--------|-----------|-------------|
| `app` | nginx: статика лендинга/iframe-UI + прокси `/api/*` → `backend:3000` | — |
| `backend` | Nitro: API (вебхуки B24, настройки, импорт, health) + **крон** + единственный воркер `b24-events` (install/uninstall — на одном инстансе ради порядка) | `QUEUE_WORKERS=0` (API+крон), миграция (дефолт `RUN_MIGRATION=1`) |
| `worker` (×N) | BullMQ-воркеры: `bank-fetch`/`file-parse`/`crm-sync` (масштабируемая обработка; `b24-events` тут **не** крутится) | `QUEUE_CRON=0`, `RUN_MIGRATION=0` |
| `db` | Postgres (токены порталов/банков, факты разнесения, метрики) | — |
| `redis` | шина очередей BullMQ (сеть `queuenet`, `internal: true`) | — |

Обновления образов подхватывает хостовый **Watchtower** из GHCR (см. `DEPLOY.md`). Крон и
миграцию гоняет **ровно один** инстанс (`backend`); воркеры масштабируются `--scale worker=N`.

## «Живо ли» — health и первичная проверка

1. **Liveness backend:** `GET https://<DOMAIN>/api/health` → `{status:"ok", time, commit, commitUrl}`.
   `commit` = сборка, которая реально крутится (тот же SHA, что в подвале лендинга) — так видно,
   что Watchtower подтянул нужный образ. Без секретов; на нём же docker `healthcheck` backend'а.
   ⚠ **`/api/health` — только liveness процесса.** Он **не** проверяет Postgres, Redis и воркеры:
   при упавшем `db`/`redis` health остаётся **зелёным**, а приложение при этом мёртво (crm-sync
   падает, токены не читаются). Для проверки зависимостей — `/api/ready` (ниже).
2. **Readiness backend:** `GET https://<DOMAIN>/api/ready` → `200 {ready:true, status:"ok", checks:{db, redis}}`;
   при проблеме — `503` с `status:"down"` (Postgres недоступен — не работает ничего) или `status:"degraded"`
   (db жив, но настроенный Redis недоступен — API и события B24 работают через синхронный фолбэк, а
   импорт/опрос/crm-sync стоят). **Прощупывает Postgres** (`SELECT 1`) **и Redis** (`PING`, если очереди
   включены; `redis:null` = очереди выключены, не ошибка; таймаут пинга не даёт пробе зависнуть при
   недоступном Redis). Без секретов и без глубины очередей. Это то, что стоит вешать на аптайм-мониторинг
   (и кандидат для docker `healthcheck` вместо liveness). `db:false` → строка «Postgres упал»;
   `redis:false` → **«Redis недоступен»** (PING не прошёл). ⚠ Redis, живой но забитый (память/AOF), PING
   **проходит** → `redis:true` — это `/api/ready` не ловит, см. строку «Redis деградировал» (`logs redis`).
3. **Лендинг/статика:** `GET https://<DOMAIN>/` отдаёт 200 (nginx `app`).
4. **Контейнеры:** `docker compose -f docker-compose.prod.yml ps` — все `Up`/`healthy`.
   `backend` unhealthy → смотреть `docker compose logs backend` (частые причины — env-валидация,
   недоступный Postgres/Redis; см. ниже).

## Диагностика очередей

Импортёр — очередь-driven, поэтому «здоровье» = очереди разгребаются, а не растут.

- **Консольно (для оператора-админа сервера):** `bash scripts/queue-stats.sh` — читает
  `GET /api/queues` по токену `B24_APPLICATION_TOKEN` заголовком `X-Check-Token` (nginx снаружи
  `deny all`; токен не в URL-логах). Нужно задать `B24_APPLICATION_TOKEN` сильным значением.
  **Токен не набирать инлайном** (`B24_APPLICATION_TOKEN=… ./scripts/…` попадает в history и `ps`) —
  подтянуть из деплой-`.env`: `set -a; . ./.env; set +a` перед запуском.
- **В браузере (сотрудник):** страница `/queues` (за логином оператора, `PUBLIC_PAGE_BASIC_AUTH_PASS`
  + `SESSION_SECRET`) → живой график по `GET /api/ops/queues`. `?preview=1` — синтетика для скриншотов.
- **Что нормально:** `waiting`≈0 в покое; всплеск при опросе/импорте, затем разгреб. `failed` копится
  только на реальных сбоях (кап `removeOnFail` 5000).

### Сигналы, которые НЕ видны в дефолтных счётчиках

- **Насыщение rate-limiter'а (A8).** Живой опрос Альфы капнут глобально (`QUEUE_FETCH_RATE_MAX`/
  `_DURATION_MS`, дефолт 100/60с). При превышении BullMQ **откладывает** лишние fetch-джобы (не
  теряет, попытку не жжёт) — на графике это рост `waiting`/`delayed` на `bank-fetch`, **неотличимый**
  от обычного бэклога. **Явный сигнал в логах:** крон после каждого опроса пишет
  `[queue] bank-fetch backlog N ≥ M — likely A8 rate-limit saturation …`, когда бэклог
  (`waiting+delayed`) переходит порог `QUEUE_FETCH_SATURATION_THRESHOLD` (дефолт 200) — так упор в кап
  виден по grep'у, а не только по графику. Поднимать лимит только если Альфа поднимет свой.
- **Крон не на том инстансе.** Крон/демо-нагрузку/keep-alive **и единственный воркер `b24-events`** поднимает
  только инстанс с `QUEUE_CRON=1` (по умолчанию `backend`). Два таких инстанса → дубли fetch-джобов. Проверить:
  `QUEUE_CRON` ровно на одном. **Следствие:** если `backend` лежит, `worker`-контейнеры разгребают
  `bank-fetch`/`file-parse`/`crm-sync`, но **события установки/удаления приложения (`b24-events`) не
  обрабатываются** — масштабирование `worker` их не подхватит (по замыслу — один инстанс ради порядка
  install→uninstall). Живой `backend` для приёма установок обязателен.
- **Keep-alive токенов (#175).** Раз в сутки (`TOKEN_KEEPALIVE_HOURS`) крон рефрешит простаивающие
  порталы у истечения refresh (~180 д). Гейт на `B24_CLIENT_ID/SECRET` — без них в логах warning
  «token keep-alive disabled», и простаивающие порталы теряют авторизацию на 180-й день.

## Частые сбои и что проверять

| Симптом | Вероятная причина | Что делать |
|---------|-------------------|-----------|
| Health зелёный, но crm-sync падает, токены не читаются/не пишутся | **Postgres упал** после старта (health его не проверяет) | `docker compose ps db` (не `Restarting`?), `logs db`, `logs worker` (ошибки соединения/`token`). Поднять `db`: `docker compose -f docker-compose.prod.yml up -d db`. Data-loss риск при полном диске — см. строку про диск |
| REST/авторизация порталов массово падает, в логах ошибки **дешифровки** (не `expired_token`) | `B24_TOKEN_ENC_KEY` **сменили** между деплоями — refresh-токены зашифрованы старым ключом (envCheck проверяет только длину 32 байта, не совпадение) | Ключ **обязан быть стабильным** между деплоями. Вернуть прежний ключ; если утерян — все порталы переустанавливают приложение (токены осиротели). Реактивный рефреш SDK это **не** чинит (это не протухший access) |
| `backend` «healthy», но токены не сохраняются; в логах `[env] …` | env-валидация (`envCheck`) нашла проблему (битый `B24_TOKEN_ENC_KEY`/плейсхолдер `B24_APPLICATION_TOKEN`/нет `DATABASE_URL`), но **процесс не падает** — работает вхолостую | envCheck **логирует и продолжает** (health зелёный, `ps` healthy — не обманываться). Грепнуть `logs backend` на `[env]`. Исправить `.env` → **пересоздать**: `docker compose -f docker-compose.prod.yml up -d backend` (именно `up -d`, а не `restart` — `restart` **не** перечитывает `.env`) |
| Установка/удаление приложения «не дошли» | Redis недоступен | Онлайн-события B24 **не ретраятся**, поэтому роут пишет в БД **синхронным фолбэком** — данные не теряются. Поднять Redis: `docker compose -f docker-compose.prod.yml up -d redis`; проверить `docker compose -f docker-compose.prod.yml logs backend` |
| `waiting` растёт, **fetch/import** не проходят (события — доходят) | Redis **жив, но деградировал**: полон/AOF не пишет (диск)/eviction | BullMQ требует `noeviction`; при упоре в память enqueue падает. Синхронный фолбэк есть **только** у `b24-events`, не у fetch/import. Освободить память/диск Redis, проверить `logs redis` на OOM/`MISCONF`. Затем перепроверить очереди |
| Очереди не разгребаются, `waiting` растёт | Нет `worker`-контейнера (или `QUEUE_WORKERS=0` везде) | Сначала отличить от крэш-лупа (ниже): `docker compose ps worker`. Если контейнера нет — backend при `QUEUE_WORKERS=0` пишет warning «this instance does NOT process …». Поднять: `docker compose -f docker-compose.prod.yml up -d --scale worker=N` |
| `waiting` растёт, `worker` есть, но в статусе `Restarting`/растёт restart-count | Воркер **крэш-лупит** (OOM на крупном `crm-sync`/`file-parse` держит файл в памяти) | `docker inspect <worker> --format '{{.State.OOMKilled}} {{.RestartCount}}'`. Если OOM — поднять лимит памяти сервиса или `QUEUE_CONCURRENCY` вниз. «Поднять воркер» тут **не** поможет — он уже поднят и циклится |
| Миграция БД не прошла: health зелёный, но записи падают `relation/column does not exist` | Ошибка миграции на старте (`migrate.ts` **логирует и не роняет**; `worker` стартует до завершения миграции) | Грепнуть `logs backend` на итог миграции/ошибку. Починить БД/права, перезапустить `backend` (миграция идемпотентна — повторный прогон безопасен) |
| Опрос банков «пустой», ничего не пишется | Нет подключённых счетов (`bank_tokens` пуст) или `CRON_REAL_POLL≠1` | Ожидаемо до подключения счёта (A7) и включения реального опроса. `CRON_REAL_POLL` default-OFF — включать осознанно |
| Кнопка «Опросить сейчас» отвечает 503 / 429 / 403 | 503 — `MANUAL_POLL_ENABLED≠1` (или нет Redis); 429 — кулдаун (`MANUAL_POLL_COOLDOWN_SEC`, дефолт 60с); 403 — не админ портала (#54) | 503: включить `MANUAL_POLL_ENABLED=1` осознанно (частота регулируется app-side). 429: подождать кулдаун. 403: жать может только админ портала |
| Импорт есть, но операция не попала в CRM | Компания по счёту не найдена → `unmatched` (не пишем, v1) | Проверить реквизиты компании (`RQ_ACC_NUM`/ИИК). Неоднозначные/ручные исходы уходят в чат ошибок портала (сам `unmatched` не оповещается) |
| REST к B24 падает `expired_token` | Протух access-токен портала | SDK рефрешит реактивно сам; при повторе — проверить `B24_CLIENT_ID/SECRET` (без них рефреш невозможен) |
| `no space left on device` | Кончилась дисковая квота | Освободить **образы**: `docker image prune -a` + `docker builder prune` (**без** `--volumes`). **НИКОГДА** `docker system prune --volumes` — снесёт тома `redisdata`/Postgres (потеря очередей/данных). Логи контейнеров — усечь json-файлы (`truncate -s0 /var/lib/docker/containers/*/*-json.log`) или настроить `max-size`; `docker compose logs` их **не** освобождает. ⚠ При полном диске Postgres (WAL) и Redis (AOF) уже могли встать в read-only — после освобождения **перепроверить** `logs db`/`logs redis` и health |
| TLS истёк / сайт не открывается | acme-companion не обновил cert | Проверить DNS A-запись `DOMAIN`, логи `acme-companion`; DNS должен указывать на сервер. При повторных неудачах — лимит Let's Encrypt (5 дублей серта/неделю): не долбить renew, сперва починить DNS |
| Странные окна опроса/keep-alive, токены «протухают» раньше срока | Расхождение часов хоста | Сверить `date` на хосте с NTP — окна near-expiry/опроса и валидность TLS завязаны на системное время |

## Процедура отката

Сейчас `docker-compose.prod.yml` тянет образы GHCR по тегу **`:latest`** (жёстко в файле), обновления
подхватывает Watchtower. Пока тег не параметризован env — откат делается пином тега в compose:

1. Найти рабочий SHA: `GET /api/health` до сбоя (поле `commit`), либо список тегов в GHCR —
   `gh api "/orgs/bx-shef/packages/container/client-bank-alfa-by/versions" --jq '.[].metadata.container.tags[]'`
   (или в вебе: GHCR-страница пакета). CI пушит тег на каждый `main`.
2. **Сначала отключить Watchtower** для этих контейнеров (иначе за ~5 мин он перекатит пин обратно на `latest`
   прямо посреди отката): добавить каждому сервису в `docker-compose.prod.yml` метку
   `labels: [ "com.centurylinklabs.watchtower.enable=false" ]`. Метка применится тем же `up -d` на шаге 4.
3. В `docker-compose.prod.yml` заменить `…/client-bank-alfa-by:latest` и `…-backend:latest` на `:<SHA>`
   (оба образа — `app` и `backend`/`worker` — на один и тот же SHA).
4. `docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`.
5. Проверить `GET /api/health` → `commit` == откатанный SHA.
6. **После выпуска фикса вернуть `:latest` и убрать метку** — контейнер с выключенным автообновлением
   перестаёт получать патчи.

> **Улучшение (#246):** параметризовать тег через env (`APP_IMAGE_TAG`, дефолт `latest`), чтобы откат был
> правкой `.env`, а не compose. Пока — правка compose.

Миграции БД **аддитивны и идемпотентны** (`server/plugins/migrate.ts`), откат образа их не ломает
(старый код просто не использует новые колонки). Данные при откате образа не теряются.

## Диск / TLS / алерты

- **Диск:** тома `redisdata`/Postgres растут; `removeOnComplete/Fail` (1000/5000) капают историю
  очередей. Мониторить свободное место; при заполнении сначала чистить образы/логи, не тома.
- **TLS:** cert выпускает/обновляет `acme-companion` (общий reverse-proxy). Алерт — истечение <7 д.
- **Health-probe:** внешний аптайм-мониторинг вешать на `GET /api/ready` (200/503, прощупывает
  db+redis) — он ловит упавшую зависимость, в отличие от liveness `/api/health` (200 + свежий `time`).

## On-call / эскалация

1. Первичная триада: `/api/ready` (зависимости живы? — db+redis; `/api/health` — только liveness) →
   `docker compose ps` (все контейнеры `Up`/`healthy`, никто не `Restarting`?) →
   `scripts/queue-stats.sh` (очереди разгребаются?).
   **Предусловие шага 3:** диагностика очередей требует заранее заведённого `B24_APPLICATION_TOKEN`
   (консоль) или операторского логина (`/queues`) — без них оба пути недоступны именно тогда, когда нужны.
2. Логи по сервису: `docker compose -f docker-compose.prod.yml logs <service> --tail=200`.
3. Эскалация — автор/владелец (`bx-shef`, контакты в подвале приложения); банк-инциденты
   (Альфа/Приор недоступны, сменились креды) — за владельцем (креды у него, в репо их нет).

## Follow-up

- ~~Readiness-проба (db+redis)~~ — **сделано** (`GET /api/ready`, 200/503). Дальше — глубина/насыщение
  очередей в проб(е)/телеметрии (#78) и, при желании, переключить docker `healthcheck` с liveness на `/api/ready`.
- ~~Лог сатурации rate-limiter'а `bank-fetch`~~ — **сделано** (крон логирует backlog ≥ порог, см. выше);
  дальше — реактивный 429 через `Worker.RateLimitError`, если Альфа начнёт отдавать 429.
- **`DIAGNOSTICS_POLICY.md`** — кто из ролей что видит в диагностике (актуально с телеметрией #78).
