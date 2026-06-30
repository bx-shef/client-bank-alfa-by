# План рефакторинга «Клиент-банк Альфа-Банк Беларусь»

> Last reviewed: 2026-06-30

Перенос и переписывание legacy-приложения (серверный PHP-апп Bitrix24) на новый стек.
Документ — живой план; обновляется по мере прохождения этапов.

## Что было (legacy, обезличенно)

Серверное «локальное» приложение Bitrix24 на старом PHP, мультитенантное (один инстанс
на ~260 порталов, OAuth-токены порталов — в файлах на диске). Поток:

1. Ключ API Альфы хранится в опциях приложения Б24 (опция вида `MC_CL_BNK_API_<id>`).
2. Для каждого ключа: `/token` → `/user/profile` → `/accounts/` → `/accounts/statement/`
   (Альфа developerhub, partner-API, только зачисления).
3. По корр-счёту плательщика ищется компания в CRM
   (`crm.requisite.bankdetail.list` → `crm.requisite.list` → `crm.company.get`).
4. В таймлайн компании пишется дело (старый `crm.activity.add`, PROVIDER), дедуп по `number|docId`.

Узкие места legacy: OAuth password-grant с захардкоженным ключом; секреты в коде;
`C_REST_IGNORE_SSL`; нет чата; нет cron (выписка тянется при открытии); старый API дел.

## Решения (зафиксированы)

| Тема | Решение |
|---|---|
| Хостинг backend | Тот же сервер за nginx-proxy (как деплой `currency-converter`: GHCR + Watchtower) |
| Первый этап | OAuth Альфы + получение выписки (PoC) — после получения доступов |
| Мультибанк | Абстракция «банк-провайдер» сразу; Альфа — первая реализация; Prior/ручной импорт — позже |
| Дела CRM | Универсальное дело `crm.activity.todo.add` (не старый `crm.activity.add`) |
| Доки API | Добываем сами; точные OAuth-параметры — из зарегистрированного приложения на developerhub |
| MCP | Позже, отдельным этапом |

## Целевая архитектура

- **Frontend** (`client-bank-alfa-by`, Nuxt 4): публичный лендинг (SSG) + B24-iframe-UI
  (настройки: ключ/чат/фильтры; просмотр выписки; приход/расход). Dual-mode, как `currency-converter`.
- **Backend** (новый сервис, за тем же nginx-proxy): OAuth Альфы + хранилище токенов,
  cron-опрос, запись универсального дела и сообщений в чат Б24, MCP, абстракция провайдеров.

Чистая доменная логика (классификация приход/расход, фильтры чата, билдер дела, дедуп,
интерфейс провайдера) живёт во `frontend` `app/utils|config|types` и покрыта тестами —
переносима в backend без переписывания (при выносе — заменить алиас `~` на путь пакета).

Страница `/app` — **SSG + client-side fetch** к backend (как `currency-converter`): статика
пререндерится, живые данные подтягиваются на клиенте при гидратации. CORS backend настраивается
под облачные домены Б24.

## Дорожная карта (по PR, «от малого к сложному»)

1. **[✓ этап 1] Доменное ядро + первый UI-срез (mock).** Типы выписки, абстракция
   `BankProvider`, чистые утилиты (приход/расход, фильтр чата, дедуп), билдер
   универсального дела (`crm.activity.todo.add`), демо-страница просмотра выписки на mock-данных. Тесты.
