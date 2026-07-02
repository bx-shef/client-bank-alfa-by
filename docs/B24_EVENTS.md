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
  (plaintext на ФС). `application_token` хранится открытым — он не даёт доступа к
  API, только подтверждает подлинность вебхука.
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
3. **Маршрутизация.** `routeB24Event(payload, { envToken, storedToken })` объединяет
   шаги 2–3 и возвращает `B24EventDecision`:
   - `install` → сохранить `decision.credentials`;
   - `uninstall` → стереть портал, если `decision.purge` (выбор пользователя
     «очистить данные», `CLEAN=1`);
   - `unsupported` → событие не наше, игнор (200).

   На любом не-`accept` вердикте `routeB24Event` бросает ошибку — подделанный или
   устаревший вызов **не должен** стирать данные. Если backend'у нужны разные коды
   ответа (403 vs 503), он зовёт `appTokenVerdict` напрямую.

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
| HTTP-эндпоинт `POST /api/b24/events` + обработчик | `server/api/b24/events.post.ts`, `server/utils/b24EventsHandler.ts` | **готово** |
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

- `B24_TOKEN_ENC_KEY` — 32-байтный ключ шифрования refresh (`openssl rand -hex 32`), **обязателен**;
- `B24_APPLICATION_TOKEN` — **опционален**. `application_token` приходит per-portal внутри
  `ONAPPINSTALL` и хранится write-once; последующие события сверяются с сохранённым значением, поэтому
  для мультитенанта переменную оставляют пустой (одно значение не покроет N порталов — установка
  забутстрапит доверие сама). Задают её лишь как shared guard-токен для серверных диагностик
  (`/api/queues`, `/api/b24/app-option-check`).

Таблица `portal_tokens` создаётся автоматически на старте (`server/plugins/migrate.ts`).
Адрес обработчика события для портала — `https://<домен-backend>/api/b24/events`.

### Ручной тест на портале Bitrix24

Б24 шлёт события на **публичный HTTPS-URL** — `localhost:3210` из `docker compose` ему
недоступен. Чтобы протестировать install/uninstall на тестовом портале:

1. **Публичный адрес backend.** Либо туннель к локальному `backend` (`cloudflared tunnel
   --url http://localhost:3210` / `ngrok http 3210`), либо деплой backend на сервер за
   nginx-proxy. Получаем `https://<публичный-домен>/api/b24/events`.
2. **`B24_APPLICATION_TOKEN`.** Если токен приложения уже известен из карточки — задать его
   в `.env` **до первого install** (иначе bootstrap-режим примет любой токен; backend пишет
   об этом WARNING в лог).
3. **Регистрация обработчика события — автоматически.** Наш `/install` сам биндит
   `ONAPPINSTALL`/`ONAPPUNINSTALL` на `${NUXT_PUBLIC_SITE_URL}/api/b24/events` (см. выше). Вручную
   `event.bind` вызывать не нужно — достаточно указать `/install` как «путь для первоначальной
   установки» в карточке локального приложения. Проверить привязки можно на панели «Диагностика»
   страницы `/install` (блок «События») или методом `event.get`.
4. Установить приложение → проверить строку в `portal_tokens` (refresh зашифрован); удалить с
   «очистить данные» → строка исчезает.

## Тесты

`tests/b24Events.test.ts` (node-проект): `parseBracketForm` (вложенность,
round-trip в `parseInstallEvent`), `appTokenVerdict` (бутстрап/env/stored/
fail-closed), `parse*Event` (валидация, неверный код), `extractPortalCredentials`
(маппинг, пропуск пустых полей), `shouldPurgeData`/`isInstallComplete`,
`isSafeClientEndpoint` (https/loopback/private), `routeB24Event` (install/uninstall/
unsupported, отказ по токену).

## Связанные документы и issues

- План — [`REFACTOR_PLAN.md`](REFACTOR_PLAN.md) (этапы 3–6: backend OAuth/опрос/дела/чат).
- OAuth Альфы (тот же приём с токенами/refresh) — [`ALFA_API.md`](ALFA_API.md).
- **#35** — backend: эндпоинт вебхуков B24 + хранилище токенов портала. Слайс приёма событий/токенов
  **реализован** (см. таблицу статусов выше); issue остаётся трекером остатка — refresh-цикл access-токена
  и `event.bind` на тестовом портале.
- #12 — безопасность транспорта **Альфы** (отдельный транспорт; та же дисциплина шифрования).
- #16 — настройки в `app.option` (хранение per-portal через backend).
