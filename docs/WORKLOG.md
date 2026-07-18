# Журнал автономной работы (доведение до рабочего приложения)

> Last reviewed: 2026-07-18

Живой журнал автономной сессии: **что цель, какой процент готовности рабочего приложения,
что сделано за проход, что дальше**. Обновляется каждым PR. Сверяется с [`project-map.md`](project-map.md),
[`REFACTOR_PLAN.md`](REFACTOR_PLAN.md), [`PROCESSING.md`](PROCESSING.md).

## Цель

**Рабочий вариант приложения** — чтобы всё отрабатывало end-to-end (дизайн/тексты/UX правим потом):
выписка (онлайн из банка **или** файлом) → операции в CRM портала (дела/элементы, дедуп) →
уведомления в чат. По спецификации [`PROCESSING.md`](PROCESSING.md).

## Готовность рабочего приложения: ~82%

Оценка по сквозным путям (код+тесты; «вживую» = гонялось в реальном портале):

| Блок | Готовность | Комментарий |
|------|:---:|---|
| Встройка/установка/токены портала | ✅ ~95% | 2 портала вживую; авто-refresh **конкуренто-безопасен** (#35); SDK-ретрай выключен для неидемпотентных записей (#123) |
| Очереди + масштаб + ops | ✅ ~95% | воркер-контейнер, роли по env, монитор `/queues`; **readiness `/api/ready`** (#301), **лог сатурации** (#300), **runbook `OPERATIONS.md`** (#299), ручной «Опросить сейчас» (#54) |
| Ручной импорт: файл → CRM | 🧪 ~85% | приём→очередь→разбор→дело готов; **каскад «в мою компанию» при unmatched — СДЕЛАН** (#91); **исключения из импорта** — СДЕЛАНЫ (§2 A2). Живой сквозной прогон в портале — за владельцем |
| Стадия 4: компания + дело + чат | 🧪 ~80% | поиск компании **и запись дела** вживую (`pnpm activity:test`); чат — ядра+тесты, живьём не гонялось |
| Разнесение оплат #109 | 🧪 ~78% | recognize→route→resolve→отсев стадий→решение→**запись факта** (#184) + **триггеры** (#79) — **live-verified** (`pnpm trigger:test --apply --fire`, `bel.bitrix24.by`); **мутация портала** (`payment.pay` / стадия инвойса) — **код готов, за гейтом `autoDistribute`, но живьём не проведён** (`payment.pay` требует баланс покупателя — на seed-портале недоступен; `mutate:test` — dry-run по умолчанию; стадия инвойса проверялась apply/revert). Осталось: order `payment.add`-путь, элемент СП, live-verify мутации |
| Дедуп через маркер в B24 | ✅ ~90% | configurable-дело + дедуп `crm.activity.list` (#259, стор удалён); live-смоук; Фаза A idempotency live-verified |
| Опрос банков (stage 5) | 🧪 ~62% | вся машинерия A4–A10 собрана + ручной триггер (#54). Осталось для боевого прогона: банк-креды владельца (`ALFA_OAUTH_*`), `CRON_REAL_POLL=1`, Приор async (A5b) |
| Приватность / ПДн | ✅ ~85% | выписки у себя не храним; удержание statement-payload'ов в Redis ограничено (#245), `PRIVACY.md`; чистка на uninstall |

**~82%** = среднее по функциональным блокам. Рост с ~70%: закрыты **запись факта** (#184) и **триггеры**
разнесения (#79, live-verified; сама денежная мутация — код готов, live-verify за владельцем), каскад
unmatched (#91), исключения (§2 A2), ops-слой (#299/#300/#301), приватность (#245).

**Что осталось до «рабочего» end-to-end:** (1) **живой сквозной прогон** ручного импорта в портале
(файл → дело + разнесение + чат) — за владельцем; (2) **онлайн-опрос** — за банк-кредами владельца
(`ALFA_OAUTH_*`) + Приор async; (3) чат-уведомления живьём. Код по всем трём — готов и под тестами.

## Порядок работ (автономно)

1. ✅ **#35 авто-обновление токенов** — конкуренто-безопасно (advisory-lock, DI, тесты). *(этот проход)*
2. **Дедуп через origin-метку в B24** (#109/#259/PROCESSING §1) — ✅ **носитель = настраиваемое дело, дедуп в B24 (без флага, стор `activity_dedup` удалён)**; **live-смоук пройден** (`pnpm activity:test`, `bel.bitrix24.by`). **Фаза A (amount-путь) — сделана** (`isTargetApplied` читает `paid`/стадию цели вместо `allocation_fact`, live-verified); осталось элемент СП. Делает crm-sync масштабируемым.
3. ✅ **#109 проводка разнесения** — lookup'ы (сделка/оплата/смарт-процесс) + «моя компания» (#91) + запись
   факта (#184) + триггеры (#79), live-verified. Денежная мутация (`payment.pay`/стадия) — код готов, за
   гейтом `autoDistribute`, но живьём не проведена (за владельцем). Осталось: order `payment.add`, элемент СП.
4. ✅ **Опрос банков (stage 5)** — `bank-fetch` живой (A5+A9), реестр/таймер (A6/A10), connect-поток с UI
   (A7), глобальный rate-limiter (A8), ручной триггер (#54). Осталось: банк-креды владельца, Приор async (A5b).
5. ✅ **Статус-эндпоинт импорта** (#5) — реальный итог записи в карточке `/app` вместо mock (PR #204).
6. ✅ **Ops-слой + приватность** — readiness `/api/ready` (#301), лог сатурации (#300), runbook (#299),
   удержание ПДн в Redis (#245), честный маркетинг-статус.
7. Сквозная живая проверка (за владельцем, тестовый портал) + онлайн-опрос по банк-кредам.

## Лог проходов

### 2026-07-18 — #109 отсев FAIL-стадий смарт-процесса + #62 ядро агрегации результата (слайс 1)
- **#109 смарт-процесс в предикате отрицательных стадий:** `negativeStages` теперь юнионит FAIL-стадии СП,
  когда настроен `configFields['smart-entity']` (`buildPortalNegativeStagePredicate(..., smartEntityTypeId)`,
  форма `DYNAMIC_<etid>_STAGE_<cat>` live-confirmed) — лост-элемент СП больше не кандидат на разнесение;
  guard от коллизии etid=31/2; диагностика/fail-open расширены на `smartProcess`. Named follow-up закрыт.
- **#62 результат импорта для сотрудников (слайс 1):** чистое ядро `app/utils/importStats.ts`
  (`computeImportStats` — число операций, приходы/расходы по валютам, доминирующая валюта, разбивка по дням;
  `currencyTotal`/`dayBucketsForCurrency`/`operationDay`). Общий `round2` вынесен в `app/utils/money.ts`
  (был в 3 местах). Анимированный ECharts-рендер (count-up + бары/пончик) — слайс 2.
- **Каждый PR — 5 ревьюеров, замечания устранены; `pnpm check` зелёный.**

### 2026-07-18 — keep-alive-рефреш переведён на jssdk (последний сырой `$fetch` к Bitrix убран)
- **Что:** follow-up к #123/#191. Раньше единственный B24-вызов на сыром `$fetch` — рефреш токена
  keep-alive-кроном (`ensureAccessToken.postRefresh` → прямой POST на `oauth.bitrix.info/oauth/token/`).
  Переведён на jssdk по образцу соседа `ai-price-import`: `sdkRefreshTransport` (`b24Sdk.ts`) строит
  транзиентный `B24OAuth` и зовёт `auth.refreshAuth()`, обёрнутый в `withTimeout` (у SDK-рефреша нет своего
  таймаута, а он крутится **внутри** advisory-лока, держа pooled-соединение). Теперь **весь** исходящий B24 —
  один транспорт (jssdk); сырого `$fetch` к Bitrix в коде не осталось.
- **Что сохранено:** `ensureAccessToken` не тронут (DI-контракт `postRefresh(body)` тот же — `sdkRefreshTransport`
  парсит тело, чтобы не менять чистую логику и её тесты) → **per-portal advisory-lock (#35)** остаётся вокруг
  рефреша (крон идемпотентно рефрешит простаивающие порталы, реактивной подстраховки у него нет — лок обязателен;
  SDK его не даёт). `rawTokenFromRefresh` мапит SDK-ответ в форму, которую ждёт `parseRefreshResponse`, и оставляет
  `access_token`/`refresh_token` **undefined**, если их нет ни в captured, ни в authData → `parseRefreshResponse`
  бросает (fail-closed, не пишет пустые креды поверх живого портала — как старый сырой путь).
- **Уборка:** `B24_OAUTH_TOKEN_URL` из `b24Oauth.ts` удалён (последний потребитель ушёл); остались чистые
  `buildRefreshBody`/`parseRefreshResponse`.
- **Follow-up (осознанный tech-debt, отмечено ревьюерами):** контракт `postRefresh(body)` оставлен как есть →
  `sdkRefreshTransport` сериализует тело в `ensureAccessToken` и тут же парсит обратно (двойной serialize,
  т.к. SDK внутри `refreshAuth` сам собирает форму). Минимальный blast-radius (не трогаем чистую логику/тесты),
  но чище было бы сменить порт на `postRefresh({clientId,clientSecret,refreshToken})` и убрать `buildRefreshBody`
  из этого пути. Также: таймаут не аборт-ит запрос рефреша (SDK не даёт сигнала) — узкое окно «успел ротировать
  после таймаута → мёртвый refresh-токен» (LOW, только idle keep-alive; лечится оператор-реаутом, cf. #132).
- **Тесты:** `b24Sdk.test.ts` — `withTimeout` (fast-path + таймаут), `rawTokenFromRefresh` (captured>authData,
  фолбэк, fail-closed undefined), `sdkRefreshTransport` (строит `B24OAuth` со stored refresh + creds, POST на
  oauth-сервер, возвращает raw JSON; проброс ошибки рефреша). `ensureAccessToken.test.ts` — без изменений (контракт
  тот же). `pnpm check` зелёный (1508 тестов).

### 2026-07-18 — Ревизия + приватность/ПДн (#245) и каскад unmatched (#91)
- **Ревизия (Фаза 1):** 5 агентов сверили PROCESSING/project-map/README/CLAUDE/маркетинг/issue с кодом.
  Вывод: фабрикаций нет, но маркетинг завышал готовность онлайн/авто-разнесения/чата, техдоки отставали
  на 6 PR, было расхождение по исключениям. Итог показан владельцу таблицей.
- **#91 каскад «в мою компанию»** (мин. слайс): клиент не найден → дело в мою компанию (`findMyCompanyByAccount`)
  с блоком-причиной + чат ошибок; и моя не найдена → чат ошибок. Платёж не теряется, дедуп-маркер → повтор не
  долбит REST. Ветка элемента СП — за #109.
- **#245 приватность:** выписки у себя не храним; удержание statement-payload'ов в Redis ограничено по возрасту
  (`STATEMENT_JOB_RETENTION`), b24-events (OAuth-токен в открытом виде) — completed удаляется сразу
  (`CREDENTIAL_JOB_RETENTION`); `docs/PRIVACY.md` — модель хранения/чистки.
- **Честный маркетинг:** блок «Статус готовности» в MARKETPLACE_LISTING/PRICING/PARTNERS/POSITIONING —
  онлайн/авто/чат помечены «в стадии вывода», не подавать как готовое.
- **Закрыты issue:** #26 (auth Альфы), #90 (запись дела live), #191 (rate-limit → SDK), #54 (кнопка), #91.
- **Тесты/доки:** каждый PR — 5 ревьюеров, замечания устранены; `pnpm check` зелёный.

### 2026-07-18 — #123 паритет с `ai-price-import`: отключён in-client ретрай SDK + hard-reject фрейм-токена
- **Откуда:** сверка транспортного слоя с соседним репо `bx-shef/ai-price-import` (после «всё на JsSdk»). У него
  два приёма, которых у нас не было: (1) `disableSdkRetry` (#123) и (2) hard-reject бэйр/фрейм-токена.
- **Проблема (реальный риск дублей):** наш per-portal `B24OAuth` использовал дефолтный ретрай SDK
  (`maxRetries:3, retryOnNetworkError:true`). crm-sync шлёт **неидемпотентные** записи (`crm.activity.configurable.add`
  + мутации разнесения); ретрай SDK после закоммитившегося-но-таймутнувшего запроса **задвоил бы** сущность (Bitrix не
  гарантирует уникальность маркера в пределах одного вызова — межджобовый дедуп `findActivityByMarker` внутри вызова не
  спасает).
- **Сделано:** `disableSdkRetry(client)` → `setRestrictionManagerParams({...ParamsFactory.getDefault(),
  maxRetries:1, retryOnNetworkError:false})` на **обоих** клиентах (`makePortalSdkClient` + `makeFrameRestCall`). Троттл
  (leaky-bucket 2 req/s) остаётся — он проактивно не даёт словить `QUERY_LIMIT_EXCEEDED`, — ретрай выключен: падаем всей
  BullMQ-джобой, где записи **идемпотентны** (read-before-write по маркеру + applied-детект мутаций). Спред полного
  `getDefault()` обязателен (setConfig заменяет конфиг целиком). Fire-and-forget безопасен: `#config` присваивается
  синхронно (сверено по исходникам SDK 2.0.0, до первого await). **Фрейм-токен hard-reject:** `makeFrameRestCall` ставит
  `setCustomRefreshAuth(() => reject(FRAME_TOKEN_REJECTED))` — отвергнутый фрейм-токен бросает `invalid_token` сразу,
  без пустого `refresh_token` POST на OAuth-сервер (лишний заведомо-провальный round-trip, что отметил ревьюер #191).
- **Идемпотентность на джоба-ретрае (найдено ревьюером):** `notifyError` (заметка в чат ошибок про `ambiguous`/`manual`,
  `im.message.add` без дедупа) вызывался **до** записи дедуп-маркера (`writeActivity`) — на джоба-ретрае (теперь чаще из-за
  #123) заметка ушла бы **повторно**. Исправлено: заметка теперь захватывается и **эмитится после** маркера (зеркалит уже
  безопасный `notifyChat`) — редоставка `continue`-ится на верхнем гейте до эмита. Тест `queuePhase2.test.ts`: тот же джоб
  дважды → заметка ровно одна. (`notifyChat` был безопасен и до этого — он уже стоял после маркера.)
- **Тесты:** `b24Sdk.test.ts` — оба клиента: ассерт `setRestrictionManagerParams({maxRetries:1, retryOnNetworkError:false,
  rateLimit:{drainRate:2}})` — последнее гардит **сохранение спреда** `getDefault()` (без него троттл занулился бы, а
  `toMatchObject`-subset это проглотил бы); фрейм ещё `setCustomRefreshAuth` → `rejects invalid_token`. Мок-фабрики
  (`b24Sdk`/`portalSdkResolver`) дополнены `ParamsFactory`+`setRestrictionManagerParams`/`setCustomRefreshAuth`. `pnpm check`
  зелёный.
- **Отложено (follow-up):** (1) keep-alive-рефреш соседа тоже идёт через SDK (`sdkRefreshTransport`) **внутри** #35-лока — у
  нас keep-alive пока на сыром `$fetch` (корректно, лок сохранён); перевод — отдельным PR (нужен рефактор `RefreshDeps`).
  (2) узкий best-effort edge (ревьюер, low): триггер-путь фаерит `crm.automation.trigger.execute` **до** записи факта — если
  `recordAllocation` упадёт в зазоре fire→fact, ретрай пере-фаерит триггер. Гейт opt-in `autoDistribute`+`triggerCode`
  (default OFF), single-shot best-effort; порядок fire-then-fact выбран сознательно (обратный дал бы «потерянный fire»).

### 2026-07-17 — Исключения по счёту/назначению пропускают операцию целиком (PROCESSING §2 A2)
- **Проблема (ревизия):** аудит нашёл расхождение док↔код — PROCESSING §2 A2 обещает «исключения → НЕ
  ЗАГРУЖАТЬ», а `excludeAccounts`/`excludePurposePatterns` глушили только чат (`shouldNotifyChat`), дело всё
  равно писалось. Решение владельца: исключённая операция **не пишется в CRM вообще**.
- **Сделано:** чистый `isExcludedOperation` (`statement.ts`) — по нашему счёту / подстроке назначения;
  гейт первым в цикле `handleCrmSyncJob` (ни распознавания, ни поиска компании, ни дела, ни разнесения, ни
  чата), счётчик `excluded`. Направление (приход/расход) остаётся только чат-фильтром. `SettingsForm`:
  блок «Исключения» переформулирован, предпросмотр различает «не импортируется» / «скрыто в чате» / «в чат».
  Доки: PROCESSING §2 A2 + поля §1 + §4/§6, CLAUDE.md. Тесты: `statement.test`, `queuePhase2` (скип + mixed-batch).
- **⚠ Миграция (внимание оператору):** настройки не версионируются (`cb_settings_v1`). Порталы, у которых
  исключения были заданы под старой семантикой («только глушить чат»), теперь **перестанут заносить** такие
  операции в CRM. Автомиграции нет — операторам стоит перепроверить свои списки исключений. Одноразовый
  UI-баннер об этом — возможный follow-up.

### 2026-07-17 — #191 «всё на JsSdk»: весь B24 REST через один jssdk-транспорт
- **Проблема:** `crm-sync` уже ходил через `@bitrix24/b24jssdk` (`B24OAuth`), но UI-фрейм-роуты
  (`settings`/`chat-settings`/`chat-search`/`import`/`import/status`/`metrics`/`bank/connect`/`poll-now`) и
  серверная диагностика `app-option-check` всё ещё использовали **сырой `$fetch`-`callRest`** в `b24Rest.ts` —
  два разных транспорта, дубль лимитера/ретрая, ручной парсинг ошибок.
- **Сделано:** `b24Rest.ts` ужат **до одного SSRF-гейта** (`assertPortalHost` — валидирует хост по allowlist
  #149 и возвращает **чистый** хост либо бросает); сырые `callRest`/`restUrl`/`REST_TIMEOUT_MS`/`B24RestError`/
  `isExpiredTokenError`/`b24RestErrorFrom`/`b24ErrorMessage`/`restTimingLine`/`serverDurationMs` **удалены**. Новый
  `makeFrameRestCall(domain, accessToken, creds, {now, scope})` (`b24Sdk.ts`) — фрейм-`RestCall` на том же
  `B24OAuth`, **за `assertPortalHost`** (SSRF: чистый хост в `clientEndpoint`, userinfo-трюк `…@evil.com` не
  ретаргетит origin), с **пустым refresh-токеном** (фрейм-токен свежий, рефреш не нужен). `liveDeps.ts`:
  `frameRestCall` (drop-in замена `callRest`) + `livePortalSdkCall` (stored-token SDK для диагностики).
  `appSettings.ts` ужат до чистых `readAppSettingVia`/`pickAppOption` (token-load+запись `readAppSetting`/
  `writeAppSetting`/`AppSettingsDeps` **удалены** — запись `app.option` теперь тем же SDK).
- **Свойства сохранены (сверено по исходникам pinned SDK 2.0.0):** реактивный ретрай `expired_token`/401 — у
  SDK (`abstract-http` `_isAuthError`), rate-limiter (RestrictionManager, пер-инстанс) — у SDK; фрейм-клиент
  **не** рефрешит проактивно (`getAuthData()` видит `expiresAt=now+1h` → валиден); отвергнутый фрейм-токен →
  реактивный refresh с пустым токеном → **чистый throw** → роут отдаёт 502 (как старый `callRest`), без утечки
  секрета. Единственный B24-вызов на прямом `$fetch` — keep-alive-рефреш (`ensureAccessToken`/`b24Oauth`, #175):
  ему нужен pg-advisory-lock сериализации, которого SDK не даёт (осознанный компромисс).
- **Тесты:** `b24Rest.test.ts` — `assertPortalHost` (throw на не-allowlisted/пустой/userinfo, возврат чистого
  хоста); `b24Sdk.test.ts` — `makeFrameRestCall` (SSRF-гейт бросает **до** построения клиента; happy-path строит
  один `B24OAuth` с чистым хостом + пустым refresh); `appSettings.test.ts` — `readAppSettingVia`/`pickAppOption`.
  `pnpm check` зелёный (1475 тестов). Живой end-to-end фрейм-пути в песочнице не прогнать (нет свежего токена —
  бэкенд-Docker с живым порталом на деплой-сервере); транзитивно покрыт — фрейм-путь использует **тот же**
  `makeSdkRestCall`/`B24OAuth`, что live-verified `crm-sync`-транспорт (#191).

### 2026-07-17 — Стадия 5: онлайн-опрос банков собран целиком (A5–A10, слайсами)
- **Что сделано (каждый слайс — 5 ревьюеров + юнит-тесты, смержено):** A5 транспорт выписки Альфы
  (`bankFetch.ts`), A9 свап заглушки в воркере, A6 реестр счетов + A10 живой крон-таймер (`epoch` в
  `fetchJobId`+`batchId`, default-OFF `CRON_REAL_POLL`), A7 connect-поток OAuth банков (A7a CSRF-state с
  доменной сепарацией → A7b роуты authorize+callback с гейтом админа → A7c UI на b24ui), A8 **глобальный
  rate-limiter** `Q_FETCH` (BullMQ `limiter`, шаренный по репликам через Redis — сверено по исходникам
  bullmq 5.x; дефолт 100/60с, кламп обоих краёв чтобы кап нельзя было отключить опечаткой).
- **Осталось до боевого прогона:** банк-креды владельца (`ALFA_OAUTH_*` в `.env.alfabankby`) — только с
  ними живой OAuth+fetch можно прогнать; Приор async create+poll (A5b). Follow-up: enum счетов, показ
  per-account ошибки опроса, single-use nonce, реактивный 429, лог сатурации лимитера.

### 2026-07-17 — LIVE-VERIFY на реальных порталах (владелец дал креды)
- **Контекст:** владелец передал вебхук тест-портала (`b24-86sr2r.bitrix24.com`, seed) и OAuth-креды
  установленного приложения (`bel.bitrix24.by`) → разблокирована живая проверка CRM-стороны, которая
  раньше была «за владельцем». Креды — только в git-ignored `.env.b24test`/`.env.b24oauth`, в репо не попали.
- **#79 триггер — LIVE-VERIFIED (главный блокер снят):** `pnpm trigger:test --apply --fire` (`bel.bitrix24.by`):
  `crm.automation.trigger.add`→`trigger.list` round-trip; `executeTriggerViaRest`→`crm.automation.trigger.execute`
  `{result:true}` на **сделке** (OWNER_TYPE_ID=2) **и смарт-процессе** (OWNER_TYPE_ID=`entityTypeId`=1044);
  незарегистрированный CODE → `Trigger ... is not registered` (валидирует best-effort-глоток). Скрипт
  `trigger-register-test.ts` расширен флагом `--fire` (тот же транспорт crm-sync).
- **Прочее CRM-ядро — LIVE-VERIFIED:** `pnpm verify:109` — 21/21 (companyLookup/стадии/invoiceLookup/IDOR/
  resolveAllocation/ambiguous/filterByAccountNumber); `pnpm sdk:crm:test` — OAuth SDK-транспорт (#191) profile+
  18 смарт-счетов; `pnpm activity:test --company 1 --apply` — `configurable.add`+B24-дедуп round-trip (#259);
  `pnpm verify:chat` — стадия 6 чат-уведомления (`im.message.add` msgId=57, BB-нейтрализация, сообщение удалено) 6/6.
- **IDOR-гейт СП снят:** `crm.item.fields` СП 1044 содержит `companyId` (тип `crm_company`) → company-скоуп держится.
- **Осталось (за владельцем):** банк-креды Альфа/Приор (`.env.alfabankby`/`.env.priorbank`) для живого online-fetch —
  B24-креды их не заменяют; правило автоматизации на CODE (реакция на сигнал).

### 2026-07-16 — #259: настраиваемое дело — единственный носитель, флаг убран (код)
- **Контекст (владелец):** «флаги бесят, идёт разработка — просто сделай». Прод защищать не от кого →
  флаг `ACTIVITY_TRANSPORT` **убран**, настраиваемое дело стало **единственным** путём записи операции.
- **Удалено:** `crmActivityWrite.ts` (+тест), `activityDedupStore.ts` (+тест), таблица `activity_dedup`
  из схемы, `buildTodoActivity`/`buildActivityDescription`/`activityOriginToken`/`TodoActivityParams` из
  `activity.ts` (+тесты), `rememberActivity` из `HandlerDeps`+`handleCrmSyncJob`, `activityTransport`/
  `ACTIVITY_MODE`, passthrough флага в `.env.example`/`docker-compose*`, `deleteDedupForPortal` из
  uninstall (обе ветки). Дедуп = поиск маркера в B24 (`findActivityByMarker`), стора нет.
- **Тест `queuePhase2`:** `writeActivity`-мок теперь пишет маркер атомарно (заполняет `written`), ассерты
  `calls.remember` заменены на `calls.activity`. Прогон зелёный.
- **Доки:** PROCESSING §1 (преамбула/§0.5/модель/A3), QUEUES, project-map, CLAUDE.md, REST_METHODS,
  B24_EVENTS, REFACTOR_PLAN — везде «настраиваемое дело + маркер, стора нет».
- **Дальше:** Фаза A (факт разнесения → состояние цели); элемент СП + кнопки §6; усиление ключа операции.

### 2026-07-16 — #259 Фаза B: переключение `todo`→настраиваемое дело за флагом (код)
- **Сделано:** новый носитель операции — `crm.activity.configurable.add` с маркером `originatorId`
  (app-namespace) + `originId` (ключ операции), за opt-in флагом `ACTIVITY_TRANSPORT=configurable`
  (default `todo` → поведение прежнее). При `configurable` read-before-write дедуп = **поиск маркера в B24**
  (`crm.activity.list filter[ORIGINATOR_ID][ORIGIN_ID]`), стор `activity_dedup` на этом пути не нужен;
  `rememberActivity` — no-op (маркер пишется атомарно с делом → закрыт write→remember-зазор).
- **Файлы:** `app/utils/configurableActivity.ts` (чистый билдер layout+маркер, BB-нейтрализация внешних
  полей), `server/utils/configurableActivityWrite.ts` (транспорт, конверт `{result:{activity:{id}}}`),
  `server/utils/activityMarkerLookup.ts` (поиск по паре маркера, пустой маркер → без REST),
  `activityTransport` в `runtime.ts`, проводка в `worker.ts` (mode-aware `writeActivity`/`getActivityId`/
  `rememberActivity`). Тесты: `configurableActivity`/`configurableActivityWrite`/`activityMarkerLookup` +
  флаг в `queueRuntime`. `.env.example`/`docker-compose*` — passthrough флага.
- **Live-verify (гейт включения):** `pnpm activity:test --company <id> --apply` (`scripts/configurable-activity-test.ts`) —
  на OAuth-портале, т.к. `configurable.add` вебхуком не создать (класс #79) — нужен OAuth-контекст приложения.
- **Дальше:** Фаза A (факт разнесения → состояние цели); элемент смарт-процесса как носитель (платный тариф);
  кнопки §6 в layout (регистрация действий приложения); усиление ключа операции (§1).

### 2026-07-16 — уточнение #259: настраиваемое дело несёт `originId` (docs)
- **Вопрос владельца:** есть ли у простого дела `xmlId` / другое искомое поле; чем настраиваемое отличается.
- **Проверка по офдоке (b24-dev-mcp):** у **простого** `crm.activity.todo.add` внешнего id нет (метод его
  не принимает). Но есть отдельный метод **`crm.activity.configurable.add`** («настраиваемое дело» — с
  `layout`/кнопками/бейджами, как хочет §6), и он **принимает `originatorId`+`originId`**; `crm.activity.list`
  **фильтрует** по `ORIGINATOR_ID`/`ORIGIN_ID`. Т.е. B24-дедуп для дела **возможен** — но носителем должно
  быть настраиваемое дело, а не простое.
- **Поправка к #9/#259:** #9 выбрал backend-стор, т.к. `todo.add` без `ORIGIN_ID` — верно; но `configurable.add`
  маркер несёт (не рассмотрен). `originId` на **нашем** настраиваемом деле — **наше** поле (не штамповка чужого).
- **Оговорка:** `configurable.add` — **только в контексте приложения (OAuth)**, обновляет лишь создавшее
  приложение → вебхуком тест-портала не проверить (класс #79); фильтр по `ORIGIN_ID` доко-подтверждён,
  live-verify — на OAuth-портале.
- **Правка (docs+комментарий):** §1 матрица/модель/Фаза B, преамбула, §0.5, A3, `QUEUES.md`, `project-map.md`,
  комментарий `worker.ts` — везде «носитель с нашим маркером = настраиваемое дело (`originId`) **или** элемент
  СП (`xmlId`)»; простое `todo`-дело остаётся на сторе by design.

### 2026-07-16 — #259 приведение модели дедупа к live-факту (docs)
> **Уточнено записью выше (та же дата):** `crm.activity.configurable.add` несёт `originId` → снятие стора
> дела возможно и через **настраиваемое дело**, не только через элемент СП. Формулировки ниже
> («маркер только у `crm.item`», «Фаза B = элемент смарт-процесса») — снимок до этой поправки.
- **Контекст:** issue #259 (live-verify полей `crm.item`) вскрыл ошибку в `PROCESSING.md` §1 — модель
  обещала «искать origin-метку **среди дел**», но у `crm.activity.todo.add` фильтруемого маркера **нет**
  (есть только у `crm.item`: сделка → `originId`+`originatorId`, инвойс/смарт-процесс → `xmlId`).
- **Правка (docs-only, прод не трогает):** `PROCESSING.md` §1 переписан под матрицу #259; A3 уточнён;
  синхронизированы `QUEUES.md` (целевая модель + рычаг масштабирования) и `project-map.md`. Зафиксировано
  решение: **чужие поля (`originId`/`xmlId` клиентских сделок/инвойсов) не штампуем**; снятие сторов —
  **поэтапно**: Фаза A (`allocation_fact` → состояние цели при `autoDistribute=ON`, live-gated), Фаза B
  (носитель операции = элемент смарт-процесса, `xmlId` наш), а `todo`-стор `activity_dedup` **остаётся**
  by design.
- **Дальше (код, отдельные слайсы под live-verify):** Фаза A — заменить `hasAllocationFact` на чтение
  оплаты/стадии цели; Фаза B — запись операции элементом смарт-процесса с поиском по `xmlId`.

### 2026-07-09 — #182 DoS-бонд коэрса настроек (`parsePortalSettings`)
- **Проблема (defense-in-depth):** три места в `app/utils/settings.ts` итерировали недоверенный JSON без
  ограничения размера входа: `cleanList` ломал цикл только по *принятому* счётчику (`seen.size >= cap`) →
  массив пустых/дублей сканировался целиком; `cleanDirections` делал `v.includes()` (O(|v|)) на каждое
  направление без среза; `cleanRecognition.configFields` резал **после** `Object.entries(...)`, который
  материализует все ключи. (`cleanRecognition.matrices` уже был захардён в #181.)
- **Сделано:** вход режется до цикла/пробы: `cleanList` — `v.slice(0, MAX_LIST_ITEMS)`; `cleanDirections` —
  `new Set(v.slice(0, cap))` + `VALID_DIRECTIONS.filter` (O(1) проба, порядок сохранён); `configFields` —
  ленивый `for…in` + `Object.hasOwn` + visited-counter break (не материализует хвост; visited-break безопасен —
  ключи уникальны, нет #182-ловушки дублей). Итерация ограничена независимо от nginx `client_max_body_size`.
  Трейд-офф `cleanList`/`cleanDirections` (уник за кэпом позади дублей отсеётся) закомментирован — легит-вход
  до кэпа не доходит. Тесты (+3): iteration-bound `cleanList` (`['dup']` vs `['dup','unique-past-cap']`),
  bound `cleanDirections` (buried-`credit` → `[]`), документирующий «matrices НЕ дедупятся».
- **Панель (5 ревьюеров):** R1/R2/R4 — чисто (корректность/тесты/интеграция); **R3 (DoS-полнота)** — нашёл
  два оставшихся неограниченных цикла (`cleanDirections`/`configFields`), устранены здесь же; **R5 (доки)** —
  `%` был завышен относительно методологии (шапка = среднее по 6 блокам ≈ 69–70%): выровнен к ~70%
  (хардёнг #149/#182/#191 не двигает функциональные блоки).

### 2026-07-09 — #149 SSRF-гейт b24Rest (allowlist хоста портала + таймаут)
- **Проблема (security):** `callRest` брал portal `domain` из заголовка `X-B24-Domain` (фрейм-роуты) и слал
  исходящий POST на `https://<domain>/rest/...` с телом, несущим `auth`-токен — **без allowlist и таймаута**
  (SSRF-примитив: зонд внутренних хостов, эксфильтрация токена на выбранный хост).
- **Сделано (централизованно в `callRest`, fail-closed):** `isAllowedPortalHost` — облачные `*.bitrix24.<tld>`
  (полный список зон по офиц. Bitrix24 DPA 2025 + RU-оператор) + self-hosted из env `B24_SELFHOSTED_HOSTS`;
  `portalHostname` извлекает хост через `URL` (валидатор и `restUrl` — одинаково → нет parser-differential
  обхода `x.bitrix24.by@evil.com`); таймаут `REST_TIMEOUT_MS` 15с; nginx CSP синхронизирован тем же списком.
- **Панель ревью (5 проверяющих):** R1 (SSRF-обход) — не найден (эмпирично против WHATWG URL); R2 (интеграция)
  — чисто (throw → 502/403/409, воркер/демо не сломаны); R3 — `restUrl` fail-closed на пустой хост; R4 — тест
  самого гейта `callRest` (удаление гейта иначе прошло бы зелёным); **R5 (BLOCKER)** — allowlist TLD был
  неполон → дополнен по авторитетному источнику (проверил вживую web). Итог 991 тест.

### 2026-07-09 — #191 пагинация company-пула оплат (findCompanyDealPayments)
- **Проблема (корректность):** `findCompanyDealPayments` брал сделки компании **одним** `crm.item.list` —
  метод одностраничный (max 50). У компании с >50 сделками часть пула `deal-payment` **молча терялась** →
  amount из «потерянной» сделки не находился → неверный `manual`/`none` по §2 (тихое усечение).
- **Сделано:** пагинация по `start`/top-level `total` (кап `MAX_DEAL_PAGES`, паттерн `loadCategoryIds` из
  `negativeStages`); нет числового `total` → одностраничный фолбэк (совместимо со stub-моками). Per-deal
  `crm.item.payment.list` остаются **последовательными** (concurrency 1 — rate-safe; bounded concurrency —
  за лимитером #191). Чистый код, тесты на fake-`RestCall` (+6: пагинация через страницы, стоп по `total`,
  бэкстоп `MAX_DEAL_PAGES`, single-page-фолбэк, `dealListTotal`, `start`-offset).
- **Осталось (#191):** rate-limit/bounded-concurrency воркера + bind-`RestCall`-once на джобу + батчинг
  `callBatch` + retry/backoff на `QUERY_LIMIT_EXCEEDED` — до реального опроса портала.

### 2026-07-09 — #5 статус последнего импорта в UI портала (PR #204)
- **Проблема:** карточка `/app` показывала mock-итог импорта — владелец не видел **реальный** результат
  записи (операции / дела / в чат). Единственная крупная ценная фича, строимая **без живого портала**.
- **Сделано (полная вертикаль):** стор `importResultStore.ts` + таблица `import_result` (одна строка на
  портал, upsert last-run / read / purge); `crm-sync`-джоба **апсертит сводку прогона** best-effort в
  воркере (демо-счета пропускаются, сбой статуса не роняет джобу); `GET /api/import/status` по **фрейм-токену**
  (`profile`-валидация, блок спуфинга домена, порядок domain→token) — чистый `importStatusHandler` (DI) +
  тесты; UI `useImportStatus` (в портале реальный fetch, вне фрейма демо-mock); uninstall чистит стор.
- **Харднинг по панели (5 ревьюеров):** R2 (MEDIUM) — `/api/import/status` не был под rate-limit
  (exact-match `= /api/import` его не покрывал) → добавлен `location = /api/import/status` (`zone=import`);
  R4 — `notified≠created` закреплён тестом + отсев не-строк из `errors[]`; R5 — дубль `neverSummary`
  сведён в общий `emptyImportSummary()`; R1/R3 — чисто.

### 2026-07-09 — безопасность: neutralizeBb в описании/заголовке дела CRM
- **Проблема (нашёл ревьюер безопасности):** сырой `item.purpose`/контрагент (текст плательщика) шёл в
  `crm.activity.todo.add` без `neutralizeBb`, хотя чат-путь его нейтрализует — асимметрия, потенциальная
  BB-инъекция в клиентский CRM-таймлайн.
- **Сделано:** `neutralizeBb` перенесён в `app/utils/activity.ts` (шарится в `chatMessage.ts`, без цикла),
  применён ко всем внешним полям заголовка и описания дела. Тесты (+5). PR — фокусный.
- **Контекст:** возник при откате PR #199 (предпросмотр разнесения в описании дела) — adversarial-панель
  (product/spec-ревьюер) обоснованно отклонила запись «предпросмотра» в долговременную клиентскую карточку:
  по §2/§5 исходы разнесения идут в **чат ошибок**, не в дело. Диагностика осталась в `console.log`
  (`onAllocationDecision`, #198). Из находок панели взял только реальный security-зазор (эта запись).

### 2026-07-09 — #109 решение разнесения (resolveAllocation) — log/count
- **Сделано:** отфильтрованные по стадии кандидаты сворачиваются чистым `summarizeAllocation`
  (`app/utils/allocation.ts`) → исход в `crm-sync` (`server/queue/handlers.ts`): amount-цели
  (invoice/deal-payment) — точная сумма+валюта; trigger-цели (deal/smart-process) — безусловно.
  Счётчики `allocatable`/`ambiguous`/`manual` + лог решения (`onAllocationDecision`). Пока **без
  записи**. PR #198.
- **Панель ревью (5 проверяющих):** R1/R2/R3 — чисто (корректность, спека §2, безопасность).
  R4 — +7 тестов (mixed amount+trigger, currency-mismatch, deal-payment цель, collapseSameTarget,
  multi-op accumulation). R5 — вынес разбиение целей в **компиляторно-проверяемый** `ALLOCATION_TARGET_ROLE`
  (ретайрит дубль `AMOUNT_GATED_KINDS`) + чистый `summarizeAllocation` (прямые юнит-тесты). Итог 944 теста.
- **Осталось:** запись факта/дела (`allocationFactStore` + `autoDistribute`-гейт + идемпотентность
  #184 + действие в портале `payment.pay`/стадия) — за live-verify.

### 2026-07-09 — #109 отсев отрицательных стадий в резолюции намерений
- **Проблема:** в `crm-sync` намерения резолвились в кандидатов, но кандидаты **не фильтровались по стадии** —
  разнесение могло попасть на оплаченный/«Не оплачен» инвойс или проигранную сделку.
- **Сделано:** новый чистый модуль `server/utils/negativeStages.ts` — `crm.category.list` (на тип объекта) → на
  каждую воронку `crm.status.list` → **единый предикат `isNegativeStage`** (объединение отрицательных стадий
  инвойсов `DT31_<cat>:…` и сделок `LOSE`/`C<cat>:LOSE`; namespace'ы не пересекаются). Грузится **ленивo, раз на
  джобу** (`HandlerDeps.loadNegativeStagePredicate`, мемо `undefined→loaded`), прокинут в `resolveIntentsForOp`.
  DI + тесты (`tests/negativeStages.test.ts`, +расширен `queuePhase2`).
- **Харднинг по панели ревью (5 проверяющих):**
  - R2/R1/R4 (MEDIUM): fail-open алерт был только по сделкам → **симметричный** `failOpenEntities` (инвойс+сделка),
    вынесен чистой функцией и покрыт тестом (инвойс — основная цель, нельзя пропускать).
  - R3/R1 (LOW): `crm.category.list` одностраничный (max 50) → добавил **пагинацию** по `start`/`total` (иначе >50
    воронок молча теряются — fail-open); тест на 120 воронок.
  - R1 (MEDIUM, unverified): форма stage-id **дефолтной воронки** сделки (`LOSE` vs `C0:LOSE`) вживую не
    подтверждена → `stripDealCategoryPrefix` + предикат матчит обе формы (false-negative-safe); помечено
    **live-verify-гейтом** перед записью разнесения.
  - R5: мемоизация once-per-job и ленивый гейт — корректны; батч/лимитер/кэш — в #191 (не блокер).
- **Осталось (следующий под-слайс):** `resolveAllocation` (кандидаты уже отфильтрованы) → запись факта/дела,
  идемпотентность (#184); live-verify формы стадии дефолтной воронки.

### 2026-07-08 — #35 авто-обновление токенов (конкуренто-безопасно)
- **Проблема:** `ensureAccessToken` рефрешил+персистил токен, но под scale-out два воркера гонятся на
  ротации refresh-токена B24 → у проигравшего refresh-токен инвалидируется → все последующие рефреши
  портала падают (портал «отваливается»).
- **Сделано:** рефреш сериализован **per-portal** через pg advisory-lock (`server/utils/dbLock.ts`,
  транзакционный `pg_advisory_xact_lock`, авто-release на COMMIT/ROLLBACK) + **double-checked re-read**
  внутри лока (проигравший видит свежий токен и не рефрешит повторно). DI (`RefreshDeps`) + тесты
  (`tests/ensureAccessToken.test.ts`: не-рефреш, нет кредов, рефреш+персист ротации, пропуск при
  конкурентном победителе, сохранение старого refresh при отсутствии нового, ошибка invalid_grant).
- **Харднинг по панели ревью (5 проверяющих):** `lock_timeout`/`statement_timeout` + пин
  `READ COMMITTED` на заблокированной connection, таймаут OAuth-POST (15с), `client.release(err)` на
  ошибке, увеличенный pool (`max:10` + `connectionTimeoutMillis`) — чтобы зависший рефреш не выел пул и
  не застопорил всю БД; отказ от «воскрешения» удалённого портала (uninstall-гонка); тесты границы skew,
  null-ветки, домена.
- **Открытый follow-up** (в комменте #35): проактивный фоновый рефреш простаивающих порталов;
  терминальная обработка «мёртвого» refresh-токена (алерт/пере-установка) — сейчас чёткая ошибка.
