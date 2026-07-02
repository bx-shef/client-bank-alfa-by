# События и авторизация Bitrix24 (установка, удаление, брокер событий)

> Last reviewed: 2026-07-02

Как приложение учитывает авторизацию портала, обрабатывает установку/удаление и
проверяет подлинность входящих событий Bitrix24. Здесь — **доменное ядро**
(чистые функции `app/utils/b24Events.ts` + типы `app/types/b24Events.ts`,
покрыты тестами `tests/b24Events.test.ts`) и контракт для будущего **backend**,
который владеет HTTP-транспортом и хранилищем токенов.

> Эталон — соседний backend `bx-synapse` (рабочая интеграция с Б24): тот же
> подход (`tokenStore`/`b24Install`/`b24EventAuth`/`b24Form`). Мы переносим
> **проверенную модель**: чистую логику держим во `frontend` (переносима в
> backend без переписывания — конвенция `CLAUDE.md`), транспорт реализует backend.

## Зачем это нужно

Тиражное приложение Б24 получает события **исходящими вебхуками** на свой URL:

- `ONAPPINSTALL` — сразу после успешной установки на портал. В нём приходят
  OAuth-данные (`access_token`/`refresh_token`) **и** `application_token` — общий
  секрет, которым подписаны все последующие события. Его нужно **сохранить**.
- `ONAPPUNINSTALL` — при удалении приложения. OAuth-данных в нём уже нет (права
  отозваны), поэтому **единственный** способ убедиться, что вебхук пришёл от Б24,
  а не от злоумышленника, — сверить `application_token` с сохранённым.

