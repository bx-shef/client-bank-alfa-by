# CLAUDE.md

> Last reviewed: 2026-07-02

Приложение Bitrix24 для импорта выписки из клиент-банка: онлайн из Альфа-Банка
Беларусь (портал может быть в любой стране) или ручной загрузкой любой стандартной
выписки. Публичная страница — лендинг (SSG). Появилась серверная часть (Nitro):
эндпоинт вебхуков Bitrix24 (`/api/b24/events`) + хранилище токенов портала.

> **Статус:** рефакторинг legacy-приложения (план — [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md)).
> Репозиторий: **frontend** (публичный лендинг SSG + B24-iframe-UI) **и backend** (Nitro-сервис:
> приём событий установки/удаления Б24, учёт авторизации портала; дальше — OAuth Альфы, опрос,
> запись дел/чата, MCP). Заложено доменное ядро (типы выписки, абстракция банк-провайдеров, чистые
> утилиты, билдер дела, разбор/маршрутизация событий Б24) и демо-страница на mock-данных; backend
> событий Б24 реализован (этап 3, слайс), реальная интеграция Альфы — далее. Деплой: статика лендинга
> за nginx + отдельный backend-сервис с Postgres (как `bx-synapse`). Эталон стека — `currency-converter`.

## Стек

- **Nuxt 4** (статическая генерация, `nuxt generate`)
- **Vue 3** — `<script setup lang="ts">`
- **TypeScript** (строгий), **Tailwind CSS v4**, **Bitrix24 UI** (`b24ui`)
- **Bitrix24 JS SDK** (`@bitrix24/b24jssdk` + `-nuxt`) — встройка в портал (dual-mode, `/install`)
- **Vitest** — два проекта: `unit` (node, чистые функции) и `nuxt`
  (`@nuxt/test-utils` + happy-dom, composables и компоненты)

## Команды

```bash
pnpm dev          # дев-сервер
pnpm lint         # ESLint
pnpm typecheck    # vue-tsc --noEmit
pnpm test         # Vitest (оба проекта; быстрый прогон node: pnpm test --project unit)
pnpm generate     # сборка статики (nuxt generate, SSG) — то же гоняет CI
```

Перед пушем прогоняй `pnpm check` (= `lint` + `typecheck` + `test`) или запусти
готовый скрипт: `bash scripts/check-app.sh` (Linux/macOS) / `pwsh scripts/check-app.ps1`
(Windows) — он сразу отдаёт итог. Те же проверки гоняет CI (порядок шагов не важен —
они независимы).

## Архитектура

- `app/app.vue` — **корень Nuxt** (не страница): `useHead`/SEO (вкл. `og:image`/`twitter:card` →
  `public/og.png`, абсолютный URL из `siteUrl` в проде)/`theme-init`, рендерит `<NuxtLayout>`/`<NuxtPage>`.
- `app/app.config.ts` — нативный colorMode b24ui (`colorMode: true`, `colorModeInitialValue: 'auto'`);
  без этих top-level ключей `useColorMode()` = no-op stub.
- `app/assets/css/main.css` — Tailwind v4 + импорт темы b24ui.
- `app/pages/index.vue` — публичная страница лендинга (hero + преимущества + подвал). Standalone,
  без `clear`-layout (вне портала), без `B24App`.
- `app/pages/app.vue` — in-portal просмотр выписки на **b24ui** (по образцу B24-списка «Последние
  операции»): полоса статуса (`ImportStatusBanner`), карточка «Последние операции» с чип-фильтром
  Все/Приходы/Расходы (счётчики в подписи), шапкой колонок «Операция/Сумма», `OperationList` и
  `B24Pagination` (при переполнении страницы). Шестерёнка открывает **слайдер настроек снизу**
  (`B24Slideover` `side="bottom"` с `SettingsForm` — удобно в узком iframe/на мобильном) — основной
  вход; ниже — карточка тестовой настройки `app.option`.
  Демо-данные. Layout `clear`, `useB24().init()`, в портале — `setTitle`/`fitWindow` (try/catch).
  Итоги приходов/расходов — компактной строкой над списком. Интерактив (раскрытие строки,
  слайдер настроек) автотестами не покрыт — проверяется вручную в портале; `B24Pagination` видна
  только на реальных данных (демо-операций мало).
