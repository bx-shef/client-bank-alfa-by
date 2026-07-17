# План рефакторинга — импорт выписки из клиент-банка (Альфа-Банк Беларусь → мультибанк)

> Last reviewed: 2026-07-17

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
| Дела CRM | Настраиваемое дело `crm.activity.configurable.add` (маркер `originId` для дедупа в B24, #259) |
| Доки API | Добываем сами; точные OAuth-параметры — из зарегистрированного приложения на developerhub |
| MCP | Позже, отдельным этапом |
| Фоновая обработка | **BullMQ + Redis** (не Nitro tasks) — под нагрузку и масштабирование: очереди `b24-events`, `bank-fetch`, `file-parse`, `crm-sync` (анализ + запись в B24). Дедуп ретраев по детерминированному `jobId`; Redis — на изолированной сети `queuenet`. **Фаза 1** (сервис+контракты), **Фаза 2** (продюсеры, воркеры, крон+демо-нагрузка, наблюдаемость `/api/queues`) и **масштаб-аут** (роль по env `QUEUE_WORKERS`/`QUEUE_CRON`, сервис `worker` в prod-compose, `--scale worker=N`) — готовы; транспорты в обработчиках наполняются на стадиях 3–6; телеметрия в Grafana — далее. Техсправка (топология, поток, метрики, масштабирование) — [`QUEUES.md`](QUEUES.md) |

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

### Единый интерфейс выписки (контракт для всех банков и тестов)

Каждый банк получается по-своему, но отдаёт **одинаковый выход** — `StatementItem[]`. Это и делает
приложение банк-независимым, и даёт один вид теста на всех (`app/types/statement.ts`):

- **вход** — `StatementFetchQuery`: `providerId` (банк) + `account` (счёт) + `dateFrom/dateTo` (диапазон);
  per-account; батч-запрос по нескольким счетам (`BankProvider.getStatement`) — `StatementQuery` в `banks.ts`;
- **процесс** — получить выписку у провайдера и разобрать (`fetch` — I/O, per-provider; тестируется отдельно);
- **выход** — `StatementItem[]`, контракт нормализатора `StatementNormalizer = (raw, ctx) => StatementItem[]`.
  Поля, которые нужны приложению: `direction` (приход/расход), `counterparty.account`/`.name`/`.unp`
  (счёт+имя+УНП контрагента — для сопоставления компании в CRM), `amount`, `currency`, `acceptDate`/`operDate`
  (дата операции), `purpose` (назначение), `docId` (идемпотентность/дедуп), `account` (наш счёт).

Реализации: `normalizeAlfa` (`alfaStatement.ts`), `normalizePrior` (`priorStatement.ts`), ручной
импорт `normalizeClientBank` (`clientBankStatement.ts`, поверх парсера `clientBankText.ts`) — все три
дают один выход; осталось по `manual` — UI-загрузка файла (#19). **Тест** = raw-ответ провайдера
(fixture) → нормализатор → проверка `StatementItem[]` (`tests/statementInterface.test.ts`,
`tests/alfaStatement.test.ts`, `tests/priorStatement.test.ts`, `tests/clientBankStatement.test.ts`).

## Дорожная карта (по PR, «от малого к сложному»)

1. **[✓ этап 1] Доменное ядро + первый UI-срез (mock).** Типы выписки, абстракция
   `BankProvider`, чистые утилиты (приход/расход, фильтр чата, дедуп), билдер
   дела (ныне `crm.activity.configurable.add`, #259), демо-страница просмотра выписки на mock-данных. Тесты.
2. **[~ этап 2, частично] B24 dual-mode + SDK.** Подключены `@bitrix24/b24jssdk` (+ `-nuxt`),
   `useB24` (init/no-op вне фрейма), layout `clear` (`<B24App>`), `/install` (`init → installFinish`
   + диагностика, редирект на `/` вне фрейма); `/app` и `/settings` инициализируют фрейм
   (`setTitle`/`fitWindow`). **Осталось:** `placement.bind` и точная встройка (плейсменты/хендлер) —
   на тестовом портале; настройки остаются на demo-localStorage до backend (#16).
   **Критерий приёмки при добавлении `placement.bind`/`event.bind`:** handler-URL строится из
   `NUXT_PUBLIC_SITE_URL` (env), не хардкодится и не вводится вручную; перенести из `currency-converter`
   guard «отказ биндить относительный/пустой handler-URL» (repo-variable `NUXT_PUBLIC_SITE_URL` должна
   быть заведена в проде), иначе портал сохранит битую привязку. Обработчик `ONAPPINSTALL`/
   `ONAPPUNINSTALL` — бутстрап: задаётся один раз в регистрации приложения (тоже домен из env),
   не per-portal; рантайм-события приложение регистрирует само в `/install` через `event.bind`.
3. **Backend PoC: OAuth Альфы + выписка.** Чистое ядро (сборка `/authorize`, обмен/обновление
   токена, парсинг callback, нормализация выписки) — **готово и покрыто тестами**
   (`app/utils/alfaOauth.ts`, `app/utils/alfaStatement.ts`). Транспорт (HTTP-вызовы) и живой
   прогон — на деплой-сервере с реальными кредами (см. «Живые прогоны банков»).
   **Авторизация портала + события Б24** (`ONAPPINSTALL`/`ONAPPUNINSTALL`, `application_token`):
   доменное ядро **готово и покрыто тестами** (`app/utils/b24Events.ts`, `app/types/b24Events.ts`) —
   разбор wire-формата, fail-closed вердикт токена, маршрутизация, SSRF-гуард, маппинг кредов портала.
   Транспорт **готов и покрыт тестами**: эндпоинт вебхуков `POST /api/b24/events`, хранилище токенов
   портала с шифрованием refresh (AES-256-GCM), миграции БД (`server/api/b24/events.post.ts`,
   `server/utils/tokenStore.ts`, `server/plugins/migrate.ts`). **Авто-refresh access-токена — готов**
   (конкуренто-безопасно, `ensureAccessToken`+`dbLock`, #35). Осталось — боевые REST-вызовы к порталу при
   опросе (bank-fetch транспорт, этап 5). Контракт и модель (по эталону `bx-synapse`) —
   [`B24_EVENTS.md`](B24_EVENTS.md). См. #12 (безопасность Альфы).
   **Очереди (BullMQ + Redis)** — **Фаза 1 + 2 готовы**: сервис `redis` (сеть `queuenet`),
   контракты (`topology.ts`), продюсеры (`producers.ts`), чистые обработчики (`handlers.ts`,
   с DI — тесты), воркеры (по роли env) + крон с **демо-нагрузкой** (`worker.ts`/`cron.ts`/
   `server/plugins/queue.ts`), 4-я очередь `crm-sync` (анализ→действие в B24), наблюдаемость
   `GET /api/queues` + `scripts/queue-stats.sh`. Транспорты в обработчиках — **живые** (парсер файла,
   B24 REST crm-sync, fetch банка Альфы A9 с глобальным rate-limiter A8); осталось Приор async (A5b). **Масштаб-аут — сделан:** роль контейнера решается env
   (`QUEUE_WORKERS`/`QUEUE_CRON`/`QUEUE_CONCURRENCY`, `server/queue/runtime.ts`), `docker-compose.prod.yml`
   разводит `backend` (HTTP+крон) и сервис `worker` (`--scale worker=N`); телеметрия в Grafana — далее.
4. **Поиск компании по корр-счёту + запись настраиваемого дела.**
   Воркер `crm-sync` → поиск компании → `crm.activity.configurable.add`.
   **Дедуп записи при редоставке (at-least-once):** дедупа ВНУТРИ батча (в памяти джоба, `handlers.ts`)
   мало — при падении/ретрае воркера батч пройдёт повторно. Идемпотентность держит **B24-маркер** (#259):
   настраиваемое дело несёт `originatorId`+`originId`, перед записью ищем его (`crm.activity.list`) —
   нашли → пропускаем; локального стора нет. Это разные вещи: (а) дедуп постановки по `jobId` — есть;
   (б) дедуп записи в CRM при редоставке — маркер в B24.
   **Статус — стадия 4 в основном готова:** поиск компании (`companyLookup.ts`), read-before-write
   (`findActivityByMarker`) в `handleCrmSyncJob` и **живые транспорты** `findCompany`→`findCompanyByAccount` /
   `writeActivity`→`writeConfigurableActivityViaRest` (`crm.activity.configurable.add`)
   по per-portal `RestCall` (через `resolvePortalCall` — SDK-резолвер #191, мемоизация на портал на джобу),
   с гейтом демо-счётов (`isDemoAccount`) и TZ-aware
   `deadline` (UTC+3, `toPortalDeadline`, #10) — **готовы, покрыты тестами**. Осталось: проверка на живом
   портале (#90) и обработка `unmatched`-операций (#91). **Rate-limit REST на `crm-sync`** — встроенный
   RestrictionManager SDK-транспорта (единственный транспорт, дефолт; ручной `callRest`-резолвер и флаг
   `QUEUE_SDK_TRANSPORT` удалены — см. `docs/QUEUES.md` §REST-бюджет).
   Плюс на очередях выставлены `attempts`/`backoff`/`removeOnComplete/Fail` (см. `connection.ts`).
5. **Cron-опрос через очередь.** Планировщик кладёт в `bank-fetch` job на портал/счёт (fan-out по
   `portal_tokens`); воркеры (масштабируются репликами) тянут выписку, соблюдая rate-limit Альфы
   (100/мин), нормализуют, разделяют приход/расход, применяют фильтры по р/счёту и теме платежа.
   Статус последнего импорта — в БД (питает `GET /import/status`).
6. **Сообщения в чат** (выбор чата в настройках; не показывать по правилам) — из воркера после записи в CRM.
   **Ядро готово:** `buildChatMessage` (`chatMessage.ts`, BB-текст + нейтрализация внешних полей) +
   `notifyChatViaRest` (`chatNotifyWrite.ts`, `im.message.add`) + фильтр `shouldNotifyChat`. Осталась
   проводка `notifyChat` вместе с хранением настроек (#16: dialog id + правила); нюансы — в worker TODO.
7. **Docker + деплой.** [✓ фронтенд] Лендинг + B24-iframe-UI как статика за nginx
   (GHCR + Watchtower + nginx-proxy, как `currency-converter`) — `Dockerfile` (target `runner`),
   `nginx.conf` (CSP без `unsafe-inline` через `scripts/csp-hashes.mjs`), compose-файлы, CI
   `docker-build`/`deploy`. [✓ backend в проде] `Dockerfile` target `backend` (node-сервер) + `db`
   (Postgres); CI собирает/пушит **два** образа (matrix `runner`+`backend`) в GHCR; прод-compose
   поднимает `app`+`backend`+`db` на **одном домене** — nginx `app` проксирует `/api/*` в backend
   (вебхук B24 на `https://<DOMAIN>/api/b24/events`, без CORS). Детали — [`DEPLOY.md`](DEPLOY.md).
8. **MCP-сервер** по выписке.
9. **Приорбанк + ручная загрузка выписок** (два новых источника рядом, поверх абстракции
   `BankProvider`). Приорбанк — онлайн (Open Banking СПР); **ручная загрузка** — пользователь
   заливает стандартный файл выписки, он идёт в очередь `file-parse` → разбор/нормализация →
   `crm-sync` (тот же путь, что и онлайн-выборка, без опроса банка).
   [~ Prior] Open Banking СПР **проверен на sandbox живьём**; нормализатор `normalizePrior`
   (`app/utils/priorStatement.ts`) **готов и покрыт тестами**; live-recon — `scripts/prior-oauth-test.mjs`.
   OAuth/DCR/consent-ядро **вынесено** в чистый `app/utils/priorOauth.ts` (URL/тела/claims + парсеры,
   без `node:crypto` — подпись/транспорт у вызывающего, аналог `alfaOauth.ts`), под тестами
   `tests/priorOauth.test.ts`; скрипт — тонкий потребитель (canonical-контракт синхронно, как у Альфы).
   **Осталось:** прод-СКЗИ — #41; серверный движок Приора (backend) на базе `priorOauth.ts` — далее.
   Ручной импорт (`manual`): нормализация **сделана для двух форматов** (диспетчер
   `app/utils/manualImport.ts`) — `***** ^Type=` (`normalizeClientBank`, проверен на реальных
   выгрузках `Type=3`/`Type=4`: дедуп `DocID`→`OperationID`→`Num|DocDate` — `OperationID` нужен в
   `Type=4`, где `Num` не уникален, иначе теряется операция, #73) и **1С-обмен**
   `1CClientBankExchange` (`normalizeOneC` — универсальный формат 1С, РФ+РБ, #21). Осталось —
   UI-загрузка файла + остаточный рефактор парсера `***** ^Type=` (#19).
10. **Контур обратной связи (клиенты/сотрудники + ИИ).** Замкнуть петлю «пользователь → задача →
    ИИ-разбор → приоритеты/правки», чтобы реальные проблемы разбора выписок собирались и обрабатывались.
    - **Сотрудник → GitHub issue (#61).** На странице результата импорта (авто и ручной) — **блокирующий**
      шаг обратной связи: оценка 👍/👎/💡 + комментарий; `POST /api/feedback` заводит issue. **Durable
      outbox** (очередь поверх нашей шины `server/queue/*` или память): при сбое (сеть/5xx/429) — `202` +
      ретраи с backoff; постоянные ошибки (401/403/404) → `502`. **Без PII по умолчанию** — в issue только
      метаданные (провайдер, счёт, кол-во операций, код исхода), **файл выписки не прикладываем
      автоматически**; исходный файл идёт в issue **только если сотрудник сам его приложил** к отзыву.
      Чистое ядро сборки issue (текст/лейблы) — в `app/utils/*` под тесты; env `GITHUB_*` + интервал
      дренера. Референс — Procure AI (`postroyka/purchase-ai-chat`, `feedback-outbox.js`). Зависит от
      страниц импорта (ручной — #19/#21; авто — стадии 4–6).
    - **ИИ-контур (reporting-kit).** Вендорный бандл [`reporting-kit/`](../reporting-kit/) уже в репозитории:
      ИИ-агент + отчёты в Telegram (навыки `/report-status`, `/report-digest`, `/report-questions`,
      `tg-send.sh`), опирается на срез состояния [`project-map.md`](project-map.md). Замыкание петли:
      обратная связь/issues → ИИ-триаж и дайджест → вопросы владельцу/приоритеты → правки. Осталось —
      завести Telegram (`.env` с токеном, локально) и подключить агента к потоку issues из `/api/feedback`.
    - **MCP по выписке (стадия 8)** — часть того же контура: ИИ получает доступ к данным выписки/статусу
      импорта программно (для ответов и триажа).

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

## Живые прогоны банков (требования)

Хосты Альфы (`developerhub.alfabank.by:8273` / `ibapi2.alfabank.by:8273`) и Приора
(`api.priorbank.by:9344`) достижимы из среды деплоя. Для **живого** прогона OAuth/выписки нужны
креды в git-ignored `.env.alfabankby`/`.env.priorbank` (client_id/secret, зарегистрированный
`redirect_uri`) — их держит владелец, поэтому живой раунд гоняется на деплой-сервере
(`bank-import.bx-shef.by`), а не в dev-сессии. Чистое ядро (билдеры URL/тел, нормализаторы) покрыто
юнит-тестами. **Приор-прод** дополнительно требует СКЗИ АВЕСТ + сертификат ГосСУОК на `:9345`
(issue #41) — это крипто-требование РБ, не сетевое ограничение; Альфа-прод его не требует.

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

## Дедуп дела через маркер в B24 (#259)

`crm.activity.configurable.add` (**настраиваемое дело**) принимает `originatorId`+`originId`, а
`crm.activity.list` **фильтрует** по ним — поэтому идемпотентность живёт **в самом B24**: перед
записью ищем маркер (`ORIGINATOR_ID`+`ORIGIN_ID`, где `ORIGIN_ID`=`account|docId`), нашли →
пропускаем. Backend-стора `{dedupKey → activityId}` больше нет (ранний `crm.activity.todo.add`
маркера не имел, поэтому исходно держали стор — issue #9; переведено на маркер в #259). Формат
`deadline` — TZ портала (UTC+3, `toPortalDeadline`). ⚠ `configurable.add` — только OAuth-контекст
(класс #79), вебхуком не проверить (`pnpm activity:test`).

## Ожидается от владельца

- **Доступы Альфы (sandbox) получены:** `client_id`, `client_secret`, `redirect_uri`
  (`https://bank-import.bx-shef.by/oauth-alfabank-by/`) + свагеры. Секреты — только в env
  сервера, не в репозитории.
- **Живой прогон OAuth + выписки — на деплой-сервере** с реальными кредами (см. «Живые прогоны банков»).
- 2026-06-30 — продолжение на **тестовом портале Bitrix24**. Обезличенный пример выписки — по желанию
  (свагер уже даёт модель).