Подробности контракта — официальная дока:
[OnAppInstall](https://apidocs.bitrix24.ru/api-reference/common/events/on-app-install.html),
[onAppUninstall](https://apidocs.bitrix24.ru/api-reference/common/events/on-app-uninstall.html),
[Безопасность в обработчиках](https://apidocs.bitrix24.ru/api-reference/events/safe-event-handlers.html).

## Учёт авторизации (per-portal)

Backend хранит по каждому порталу запись `PortalCredentials`
(`app/types/b24Events.ts`), ключ — `memberId` (стабильный id портала):

| Поле | Назначение |
|---|---|
| `memberId` | Первичный ключ портала |
| `domain` | Хост портала (`*.bitrix24.*`) |
| `applicationToken` | **Подпись событий.** Хранить открытым, **write-once** |
| `accessToken` | Короткоживущий токен REST (~1 ч) |
| `refreshToken` | Продление доступа. Хранить **зашифрованно** (не plaintext) |
| `expiresIn` | TTL access-токена (Б24: 3600 с) |
| `clientEndpoint`/`serverEndpoint` | База REST портала / сервер обновления токена |

Правила (как в `bx-synapse`, реализация backend — issue #35):

- **`refresh_token` — зашифрованно** (AES-256-GCM на backend), не как в legacy
  (plaintext на ФС). Тем же ключом он шифруется **и в пакете очереди** (`register`-джоба
  несёт `refreshTokenEnc`, не clear) — через Redis в открытом виде не ходит; консьюмер
  расшифровывает и пишет `saveToken`. `application_token` хранится открытым — он не даёт
  доступа к API, только подтверждает подлинность вебхука.
- **Удаление приложения → полная очистка (политика).** Любой легитимный `ONAPPUNINSTALL`
  стирает всё, что связано с порталом (строка `portal_tokens`); флаг `CLEAN` не смотрим —
  удалили приложение, значит не храним по нему ничего.
- **`application_token` — write-once:** первый легитимный `ONAPPINSTALL` его
  вписывает, повторные события **не затирают** (в БД — `COALESCE(NULLIF(...))`).
  Write-once должен быть **атомарным** на уровне БД (idempotent к конкурентным
  install-событиям) — иначе повторный `ONAPPINSTALL` с другим токеном перехватит
  портал. В проде `B24_APPLICATION_TOKEN` (env) закрывает этот риск полностью.
- **`expires_in` на wire — строка** (form-encoding не несёт типов): `parseBracketForm`
  отдаёт `"3600"`, приведение к числу — на стороне backend при сохранении.
- **Refresh access-токена** — по `isAccessTokenExpired` (`app/utils/alfaOauth.ts`,
  тот же приём с запасом 60 с): `POST {server_endpoint}/oauth/token`,
  `grant_type=refresh_token`, креды **в теле** запроса (не в URL — защита от логов).
- `issuedAtMs` ставит backend в момент получения токена (`Date.now()`), не при
  разборе — иначе проверка истечения бессмысленна.

`extractPortalCredentials(installEvent)` собирает `PortalCredentials` из auth-блока
события (без `issuedAtMs` — его ставит транспорт).

## Брокер событий (диспетчеризация + проверка подлинности)

Backend принимает все вебхуки одной точкой входа (`POST /api/b24/events`) и
прогоняет их через чистое ядро:

1. **Разбор wire-формата.** Б24 шлёт тело как `application/x-www-form-urlencoded`
   с PHP-скобками (`auth[member_id]=…`, `data[VERSION]=…`), а **не** JSON из доков.
   `parseBracketForm(rawBody)` восстанавливает вложенный объект той же формы, что
   разбирают `parse*Event`.
2. **Проверка подлинности (fail-closed).** `appTokenVerdict({ isInstall, incoming,
   envToken, storedToken })` → `accept` | `forbidden` | `unconfigured`:
   - на установке: если задан `envToken` — сверяем с ним; иначе **первый**
     непустой токен бутстрапит доверие (пустой → `forbidden`, отсекаем зонды);
   - на прочих событиях: ожидаемый токен = `envToken` **или** сохранённый в БД;
     нет ни того, ни другого → `unconfigured` (портал неизвестен → отказ);
   - сверка — **constant-time** (`safeEqual`), без утечки по таймингу.

   `envToken` backend читает из переменной окружения **`B24_APPLICATION_TOKEN`**
   (имя задаётся при регистрации приложения). **В проде она обязательна:** без неё
   режим bootstrap (TOFU — trust-on-first-install) принимает любой непустой токен,
   то есть знающий URL вебхука может «установить» произвольный `member_id`. Bootstrap
   без env — только для дев/первого запуска.

   Backend отдаёт коды: `accept` → обработать, `forbidden` → **403**,
   `unconfigured` → **503**.
3. **Решение → очередь → консьюмер (эндпоинт в БД не пишет).** `processB24Event`
   только **верифицирует** (шаг 2, чтение сохранённого токена для uninstall) и
   возвращает `B24EventResult` с `action`:
   - `register` (ONAPPINSTALL) — `action.credentials` для сохранения;
   - `unregister` (ONAPPUNINSTALL) — стереть портал **всегда** (флаг `CLEAN` не смотрим —
     удалили приложение, значит не храним по нему ничего);
   - нет `action` — событие не наше / отказ (200/403/503 по вердикту).

   `handleEventRequest` **кладёт `action` пакетом в очередь `b24-events`** (`refresh_token`
   шифруется перед Redis — в открытом виде через брокер не ходит), а **консьюмер**
   (`handleEventJob`) — единственный писатель: регистрирует портал (`saveToken`, write-once
   `application_token`) или удаляет (`deleteToken`). В норме приём быстрый, запись асинхронная и
   ретраится BullMQ (attempts+backoff; исчерпание → failed-set, восстанавливается вручную).

   **Онлайн-события Б24 не ретраятся** (`event.bind` — «никакого второго шанса», см. доку
   [«Концепция обработки событий»](https://apidocs.bitrix24.ru/api-reference/events/index.html);
   повторная доставка есть только у офлайн-событий `event.offline.*`, которые мы не используем).
   Поэтому если очередь недоступна (Redis нет/упал), `handleEventRequest` **синхронно пишет в БД
   тем же токен-стором** (фолбэк) — иначе установка потерялась бы безвозвратно. Нормальный путь —
   очередь; фолбэк — только когда брокер недоступен (взаимоисключающи, двойной записи нет).
   Redis желателен (async-пайплайн: воркеры/крон), но при его отсутствии приём событий не падает.

### Защита REST-вызовов к порталу (SSRF)

`client_endpoint` приходит **внутри события** (управляем злоумышленником), поэтому
перед REST-вызовом backend проверяет его `isSafeClientEndpoint(endpoint)`: только
`https://`, без loopback/private/link-local хостов. (DNS-rebinding ловится уже в
рантайме — чистая функция отсекает очевидные литералы.)

## Что в этом репозитории, а что в backend

| Слой | Где | Статус |
|---|---|---|
| Разбор события, вердикт токена, маршрутизация, SSRF-гуард, маппинг кредов | `app/utils/b24Events.ts` (чистое, тесты) | **готово** |
| Типы события/кредов | `app/types/b24Events.ts` | **готово** |
| HTTP-эндпоинт `POST /api/b24/events` — верификация + постановка пакета в очередь (без записи в БД) | `server/api/b24/events.post.ts`, `server/utils/b24EventsHandler.ts` | **готово** |
| Консьюмер `b24-events` — единственный писатель: регистрация/удаление портала | `server/queue/handlers.ts` (`handleEventJob`), `server/queue/worker.ts` (`savePortal`/`deletePortal`) | **готово** |
| Хранилище токенов портала (Postgres, шифрование refresh, write-once) | `server/utils/tokenStore.ts`, `server/utils/secretCrypto.ts`, `server/db/client.ts` | **готово** |
| Миграция схемы `portal_tokens` на старте | `server/plugins/migrate.ts` | **готово** |
| Регистрация хендлеров событий (`event.bind` из установочного скрипта) | `app/pages/install.vue` + `app/utils/b24EventBind.ts` (чистый билдер, тесты) | **готово** (билдер+тесты; доставка на реальном портале — вручную) |
| Refresh-цикл access-токена, REST-вызовы к порталу (опрос/дела/чат) | backend | этапы 4–6 плана (#35) |
| `installFinish` + диагностика в iframe | `app/pages/install.vue` | готово (этап 2) |

> Фрейм-страница `/install` завершает установку в iframe (`installFinish`) и
> **из установочного скрипта** привязывает обработчики событий (`event.bind` на
> `ONAPPINSTALL`/`ONAPPUNINSTALL` → `${siteUrl}/api/b24/events`) **до** `installFinish` —
> так текущая установка доставляет `application_token`. Для **локального** приложения
> отдельного поля «URL обработчика события» в карточке нет: биндим из скрипта
> (подтверждено докой Б24). Билдер батча привязок — чистый `app/utils/b24EventBind.ts`
> (идемпотентен: пропускает уже верные привязки, перепривязывает устаревшие). Серверные
> события — **отдельный** механизм (исходящие вебхуки на backend `/api/b24/events`),
> и именно он даёт `application_token`. Требует `NUXT_PUBLIC_SITE_URL` в проде (абсолютный
> URL хендлера) — иначе `/install` откажется биндить и покажет ошибку с retry.

### Запуск backend (docker)

`docker compose up` поднимает `db` (Postgres) и `backend` (node-сервер с эндпоинтом).
Перед стартом задать в `.env` (шаблон — `.env.example`):

- `B24_TOKEN_ENC_KEY` — ключ шифрования refresh, **обязателен**, ровно **32 байта**: 64 hex-символа
  (`openssl rand -hex 32`) или base64, декодирующийся в 32 байта. Обрезанное значение (напр. 31 байт)
  → шифрование падает и установка не сохранит токен.
- `B24_APPLICATION_TOKEN` — **опционален, для мультитенанта оставляют ПУСТЫМ**. `application_token`
  приходит per-portal внутри `ONAPPINSTALL` и хранится write-once; последующие события сверяются с
  сохранённым значением (одно значение не покроет N порталов — установка забутстрапит доверие сама).
  **Не ставить плейсхолдер** (`CHANGE_ME` и т.п.): реальный токен с ним не совпадёт → вердикт 403 →
  установка отклонится. Задают её лишь как shared guard-токен для серверных диагностик
  (`/api/queues`, `/api/b24/app-option-check`).
- `B24_CLIENT_ID`/`B24_CLIENT_SECRET` — из карточки приложения; нужны для refresh access-токена и
  `app.option` (для приёма событий и записи токена — не обязательны).

Эти значения валидируются **на старте** (`server/plugins/envCheck.ts` → чистая `checkBackendEnv`):
неверная длина ключа, плейсхолдер `application_token`, отсутствие `DATABASE_URL` дают внятный
`[env] …`-лог сразу, а не падение в хендлере.

Таблица `portal_tokens` создаётся автоматически на старте (`server/plugins/migrate.ts`).
Адрес обработчика события для портала — `https://<домен-backend>/api/b24/events`.

### Живой прогон на портале Bitrix24 (проверено)

Прогон выполнен на двух порталах (`b24-rvai7u.bitrix24.ru`, `bel.bitrix24.by`) — обе строки легли в
`portal_tokens` с разными per-portal `application_token` и зашифрованным refresh (мультитенант-bootstrap
работает). Порядок:

1. **Публичный HTTPS backend.** Б24 шлёт события на публичный URL (`localhost` из compose недоступен):
   деплой за nginx-proxy (`https://<домен>/api/b24/events`) либо туннель (`cloudflared`/`ngrok`) в dev.
2. **Регистрация локального приложения.** Путь установки = `https://<домен>/install`, обработчик (iframe)
   = `https://<домен>/app`, права `crm,im,user_brief,placement`. Обработчик события **отдельно указывать
   не нужно** — `/install` сам биндит `ONAPPINSTALL`/`ONAPPUNINSTALL` (до `installFinish`). Проверить —
   панель «Диагностика» на `/install` (блок «События») или `event.get`.
3. **Установить** → в логах `[b24 events] ONAPPINSTALL member_id=…` + `bootstrapped`; строка в
   `portal_tokens` (роль/база в нашем прод-compose — **`app`**, не `postgres`):
   ```
   docker compose -f docker-compose.prod.yml exec db psql -U app -d app \
     -c "select member_id, domain, left(application_token,6)||'…', (refresh_token_enc <> '') from portal_tokens;"
   ```
4. **Удаление** приложения с «очистить данные» (`CLEAN=1`) → `ONAPPUNINSTALL` → строка портала исчезает.

**Грабли, пойманные на живом прогоне (учтены в коде/доках):**
- `NUXT_PUBLIC_SITE_URL` в проде **обязателен** (репо-переменная GitHub Actions → build-arg): без него
  фронт печёт пустой `siteUrl` и `/install` отказывается биндить относительный URL.
- `B24_APPLICATION_TOKEN=CHANGE_ME` из старого `.env.example` → 403 на установке (теперь ловит `envCheck`).
- `B24_TOKEN_ENC_KEY` не 32 байта → шифрование refresh падает (теперь ловит `envCheck`).
- `docker-compose.prod.yml` на сервере обновляется **вручную** (Watchtower тянет только образы) — легко
  отстать на несколько PR; напр. старый compose требовал `B24_APPLICATION_TOKEN` через `:?`.
- Переустановка на тот же портал (тот же `member_id`) поверх старой записи не перезапишет write-once
  `application_token` — перед сменой регистрации чистим строку (`truncate portal_tokens` / `delete … where member_id=…`).

## Тесты

`tests/b24Events.test.ts` (node-проект): `parseBracketForm` (вложенность,
round-trip в `parseInstallEvent`), `appTokenVerdict` (бутстрап/env/stored/
fail-closed), `parse*Event` (валидация, неверный код), `extractPortalCredentials`
(маппинг, пропуск пустых полей), `isInstallComplete`, `isSafeClientEndpoint`
(https/loopback/private). Брокер: `tests/b24EventsHandler.test.ts` — `processB24Event`
(вердикт → `action` register/unregister, always-purge) и `handleEventRequest` (очередь →
outcome `queued`; синхронный фолбэк при недоступной очереди — `enqueue`=false/throw;
шифрование refresh; TTL). Консьюмер — `tests/queuePhase2.test.ts` (`handleEventJob`).

## Связанные документы и issues

- План — [`REFACTOR_PLAN.md`](REFACTOR_PLAN.md) (этапы 3–6: backend OAuth/опрос/дела/чат).
- OAuth Альфы (тот же приём с токенами/refresh) — [`ALFA_API.md`](ALFA_API.md).
- **#35** — backend: эндпоинт вебхуков B24 + хранилище токенов портала. Слайс приёма событий/токенов
  **реализован** (см. таблицу статусов выше); issue остаётся трекером остатка — refresh-цикл access-токена
  и `event.bind` на тестовом портале.
- #12 — безопасность транспорта **Альфы** (отдельный транспорт; та же дисциплина шифрования).
- #16 — настройки в `app.option` (хранение per-portal через backend).