2. **[~ этап 2, частично] B24 dual-mode + SDK.** Подключены `@bitrix24/b24jssdk` (+ `-nuxt`),
   `useB24` (init/no-op вне фрейма), layout `clear` (`<B24App>`), `/install` (`init → installFinish`
   + диагностика, редирект на `/` вне фрейма); `/app` и `/settings` инициализируют фрейм
   (`setTitle`/`fitWindow`). **Осталось:** `placement.bind` и точная встройка (плейсменты/хендлер) —
   на тестовом портале; настройки остаются на demo-localStorage до backend (#16).
3. **Backend PoC: OAuth Альфы + выписка.** Чистое ядро (сборка `/authorize`, обмен/обновление
   токена, парсинг callback, нормализация выписки) — **готово и покрыто тестами**
   (`app/utils/alfaOauth.ts`, `app/utils/alfaStatement.ts`). Транспорт (HTTP-вызовы) и живой
   прогон — на BY-сервере (см. «Ограничение сети»).
4. **Поиск компании по корр-счёту + запись универсального дела** (перенос на todo-API).
5. **Cron-опрос** (разделение приход/расход; фильтры по р/счёту и теме платежа).
6. **Сообщения в чат** (выбор чата в настройках; не показывать по правилам).
7. **Docker + деплой.** [✓ фронтенд] Лендинг + B24-iframe-UI как статика за nginx
   (GHCR + Watchtower + nginx-proxy, как `currency-converter`) — `Dockerfile`, `nginx.conf`
   (CSP без `unsafe-inline` через `scripts/csp-hashes.mjs`), compose-файлы, CI `docker-build`/`deploy`.
   Детали — [`DEPLOY.md`](DEPLOY.md). Деплой **backend**-сервиса — по мере его появления (этапы 3–6).
8. **MCP-сервер** по выписке.
9. **Prior-банк + ручной импорт** (новые реализации `BankProvider`).

## API Альфы (подтверждено по свагеру + доке «Авторизация»)

> Ссылки на доку Альфы + карточка используемых методов/параметров — [`ALFA_API.md`](./ALFA_API.md).

- **OAuth 2.0:** flow **Authorization Code** (предпочт.) + refresh; `/authorize` и `/token` на
  `…:8273`. `(1)` `/authorize?response_type=code&scope=accounts&redirect_uri=…&state=…` →
  `(2)` `POST /token grant_type=authorization_code&code&redirect_uri&client_id&client_secret` →
  `{access_token, refresh_token, expires_in=3600}`; refresh `grant_type=refresh_token` (refresh ~10 ч).
  redirect_uri обязан **точно совпадать** с зарегистрированным. Код короткоживущий — менять сразу.
- **Выписка:** `GET /partner/1.2.0/accounts/statement` с `Authorization: Bearer`. Параметры:
  `number[]` (до 50), `dateFrom/dateTo` (**DD.MM.YYYY**), `transactions` (1=приход, 2=расход, 0=все),
  `pageNo/pageRowCount` (0=все), `amountFrom/To`, `transactionType`, `cacheKey`. Ответ — `page[]`
  (модель операции: `operType` D/C, `corr*`, `amount/currIso`, `purpose`, `docId/docNum`,
  `acceptDate/operDate`) + `statistics[]` + `errors[]`.
- Хосты: sandbox `developerhub.alfabank.by:8273`, prod `ibapi2.alfabank.by:8273`. Лимит 100/мин (пилот).

## Ограничение сети (важно)

Sandbox/prod Альфы **недоступны из облачной среды агента**: прокси устанавливает CONNECT-туннель
на `:8273`, но банк **сбрасывает TLS-рукопожатие** (гео/IP-ограничение). Поэтому **живые** вызовы
OAuth и выписки тестируются **только с BY-доступного сервера** (`bank-import.bx-shef.by`). Здесь
проверяется лишь чистое ядро (юнит-тесты на моках) — что и сделано.

## Хранение настроек и вызовы B24 (решение)

- **Настройки — в `app.option`** (настройки приложения Б24, привязаны к приложению на портале),
  не в localStorage. Как в legacy: ключ Альфы по «моей компании» (`MC_CL_BNK_API_<myCompanyId>`);
  настройки чата/фильтра (`chatId`, `directions`, исключения) — JSON-строкой под отдельным ключом.
  Значения опций — строки (сложное через `JSON.stringify`). `app.option.set` требует
  **admin/app-контекст** (наш app-токен установки — ок) и **не работает в batch**.
- **Вызовы B24 — server-side REST по сохранённому OAuth-токену** (тот же токен, что для опроса
  Альфы), а **не** через родительский фрейм iframe (`BX24.callMethod`): фреймовые методы ненадёжны.
- **Поток:** iframe-UI → наш backend (API) → B24 REST (`app.option.*`, `crm.*`) + Альфа. Фронт не
  дергает фрейм-методы для чтения/записи настроек.
- Текущий `localStorage` в `app/pages/settings.vue` — временная **демо**-заглушка; переносится на
  `app.option` через backend (issue #16).

## Этап транспорта Альфы — обязательное (свод ревью)

Чистое ядро готово; при реализации HTTP-транспорта/хранилища на BY-сервере учесть
(вынесено в отдельный issue):

- **Секреты:** `client_secret` только из env (не в логи/URL/ошибки/трейсы); `code`
  одноразовый — обменивать сразу, не кэшировать/не логировать.
- **Токены:** `refresh_token` — зашифрованно (не plaintext на ФС, как в legacy);
  хранить `{access, refresh, expiresIn, issuedAtMs=Date.now()}` по `portalId`/«моей компании»;
  `access` обновлять по `isAccessTokenExpired`. Проверить, требует ли Альфа `redirect_uri` в refresh.
- **State:** генерировать `crypto.randomBytes`, хранить в httpOnly-сессии, сверять timing-safe, одноразово.
- **Ответ выписки:** проверять `errors[]` (не трактовать errored пустой `page` как «нет операций»);
  при необходимости моделировать `statistics[]`.
- **Мультисчёт:** `number[]` до 50 за запрос → `groupBy(account)` при раздельной обработке.
- **Rate-limit 100/мин:** throttle/backoff в cron-опросе (этап 5).
- **Лог:** санитизировать `error_description` от Альфы (CRLF/длина) перед записью.

## Дедуп универсального дела

`crm.activity.todo.add` не имеет нативных `ORIGINATOR_ID/ORIGIN_ID`. Идемпотентность держим
сами: стабильный ключ `account|docId` + текстовый маркер в описании дела
(`[ShefClientBankAlfaBy:<account>|<docId>]`, поиск подстрокой). У `crm.activity.list` нет
fulltext-поиска по описанию, поэтому предпочтительно **хранилище `{dedupKey → activityId}`
на backend**, а не скан списка дел. Это и формат `deadline` (TZ портала, UTC+3 — риск
`WRONG_DATETIME_FORMAT`/сдвига даты) — отдельные issues, обязательны к этапу 4.

## Ожидается от владельца

- **Доступы Альфы (sandbox) получены:** `client_id`, `client_secret`, `redirect_uri`
  (`https://bank-import.bx-shef.by/oauth-alfabank-by/`) + свагеры. Секреты — только в env
  сервера, не в репозитории.
- **Живой прогон OAuth + выписки — на BY-сервере** (из облака недоступно, см. «Ограничение сети»).
- 2026-06-30 — продолжение на **тестовом портале Bitrix24**. Обезличенный пример выписки — по желанию
  (свагер уже даёт модель).