- `app/components/SettingsForm.vue` — форма настроек (подключение банка `B24Input`; уведомления —
  `B24Select` чата + `B24Switch` приходы/расходы; исключения — `B24Textarea`) + живой предпросмотр
  («что попадёт в чат», `B24Badge`). Один компонент для двух точек входа: слайдер на `/app` и
  полная страница `/settings`. Автосейв в localStorage (демо, ключ API не сохраняется), реальное
  хранение — backend (#16).
- `app/pages/settings.vue` — тонкая страница-fallback (прямая ссылка): заголовок + `B24Alert` +
  `<SettingsForm/>`. Layout `clear` + `useB24().init()`. Роут `/settings` — в `nitro.prerender.routes`.
- `app/pages/install.vue` — обработчик установки B24 (layout `clear`): `init` → `event.bind`
  (`ONAPPINSTALL`/`ONAPPUNINSTALL` → `${siteUrl}/api/b24/events`, до `installFinish` — так текущая
  установка доставляет `application_token`) → `installFinish` (+ диагностика портала, блок «События»);
  вне фрейма — редирект на `/`. Билдер батча привязок — чистый `app/utils/b24EventBind.ts`
  (идемпотентен: пропуск верных, перепривязка устаревших). Требует `NUXT_PUBLIC_SITE_URL` в проде
  (иначе откажется биндить относительный URL — ошибка с retry). `placement.bind` **пока не делаем** —
  плейсменты добиваем на тестовом портале (см. план).
- `app/layouts/clear.vue` — минимальный layout (`<B24App>` для тем/тостов, light/dark) под in-portal-страницы
  (`/install`, `/app`, `/settings` в iframe) **и** standalone-страницы оператора (`/login`, `/queues`).
- `app/config/b24.ts` — чистые константы встройки: `B24_REQUIRED_SCOPES` (`crm`, `im`, `user_brief`,
  `placement`), `B24_EVENT_HANDLER_PATH` (`/api/b24/events`), `B24_BOUND_EVENTS` (события для `event.bind`).
- `app/composables/useB24.ts` — обёртка над `B24Frame`: `init()` (идемпотентен; no-op вне фрейма —
  когда нет `window.name`), `isInit()`, `get()`/`getOrThrow()`, `targetOrigin()`, `getRequiredRights()`.
- `app/composables/useChatRules.ts` — реактивные настройки (localStorage, без `apiKey`); производит
  `rules: ChatNotifyRules` (из `app/utils/statement.ts`).
- `app/components/ImportStatusBanner.vue` — полоса статуса импорта (`B24Alert`, цвет = состояние:
  ok/running/error); «Обновлено N минут назад», «+N операций», «Записано в CRM · N в чат», при ошибке —
  действие «Проверить настройки». `app/components/OperationList.vue` — список операций строками
  (группировка по дню, плитка-направление ↑приход/↓расход, контрагент+назначение, сумма со знаком
  и цветом; строка раскрывается в `B24Collapsible` → `B24DescriptionList` с реквизитами; пустое состояние).
- `app/types/importStatus.ts` + `app/utils/importStatus.ts` (relative-time RU `formatRelativeTime`,
  `pluralRu`, `importStateMeta`) + `app/composables/useImportStatus.ts` — модель и презентация статуса
  импорта; mock на клиенте до backend-опроса (#5), форма ответа = будущий `GET /import/status`.
- `app/components/BuildFooter.vue` (+ `app/utils/build.ts`, покрыт тестами) — подвал лендинга и
  `/app`: автор + ссылка на **коммит сборки** (`сборка <sha>` → GitHub commit); sha из
  `NUXT_PUBLIC_COMMIT_SHA` (CI передаёт `github.sha`, в dev — «dev»).
- `app/composables/useAppSettings.ts` — тестовая настройка уровня приложения: берёт из фрейма
  **access-токен + домен** и шлёт их в `/api/settings` (GET/POST) заголовками
  `Authorization: Bearer` + `X-B24-Domain`; backend этим токеном пишет/читает `app.option`. Вне
  портала инертна (токена нет). member_id UI не доверяет — изоляция на стороне B24 (токен скоуплен к порталу).
- **Авторизация оператора** (вход для сотрудников в служебную зону — `/queues`, дальше страницы импорта;
  лендинг и B24-встройку не закрывает) — [`docs/AUTH.md`](docs/AUTH.md). Чистое ядро `server/utils/session.ts`
  (`resolveAuthConfig`/`checkCredentials` constant-time, `signSession`/`verifySession` — HMAC-подпись cookie;
  статус-матрикс роутов `decideLogin`/`decideLogout`/`sessionStatus` — тонкие `server/api/auth/*` только I/O,
  тестируются без сервера; тесты). Роуты `server/api/auth/login|logout|session`. Клиент — `app/composables/useAuth.ts`,
  форма `app/pages/login.vue` на **b24ui** (`B24Card`/`B24Input`/`B24Button`/`B24Alert`, layout `clear` → light/dark),
  публичная `noindex` (маппинг ошибок → сообщение в чистом `app/utils/loginError.ts`, покрыт тестом). Гвард
  `app/middleware/auth.ts` (клиентский редирект; реальная защита — на API), а
  `app/components/AuthGate.vue` прячет контент служебных страниц за «Проверка доступа…» до подтверждения сессии
  (SSG-статику красит колор-мод, поэтому иначе защищённый контент мелькал бы до редиректа). Cookie `cba_sess`
  HttpOnly/SameSite=Lax/Secure, CSRF-заголовок `X-CBA-Auth`. Пароль пуст ⇒ вход выключен. Модель портирована
  из `postroyka/purchase-ai-chat`. B24 silent-сессия — далее.
- `app/config/chat.ts` — заглушка списка чатов (`MOCK_CHATS`) до подключения B24 SDK.
- `app/utils/landing.ts` — чистая логика лендинга (`LANDING_*`, `copyrightYears`), покрыта тестами.
- **Доменное ядро (чистое, переносимо в backend, покрыто тестами):**
  - `app/types/statement.ts` — модель выписки (`Statement`/`StatementItem`/`StatementParty`,
    `OperationDirection`, `BankProviderId`) + **единый интерфейс**: `StatementFetchQuery` (вход:
    банк/счёт/диапазон; батч-`StatementQuery` для `BankProvider` — в `banks.ts`),
    `StatementNormalizer` (`raw,ctx → StatementItem[]`) — один выход на все банки (см. REFACTOR_PLAN
    «Единый интерфейс выписки»).
  - `app/config/banks.ts` — абстракция `BankProvider` + реестр банков (Альфа/Приор/ручной импорт).
  - `app/utils/statement.ts` — классификация приход/расход, дедуп (`account|docId`), фильтр чата,
    `parseRuleLines` (textarea → массив правил).
  - `app/utils/activity.ts` — билдер **универсального дела** (`crm.activity.todo.add`) + origin-маркер для дедупа.
  - `app/utils/alfaOauth.ts` — OAuth 2.0 Альфы (Authorization Code + refresh): URL/тела запросов, парсинг.
  - `app/utils/priorOauth.ts` — Open Banking (СПР) Приора: чистое OAuth/DCR/consent-ядро (префиксы API,
    `buildPriorAuthorizeUrl`/claims/тела токенов/`buildConsentRequest`/`buildResourceRequestBody` + парсеры
    `parsePriorTokenResponse`/`extractIntentId`/`extractResourceId`/`extractAccounts`). Без `node:crypto` —
    подпись `request`-JWT и транспорт у вызывающего (браузеро-безопасно, аналог `alfaOauth.ts`). Три имени,
    совпадающие с Альфой, несут префикс `Prior` (Nuxt авто-импортит `app/utils/**` в один неймспейс).
  - `app/utils/alfaStatement.ts` — нормализация выписки Альфы (`partner.accounts 1.2.0`) в `StatementItem`
    (`normalizeAlfa` — контракт `StatementNormalizer`).
  - `app/utils/priorStatement.ts` — нормализация операции Приорбанка (Open Banking СПР) в `StatementItem`
    (`normalizePrior`); подтверждено на живом sandbox — см. [`docs/PRIOR_API.md`](docs/PRIOR_API.md).
  - `app/utils/clientBankText.ts` — парсер **формата** текстовой выписки client-bank (CP1251,
    `***** ^Type=`) → секции/строки; для провайдеров `prior-by`/`manual`. Портированный пример,
    вход ограничен по размеру (`MAX_CLIENT_BANK_CHARS`, DoS-гард #19); остаточный рефактор
    (словари ключей) — issue #19.
  - `app/utils/clientBankStatement.ts` — нормализация разобранной текстовой выписки в `StatementItem`
    (`normalizeClientBank` — контракт `StatementNormalizer`; приход/расход, валюта нац/инвалюта,
    контрагент, `account|docId`-дедуп). Провайдер `manual` (и файловый путь `prior-by`) — issue #19.
    Проверено на образцах `tests/fixtures/client-bank/` (BYN `Type=400`, CNY `Type=600`) и на реальных
    выгрузках двух форматов: `Type=3` «за день» (`demo-type3-vpsk`) и `Type=4` «за период»
    (`demo-type4-alfa`). Ключ дедупа (`rowDocId`): `DocID` → `OperationID` (уникальный id в `Type=4`,
    где `Num` повторяется — иначе коллизия/потеря операции, #73) → фолбэк `Num|DocDate`. BYN-дефолт
    для старых 13-значных BY-счетов (`isBelarusianAccount`); BIC контрагента из `Cod`/`Code` — только
    BIC-образный токен (`Code` бывает и числовым кодом валюты).
  - `app/utils/oneCExchange.ts` + `app/utils/oneCStatement.ts` — формат обмена 1С «Клиент-банк»
    (`1CClientBankExchange`, версии 1.01–1.03): парсер секций (`parseOneCExchange`) + нормализатор
    (`normalizeOneC` — контракт `StatementNormalizer`; направление по «наш счёт = плательщик/получатель»,
    валюта из кода счёта RU/BY, дедуп `Номер|Дата`). Второй `manual`-формат — issue #21.
  - `app/utils/manualImport.ts` — точка входа ручной загрузки: детект формата (`detectManualFormat`)
    → парсер+нормализатор (`normalizeManualStatement`: `1CClientBankExchange` или `***** ^Type=`).
  - `app/utils/mockStatement.ts` — демо-данные для UI до реальной интеграции.
  - `app/types/b24Events.ts` + `app/utils/b24Events.ts` — события Б24 (`ONAPPINSTALL`/
    `ONAPPUNINSTALL`): разбор wire-формата (`parseBracketForm`, PHP-скобки), вердикт
    подлинности `application_token` (`appTokenVerdict`, fail-closed, constant-time),
    SSRF-гуард `isSafeClientEndpoint`, маппинг кредов портала `extractPortalCredentials`.
    Верификация+решение для реального события — в backend (`processB24Event`). Учёт авторизации/
    события/брокер — карточка [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md) (модель по backend `bx-synapse`).
- **Backend (Nitro, `server/`):** серверная часть в том же приложении (как `bx-synapse`).
  - `server/api/b24/events.post.ts` — эндпоинт вебхуков Б24: `readRawBody` → `parseBracketForm`
    → `handleEventRequest` (верификация без записи в БД) → кладёт пакет в очередь `b24-events`
    (register/unregister; refresh шифруется перед Redis). **Консьюмер — единственный писатель.**
    Онлайн-события Б24 **не ретраятся** — поэтому если очередь недоступна (Redis нет/упал), роут пишет
    в БД **синхронным фолбэком** (тот же токен-стор), чтобы установка/удаление не потерялись.
  - `server/api/health.get.ts` — публичный liveness-эндпоинт `GET /api/health` →
    `{ status, time, commit, commitUrl }` (коммит = `NUXT_PUBLIC_COMMIT_SHA`, как в подвале).
    Без секретов; на нём же построен docker `healthcheck` backend'а. Чистый билдер —
    `healthInfo` в `app/utils/build.ts` (покрыт тестами).
  - `server/utils/b24EventsHandler.ts` — чистый `processB24Event(payload, deps)` — **только чтение**
    (вердикт `application_token`, fail-closed → 200/400/403/503) и решение `action` (`register`/
    `unregister`); ничего не пишет. Роут кладёт `action` в очередь, консьюмер применяет. **Удаление
    приложения всегда стирает всё** для портала (флаг `CLEAN` не смотрим). Покрыт тестами.
  - `server/utils/tokenStore.ts` — хранилище токенов портала над инъектируемым `QueryFn`
    (`save`/`get`/`getApplicationToken`/`delete`, write-once `application_token`). Тесты на fake-query.
  - `server/utils/activityDedupStore.ts` — персистентный стор дедупа дел `{dedupKey→activityId}`
    (issue #9, таблица `activity_dedup`, скоуп по `member_id`): `getActivityId`/`rememberActivity`
    (write-once, `ON CONFLICT DO NOTHING`)/`deleteDedupForPortal`. Над `QueryFn`, тесты на fake-query.
    Переживает рестарт воркера и повторную доставку джобы (in-batch `Set` — нет). Проводка
    read-before-write вокруг `writeActivity` — стадия 4; удаление приложения чистит и его (always-purge).
  - `server/utils/secretCrypto.ts` — AES-256-GCM шифрование `refresh_token` (ключ `B24_TOKEN_ENC_KEY`).
  - `server/utils/envCheck.ts` (+ плагин `server/plugins/envCheck.ts`) — валидация env на старте
    (чистая `checkBackendEnv`, тесты): `B24_TOKEN_ENC_KEY` есть и декодируется в 32 байта; `DATABASE_URL`
    задан; `B24_APPLICATION_TOKEN` не плейсхолдер (`CHANGE_ME` и т.п. → реальный токен не совпадёт → 403);
    отсутствие `B24_CLIENT_ID/SECRET` — warning (приём событий работает, refresh/`app.option` — нет).
    Логирует, **не роняет** процесс (конвенция как `authGuard.ts`); no-op при prerender.
  - `server/db/client.ts` — ленивый pg-Pool (`DATABASE_URL`) + схема (`portal_tokens`, `activity_dedup`);
    `server/plugins/migrate.ts` — идемпотентная миграция на старте.
  - **Очереди (BullMQ + Redis) — шина под нагрузку/масштабирование** (`server/queue/`;
    справка-обзор с диаграммой потока и метриками — [`docs/QUEUES.md`](docs/QUEUES.md)):
    - `topology.ts` — чистые контракты: очереди `b24-events`/`bank-fetch`/`file-parse`/`crm-sync`,
      payload'ы (`EventJob`/`FetchJob`/`ParseJob`/`CrmSyncJob`), идемпотентные `*JobId` (дедуп ретраев). Тесты.
    - `connection.ts` — ленивый `getQueue(name)`; передаёт BullMQ **опции** (парсит `REDIS_URL`), а не
      ioredis-инстанс — нет прямой зависимости от ioredis и связки версий. Гуард `queueEnabled()`.
    - `producers.ts` — `enqueueEvent/Fetch/Parse/CrmSync` (no-op без Redis).
    - `handlers.ts` — **чистые обработчики с DI** (тесты): `handleEventJob` регистрирует
      (`savePortal`, ONAPPINSTALL) / удаляет (`deletePortal`, ONAPPUNINSTALL — всегда) портал;
      fetch/parse → нормализованный батч в `crm-sync`; `crm-sync` дедупит in-batch (`account|docId`),
      затем **read-before-write** по персистентному стору (#9): `getActivityId`→skip уже записанных,
      иначе `findCompany`→`writeActivity` (возвращает id дела)→`rememberActivity`→`notifyChat`; счётчики
      `created/skipped/unmatched`. CRM-депсы берут `memberId` явно (депсы строятся один раз).
      Транспорты (Альфа/Приор/парсер/REST-запись) — заглушки до стадий 3–6; стор дедупа уже живой.
    - `worker.ts` — BullMQ-воркеры на обработчики (`liveHandlerDeps`; `savePortal` расшифровывает
      refresh и пишет `saveToken`). CRM-sync транспорты **живые**: `findCompany`→`findCompanyByAccount`,
      `writeActivity`→`writeActivityViaRest` (`crm.activity.todo.add`) по per-portal `RestCall`
      (`makePortalRestCall`: `getToken`+`ensureAccessToken`+`callRest`), с **гейтом демо-счётов**
      (`isDemoAccount` — демо-нагрузка не пишет в реальный портал) и skip без токена портала.
      `cron.ts` — план опроса (`planFetches`) + **демо-нагрузка** (`buildDemoFetchJobs`/`demoItems`,
      `isDemoAccount`).
    - `server/plugins/queue.ts` — на старте backend поднимает воркеры **в процессе** и (если
      `DEMO_LOAD_N>0`) крон каждые `CRON_INTERVAL_MIN` кладёт синтетические fetch-джобы (демо потока).
      Масштаб-аут (отдельный воркер-контейнер) — следующий шаг (см. REFACTOR_PLAN).
    - **Наблюдаемость сейчас:** чтение счётчиков — общий `server/queue/stats.ts` (`readQueueCounts`,
      DI, тесты). Два guard'а: `GET /api/queues` (`server/api/queues.get.ts`) — токен `B24_APPLICATION_TOKEN`
      **только заголовком** `X-Check-Token` (без `?token=` в логах), nginx `deny all`, для консоли
      (`scripts/queue-stats.sh`); `GET /api/ops/queues` (`server/api/ops/queues.get.ts`) — по **сессии
      оператора** (`operatorAllowed`), это путь для браузера. **Живой график** — страница `/queues`
      (`app/pages/queues.vue`, за `middleware: auth` + обёртка `AuthGate`, layout `clear`) →
      `app/components/QueueMonitor.vue` в хроме **b24ui** (`B24Card`/`B24Button`/`B24Select`, иконки
      `@bitrix24/b24icons-vue`) на **ECharts** (Apache-2.0, tree-shaken: `echarts/core` +
      Line/Grid/Tooltip/Legend/Canvas, динамический импорт; оси/сетка перекрашиваются под light/dark по
      классу `.dark`), чистая логика ряда — `app/utils/queueChart.ts` (тесты). Ряд строит клиент (снапшот без истории)
      из `/api/ops/queues`; `?demo=1` — превью на синтетике (для скриншотов/дев). Глубокая телеметрия
      (Prometheus-экспортёр BullMQ / bull-board / Grafana) — issue #78. Обзор — [`docs/QUEUES.md`](docs/QUEUES.md).
    Redis — сервис в compose на изолированной сети `queuenet` (`internal: true`, том `redisdata`).
  - `server/utils/companyLookup.ts` — **чистое ядро поиска компании CRM по счёту контрагента** (DI над
    `RestCall`, тесты): `crm.requisite.bankdetail.list` по `RQ_ACC_NUM`→фолбэк `RQ_IIK` (ИИК Беларуси) →
    id реквизитов → `crm.requisite.list` (`ENTITY_TYPE_ID=4`) → id компании. Проведено в `crm-sync`
    `findCompany`. `null` ⇒ операция `unmatched`, дело не пишется.
  - `server/utils/portalRest.ts` — `makePortalRestCall(memberId, deps)`: связывает `RestCall` с порталом
    (загрузка токена → `ensureAccessToken` → `callRest` с домен+access). DI, тесты; `null` без токена.
  - `server/utils/crmActivityWrite.ts` — чистое `writeActivityViaRest(item, companyId, call)`:
    `buildTodoActivity`→`crm.activity.todo.add`→`extractActivityId` (id дела из `{result:{id}}`). Тесты.
  - `app/utils/chatMessage.ts` — чистый `buildChatMessage(item)` (BB-текст операции для чата) +
    `server/utils/chatNotifyWrite.ts` — `notifyChatViaRest(item, dialogId, call)` (`im.message.add`,
    `URL_PREVIEW=N` → `extractMessageId`, id — целое >0). **Ядро стадии 6** (чат-уведомления), тесты.
    **Безопасность:** назначение/контрагент из выписки контролирует плательщик, поэтому внешние поля
    прогоняются через `neutralizeBb` (BB-скобки → полноширинные) — иначе `[url=…]`/упоминания/кнопки
    попали бы в чат. Фильтр «что в чат» — `shouldNotifyChat` (в `statement.ts`). Проводка `notifyChat`
    ждёт хранения настроек (#16: dialog id + правила из `app.option`; see worker TODO про 3 нюанса) —
    до этого заглушка.
  - **Настройка уровня приложения (`app.option`) — серверным REST по токену портала:**
    `server/utils/b24Oauth.ts` (refresh access-токена, `B24_CLIENT_ID/SECRET`, чистые URL/parse),
    `server/utils/b24Rest.ts` (`callRest`/`restUrl`), `server/utils/ensureAccessToken.ts`
    (refresh при истечении), `server/utils/appSettings.ts` (чистый `readAppSetting`/`writeAppSetting`
    с DI — изоляция по `memberId`, используется серверной проверкой), `server/utils/settingsHandler.ts`
    (чистый `{status,body}` для UI-роутов по фрейм-токену), `server/utils/liveDeps.ts` (проводка).
    UI-роуты `server/api/settings.get.ts`/`settings.post.ts` (`/app` через `useAppSettings`)
    **аутентифицируются фрейм-токеном** (`Authorization: Bearer` + `X-B24-Domain`) — B24 скоупит
    токен к порталу вызывающего, `member_id` не доверяется, чужой `app.option` недостижим. **Серверная
    проверка** `server/api/b24/app-option-check.get.ts` (guard `B24_APPLICATION_TOKEN`, читает `app.option`
    по сохранённому токену без фрейма — для `scripts/check-app-option.sh`; наружу не открыта, nginx `deny all`).
  - Backend — отдельный docker-сервис (`Dockerfile` target `backend`, `nuxt build`), Postgres рядом.
    В проде — **один домен**: nginx `app` проксирует `/api/*` в `backend:3000` (вебхук B24 на
    `https://<DOMAIN>/api/b24/events`, без CORS); CI пушит два образа (matrix `runner`+`backend`),
    `docker-compose.prod.yml` поднимает `app`+`backend`+`db`. Деплой/контракт —
    [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md), [`docs/DEPLOY.md`](docs/DEPLOY.md).

  Ссылки на доку Альфы — [`docs/ALFA_API.md`](docs/ALFA_API.md); по Приорбанку/текстовой выписке —
  [`docs/PRIOR_API.md`](docs/PRIOR_API.md).
- **Скрипты разведки (dev, не часть SSG):**
  - `scripts/alfa-oauth-test.mjs` (`pnpm oauth:test`) — живой прогон OAuth/выписки Альфы по
    `.env.alfabankby` (sandbox), маскировка секретов; см. `docs/ALFA_API.md`.
  - `scripts/prior-oauth-test.mjs` (`pnpm prior:test`) — живой прогон Open Banking (СПР) Приорбанка
    по `.env.priorbank` (sandbox): `--gen-key`/`--oidc`/`--dcr`/consent→authorize→выписка; см. `docs/PRIOR_API.md`.
  - **Оба банк-скрипта импортят чистые OAuth-ядра напрямую** (`alfaOauth.ts`/`priorOauth.ts`) —
    инлайн-копий билдеров URL/тел/claims больше нет, дрейф невозможен by construction (#45; раньше
    так возник баг auth Альфы #26). Node стрипает `.ts`-типы на лету (`--experimental-strip-types`
    в `oauth:test`/`prior:test`; ядра без импортов, лоадер не нужен). RS256-подпись и `node:crypto` —
    у Приора локально. Реальный путь скриптов теперь покрыт тестами ядер (`tests/{alfa,prior}Oauth.test.ts`).
  - `scripts/parse-statement.ts` (`pnpm parse:statement <файл>`) — разбор ручной выписки через
    канонический диспетчер `manualImport.ts` (оба формата: client-bank `***** ^Type=` и
    `1CClientBankExchange`) → печатает единый `StatementItem[]` (+ секционный вид для текстового
    формата). Node ≥ 22, нативный TS-стриппинг; `~/`-алиасы резолвит `scripts/lib/alias-loader.mjs`.
  - `scripts/lib/*.mjs` — общая обвязка обоих банк-скриптов (одинаковые запуск/проверка/вывод):
    `demo-utils`/`env` (чистые, покрыты тестами), `http` (единый `httpRequest`, TLS-проверку не отключает),
    `cli` (цвета `C`, префиксы `ok/warn/err/head`, `die`, кросс-платформенный `openBrowser` — URL-гейт
    `openBrowser` покрыт тестом `tests/cliOpenBrowser.test.ts`, #45).
- `tests/*.test.ts` — Vitest (node) на чистые утилиты.
- `tests/nuxt/**/*.test.ts` — Vitest (проект `nuxt`) на компоненты/страницы (`mountSuspended`).

Чистую логику выносим в `app/utils/*` и покрываем тестами; реактивную — в `app/composables/*`,
UI — в компонентах. Это та же раскладка, что в `currency-converter` — держим её при развитии.

## Встройка в Bitrix24 (этап 2)

Приложение работает в двух режимах: standalone (публичный лендинг `/`) и как iframe-приложение
внутри портала (`/app`, `/settings`, `/install`). SDK — `@bitrix24/b24jssdk` (+ `-nuxt`).

- `useB24().init()` молча no-op вне фрейма (нет `window.name`) — поэтому in-portal-страницы рендерятся
  и как обычные URL, и внутри портала без отдельной ветки.
- `/install` делает `init → event.bind (ONAPPINSTALL/ONAPPUNINSTALL) → installFinish` + диагностику.
  Привязка событий — до `installFinish`, чтобы текущая установка доставила `application_token`
  на backend `/api/b24/events`. **`placement.bind` не вызываем** — как именно приложение встроено
  (плейсменты) зависит от регистрации; финализируем на тестовом портале. `NUXT_PUBLIC_SITE_URL`
  (build-arg) в проде **обязателен** — из него строится абсолютный URL хендлера событий (без него
  `/install` откажется биндить относительный URL и покажет ошибку с retry).
- **Вызовы B24 для данных/настроек — server-side REST по OAuth-токену (backend), не через фрейм** (см.
  «Хранение настроек» в [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md)). Фрейм-SDK тут — только установка
  и UI-хром (`setTitle`/`fitWindow`).
- **Серверные события — отдельный механизм** (не фрейм-`/install`): исходящие вебхуки Б24
  `ONAPPINSTALL`/`ONAPPUNINSTALL` на backend (`server/api/b24/events.post.ts`) дают `application_token`
  (подпись событий) и OAuth-креды портала; токены пишутся в Postgres (`server/utils/tokenStore.ts`).
  Доменное ядро (разбор, вердикт токена, маршрутизация) — `app/utils/b24Events.ts`; контракт и
  модель учёта авторизации — [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md).
- Тесты: чистый `tests/b24.test.ts` (скоупы) + `tests/b24EventBind.test.ts` (билдер привязок —
  свежая установка/идемпотентность/перепривязка/чужие события/регистр); `tests/nuxt/install.nuxt.test.ts`
  (standalone-редирект + `event.bind` двух событий на `…/api/b24/events` до `installFinish`) через
  типизированный мок `tests/nuxt/helpers/mockB24.ts` (`makeMockB24`, `ReturnType<typeof useB24>`
  ловит дрейф). Реальный install-flow в портале автотестами не покрыть — проверяется вручную.
- CSP в `nginx.conf` уже разрешает облачные домены Б24 (`frame-ancestors`/`connect-src`).

## Настройка репозитория

- **В main не пушим — только через PR.** Защита `main` (ruleset `protect-main`) и CI как
  required-check настраиваются владельцем репо по [`docs/REPO_SETUP_CHECKLIST.md`](docs/REPO_SETUP_CHECKLIST.md).
- `.github/workflows/ci.yml` — пайплайн `CI/CD`: job `ci` (lint → test → typecheck → generate),
  `docker-build` (валидирует сборку образа на каждом PR, без push) и `deploy` (push в GHCR на
  `main`, gate по зелёному `ci`). Имя `ci` — то, что включается в required status checks ruleset'а.
  Сторонние actions запинены на commit SHA (issue #2; SHA обновляет Dependabot по комментарию `# vX.Y.Z`).
- `.github/dependabot.yml` — обновления `npm`, `github-actions` и `docker` (база `node` / `nginx-unprivileged`;
  major `node` игнорируется — 25+ убрал corepack).
- `.claude/` — SessionStart-хук (`hooks/session-start.sh`): в веб-сессиях Claude Code ставит
  зависимости и гоняет `nuxt prepare`, чтобы lint/typecheck/test/build работали с первого хода.

## Визуальная верификация (Definition of Done)

> **ВАЖНО:** после любой правки UI/CSS/вёрстки снять скриншот результата и
> посмотреть на пиксели **до** того, как считать задачу выполненной — не доверять
> «собралось без ошибок». `pnpm generate && pnpm screenshot` → смотреть
> `screenshots/` (mobile/desktop × light/dark). Детали и чек-лист —
> [`docs/VISUAL_VERIFICATION.md`](docs/VISUAL_VERIFICATION.md).

OG-картинка (`public/og.png`, 1200×630) генерируется из HTML-шаблона через
пред-установленный Chromium — `pnpm og` (`scripts/make-og.mjs`); коммитим как
статику. Перегенерировать при смене заголовка/брендинга.

## Деплой

Фронтенд (лендинг + B24-iframe-UI) деплоится как статика за nginx — по той же схеме, что
`currency-converter`: **GHCR + Watchtower за общим nginx-proxy**. Подробности — [`docs/DEPLOY.md`](docs/DEPLOY.md).

- Прод-образ — `nginxinc/nginx-unprivileged` (non-root, слушает `:8080`), статика из `nuxt generate`.
- CSP отдаётся **без** `script-src 'unsafe-inline'`: два inline-скрипта Nuxt (`theme-init` в `app.vue`
  и `window.__NUXT__.config` с меняющимся `buildId`) разрешаются по sha256-хэшам, которые
  `scripts/csp-hashes.mjs` считает из собранного HTML и подставляет в `nginx.conf` (плейсхолдер
  `__CSP_SCRIPT_HASHES__`) на этапе сборки. `frame-ancestors`/`connect-src` разрешают облачные
  домены Б24 (iframe-встройка `/app`,`/settings`); backend — **тот же origin** (`/api/*`, покрыт `'self'`).
  `POST /api/auth/login` дросселируется `limit_req` (зона `login`, ~10r/m по IP клиента через
  `real_ip` из `X-Forwarded-For`, `burst=5 nodelay` → 429) — антибрутфорс общего пароля оператора (#64, см. `docs/AUTH.md`).
- `docker-compose.yml` — локальная сборка: `app` (статика лендинга, nginx), `backend` (node-сервер,
  эндпоинт вебхуков Б24) и `db` (Postgres). `docker-compose.prod.yml` — прод `app`+`backend`+`db`
  (GHCR-образы + Watchtower за nginx-proxy); один домен — nginx `app` проксирует `/api/*` в backend.
  Общий reverse-proxy (`nginx-proxy` + `acme-companion`, сеть `proxy-net`) ставится на сервере один
  раз — см. `currency-converter/docker-compose.nginxproxy.yml`, не дублируем здесь.
- **Backend** — `Dockerfile` target `backend` (`nuxt build`, node-сервер). Приём событий Б24 и хранилище
  токенов **реализованы** (этап 3, слайс; #35); OAuth Альфы/опрос/дела/чат — далее (этапы 4–6). Env и
  запуск — `.env.example`, [`docs/DEPLOY.md`](docs/DEPLOY.md), [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md).

## Отчётность (reporting-kit)

Вендорный бандл для работы с AI-агентом и отчётов в Telegram — в
[`reporting-kit/`](reporting-kit/) (карточка интеграции —
[`docs/REPORTING_KIT.md`](docs/REPORTING_KIT.md)). Держим как есть для синхронизации
с источником; у него **свои конвенции и свой CI**, поэтому он **не линтуется**
нашими проверками: исключён из ESLint и `tests/mdReviewStamp.test.ts`, добавлен в
`.dockerignore` (чтобы не попадал в Docker-образ). Навыки `/report-status`,
`/report-digest`, `/report-questions` и `tg-send.sh` — внутри бандла. Telegram
пока не заведён (нужен `.env` с токеном, локально, см. README кита).

Канонический **срез состояния проекта** (цель/шаги/сделано/дальше/блокеры) — [`docs/project-map.md`](docs/project-map.md);
на него опираются `/report-status` и `/report-questions`. Держим синхронно с `REFACTOR_PLAN.md`.

## Конвенции

- Комментарии и JSDoc — на английском; пользовательский текст и README — на русском.
- Чистые функции — в `app/utils/*`, данные/константы — в `app/config/*` (уже есть:
  `banks.ts`), типы — в `app/types/*`; всё покрываем тестами. Реактивную логику — в
  `app/composables/*` (появится по мере роста), UI — в компонентах/страницах.
- Данные из API рендерим только через `{{ }}` (auto-escape) — никакого `v-html` с внешними данными.
- Штамп ревью: каждый `.md`-документ в корне и `docs/` несёт строку `> Last reviewed: YYYY-MM-DD`
  блок-цитатой сразу под заголовком H1. Ключ `Last reviewed` всегда на английском (технический
  маркер). Дату бампим только при содержательном изменении. Наличие штампа во всех отслеживаемых
  `.md` (кроме вендорного `reporting-kit/`) проверяет `tests/mdReviewStamp.test.ts`.
