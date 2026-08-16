# Дев-скрипты: разведка, посев, живые прогоны

> Last reviewed: 2026-08-16

Скрипты из `package.json`, которые **не** входят в сборку и нужны для работы с живыми API банков и
тестовым порталом Bitrix24. Вынесены из `CLAUDE.md`, где занимали 130 строк справочника и мешали
читать карту модулей.

⚠ Все они требуют реальных кредов и живут в git-ignored `.env.*`-файлах (`.env.b24test`,
`.env.b24oauth`, `.env.alfabankby`, `.env.priorbank`). В репозиторий креды не попадают — есть только
`*.example`-шаблоны.

## Полный список команд

> **Где запускать.** Всё, что начинается с `pnpm`, — **на дев-машине**, там где есть репозиторий.
> Всё, что начинается с `make`, — **на сервере**, из `/home/bitrix/bank-import`.
>
> ⚠ Репозитория на сервере НЕТ (только `docker-compose.prod.yml`, `Makefile` и `.env`), поэтому
> `bash scripts/…` там выполнить нельзя в принципе. Серверные цели `Makefile` скачивают скрипт по
> HTTPS во временный файл — см. `make doctor` / `make queue-stats` и комментарий в самом `Makefile`.
> ⚠ Берётся `main`, а не то, что развёрнуто: обычно совпадает, а когда важна точность —
> `make doctor REF=<коммит>`.

| Команда | Где | Что делает | Чем опасна |
|---|---|---|---|
| `make doctor` | сервер | проверка боевого стенда (контейнеры, health, env, логи, HTTPS) | только чтение; секретов не печатает; домен берётся из `./.env` |
| `make queue-stats` | сервер | счётчики очередей из работающего backend | только чтение; токен берётся из `./.env` |
| `pnpm oauth:test` | дев | живой прогон OAuth/выписки Альфы (sandbox) | только чтение |
| `pnpm prior:test` | дев | то же для Приорбанка (Open Banking СПР) | только чтение |
| `pnpm parse:statement <файл>` | дев | разбор файла выписки в консоль | безопасно, без сети |
| `pnpm fuzz:allocation [seed] [N]` | дев | фузз алгоритма разнесения на синтетике | безопасно, без сети |
| `pnpm verify:109` | дев | живой READ-прогон разнесения на seed-данных портала | только чтение |
| `pnpm verify:chat` | дев | живой прогон чат-уведомлений | **пишет** сообщение и удаляет его |
| `pnpm verify:distribution` | дев | write-путь СП-леджера | **пишет** в портал, есть teardown |
| `pnpm mutate:test` | дев | мутация разнесения (оплата/стадия) | dry-run по умолчанию; `--apply` **пишет** |
| `pnpm activity:test` | дев | запись универсального дела + маркер | dry-run; `--apply` **пишет** |
| `pnpm trigger:test` | дев | регистрация триггера автоматизации | dry-run; `--apply` **пишет** |
| `pnpm sdk:test` / `sdk:oauth` / `sdk:crm:test` | дев | смоуки транспорта B24 (вебхук и OAuth) | чтение; ротируют refresh: `sdk:crm:test --force-refresh`, `sdk:oauth --refresh` |
| `scripts/extract-oauth-from-docker.sh` | тест-сервер, вручную | вытащить OAuth-грант портала из backend-контейнера | ⚠ **ротирует refresh ЖИВОГО портала безусловно**, самим фактом запуска — только на ТЕСТОВОМ сервере; на проде портал придётся переустанавливать. ⚠ Цели в `Makefile` у него НЕТ намеренно: команда разрушительная, и стоять на расстоянии одного слова от `make doctor` она не должна — скачивать и запускать её надо осознанно, руками |
| `pnpm seed:b24` | дев | посев тестовых данных портала (`--list`, `--purge`) | **пишет** в тестовый портал |
| `pnpm seed:companies` | дев | посев компаний (мои/клиенты/подрядчики) | **пишет** в тестовый портал |
| `pnpm make:statement` | дев | генерация тестовой выписки под засеянные данные | создаёт файл локально |
| `pnpm loadtest:queue` | дев | нагрузочный прогон очередей (`LOAD_ALFA`, `LOAD_PRIOR`) | ⚠ работает в **своём** Redis (`REDIS_PORT`, дефолт 6399) и делает `obliterate` своих очередей — **не запускать против дев/боевого Redis приложения** |
| `pnpm feedback:retention` | дев | ретенция отзывов: вырезает блок выписки из **закрытых** issue (`FEEDBACK_RETENTION_DAYS`, дефолт 30) | dry-run; `--apply` **редактирует** тела issue (не удаляет их), триаж-метаданные остаются |

## Подробности

- `scripts/alfa-oauth-test.mjs` (`pnpm oauth:test`) — живой прогон OAuth/выписки Альфы по
  `.env.alfabankby` (sandbox), маскировка секретов; см. `docs/ALFA_API.md`.
- `scripts/prior-oauth-test.mjs` (`pnpm prior:test`) — живой прогон Open Banking (СПР) Приорбанка
  по `.env.priorbank` (sandbox): `--gen-key`/`--oidc`/`--dcr`/consent→authorize→выписка; см. `docs/PRIOR_API.md`.
  **`--auth-method private_key_jwt`** (#444) переключает клиентскую аутентификацию на прод-метод:
  подписанный `client_assertion` в теле вместо Basic-заголовка. Флаг влияет и на `--dcr` (регистрацию) —
  DCR регистрирует **один** метод на приложение, поэтому регистрировать и ходить надо одинаково:

  ```bash
  # 1) зарегистрировать НОВОЕ приложение под прод-метод (нужен ключ: --gen-key)
  pnpm prior:test --auth-method private_key_jwt --dcr
  # 2) прогнать поток тем же методом (consent → authorize → обмен кода → выписка).
  #    Поток идёт по умолчанию; --full лишь отключает маскировку токенов в выводе.
  pnpm prior:test --auth-method private_key_jwt
  ```

  ⚠ Существующее sandbox-приложение зарегистрировано на `client_secret_basic` — переключить у него
  метод нельзя, нужна новая регистрация. Прогон доказывает **механику** подписи, но не поведение
  прод-стека: хост `:9345` требует СКЗИ (#41).
- **Оба банк-скрипта импортят чистые OAuth-ядра напрямую** (`alfaOauth.ts`/`priorOauth.ts`) —
  инлайн-копий билдеров URL/тел/claims больше нет, дрейф невозможен by construction (#45; раньше
  так возник баг auth Альфы #26). Node стрипает `.ts`-типы на лету (`--experimental-strip-types`
  в `oauth:test`/`prior:test`; ядра без импортов, лоадер не нужен). RS256-подпись и `node:crypto` —
  у Приора локально. Реальный путь скриптов теперь покрыт тестами ядер (`tests/{alfa,prior}Oauth.test.ts`).
  **Проводку `cfg→ядро`** (глюкод скрипта, а не билдеры) стережёт `tests/reconScriptsSmoke.test.ts` (#103):
  **спавнит** каждый скрипт офлайн (`--url-only`, сеть/секреты не нужны — Приору генерит одноразовый
  RSA-ключ во временный файл) и проверяет `exit 0` + что каждое **закреплённое** cfg-значение доехало
  куда надо: у Альфы — `client_id`/`scope`/`redirect_uri`/`state`/`base` в URL (и ни одного `undefined`),
  у Приора — **декод payload подписанного `request`-JWT** (`client_id`/`redirect_uri`/`openbanking_intent_id`
  из claims). Входы закреплены флагами/spawn-env (локальный `.env.*` не переопределяет уже заданное), так
  что чек герметичен. Скрипты нельзя `import()` в процессе Vitest (top-level `die()`→`process.exit` убьёт
  воркер), поэтому — субпроцесс; переименование экспорта ядра или сломанный `cfg.*`-байндинг роняют
  CI-чек, который юнит-тесты билдеров пропустят.
- `scripts/parse-statement.ts` (`pnpm parse:statement <файл>`) — разбор ручной выписки через
  канонический диспетчер `manualImport.ts` (оба формата: client-bank `***** ^Type=` и
  `1CClientBankExchange`) → печатает единый `StatementItem[]` (+ секционный вид для текстового
  формата). Node ≥ 22, нативный TS-стриппинг; `~/`-алиасы резолвит `scripts/lib/alias-loader.mjs`.
- `scripts/fuzz-allocation.ts` (`pnpm fuzz:allocation [seed] [N]`) — **исследовательский фузз-прогон
  алгоритма разнесения** (#109): прогоняет N случайных платежей против синтетической «CRM» через
  **реальные** чистые ядра (`recognizeByMatrices` → `routeIdentifier` → `resolveAllocation`) +
  mock-проводку по `PROCESSING.md` §2, сводит **логическую модель исходов** (распределение по 11
  категориям + «просадки»). Детерминированно (seeded PRNG). Dev-only, охват демонстрационный (5 из 11
  `IdentifierKind`, один id на назначение); mock `classify()` — **черновик** будущей `crm-sync`-проводки,
  свериться при её появлении (#109). **CI-gate композиции** ядер — не скрипт, а `tests/allocationPipeline.test.ts`.
- `scripts/verify-109-live.ts` (`pnpm verify:109`) — **живой READ-прогон разнесения** против засеянного
  тестового портала (`.env.b24test`): реальные ядра `companyLookup`/`stageLoader`/`invoiceLookup`/`paymentLookup`/
  `purposeMatch`/`resolveAllocation` на seed-фикстурах (компания по счёту, стадии, инвойс, IDOR-скоуп, company-пул,
  ambiguous, `filterByAccountNumber`). Только чтение; `~/`+extensionless-релятивы резолвит `alias-loader.mjs`.
  Dev-only. Подтверждён на живом портале (21 проверка).
- `scripts/verify-chat-live.ts` (`pnpm verify:chat`) — **живой прогон стадии 6 (чат-уведомления)** против
  тест-портала (`.env.b24test`): реальные `buildChatMessage` → `notifyChatViaRest` → `im.message.add`; проверяет
  непустой текст + **нейтрализацию BB плательщика** (нет живого `[url=…]`) + сумму с кодом валюты, шлёт сообщение
  в живой чат (recent-группа или self-диалог по `profile.ID`), верифицирует возврат id и **удаляет** тестовое
  сообщение (`im.message.delete`). Dev-only. Подтверждён вживую (6 проверок, msgId получен+удалён).
- `scripts/verify-distribution-live.ts` (`pnpm verify:distribution` / `--oauth` / `--keep`) — **живой прогон
  write-пути СП-леджера (#109/§9)** реальными ядрами `provisionDistributionSp`→`ensurePaymentElement`→
  `writeDistributionRow`→`recomputeNeedDistribution`: провижин двух СП+полей, карьер-элемент (idempotent),
  строка леджера 600 (idempotent по маркеру), пересчёт «осталось» 1000−600=400, вторая строка 400→0, полный
  teardown (items + app-SP-типы). **Пройден вживую 10/10 (#384–#386):** владелец выдал тест-вебхуку
  (`.env.b24test`) право `userfieldconfig.*`, поэтому default вебхук-режим гоняет **весь** write-путь —
  СП-типы **и UF-поля** + items + пересчёт (раньше упирался в `insufficient_scope` на `userfieldconfig.*`).
  Live-находки, зашитые в ядра: UF-поля кейсятся на **TYPE id** (`CRM_<id>`), `crm.item.*` адресует их
  **camelCase** (`ufCrm<id><Pascal>`), свой `PARENT_PAYMENT` UF вместо нативного `parentId<etid>`, сумму/валюту
  храним в **своих** UF-полях (`double`+`PRECISION:2`; встроенные `opportunity`/`currencyId` на элемент СП не
  пишутся). **`--oauth`** (`.env.b24oauth`, прод-транспорт `makePortalSdkCall`) — тот же прогон в проде;
  ⚠ требует `userfieldconfig` в granted-scopes (ре-consent) + ротирует refresh-токен (после — переизвлечь creds).
  Dev-only.
- `scripts/mutate-payment-live.ts` (`pnpm mutate:test` / `--apply` / `--revert`) — **живой прогон мутационного
  слайса** (§2): читает оплату seed-сделки, строит мутацию **тем же** чистым `buildAllocationMutation` и шлёт **тем
  же** `payAllocationViaRest`, что и `crm-sync`. **Dry-run по умолчанию** (печатает REST-вызов, ничего не пишет);
  `--apply` — реально `crm.item.payment.pay` + подтверждение `PAID=Y`; `--revert` — откат `sale.payment.update PAID=N`
  (scope `sale`), чтобы фикстура осталась переиспользуемой. **Режим стадии инвойса** — `--invoice <id> --stage <stageId>`
  (тот же билдер/транспорт → `crm.item.update` stageId; dry-run/`--apply`, печатает текущую и новую стадию).
  Dev-only, не часть SSG.
- `scripts/b24-sdk-test.mjs` (`pnpm sdk:test` / `--burst`) — **дев-смоук транспорта `@bitrix24/b24jssdk`** (#191):
  строит `B24Hook` из вебхука `.env.b24test`, делает пару REST-вызовов + батч и печатает статистику лимитера;
  `--burst` — 60 быстрых вызовов, чтобы увидеть само-троттлинг (без `QUERY_LIMIT_EXCEEDED`). Webhook-смоук
  транспорта `crm-sync` на SDK (`server/utils/b24Sdk.ts`) — но использует
  `B24Hook` (вебхук), **не** наш OAuth-путь; OAuth-смоук — `sdk:crm:test` ниже. Dev-only, токен в `.env.b24test`.
- `scripts/extract-oauth-from-docker.sh` + `scripts/sdk-crm-test.ts` (`pnpm sdk:crm:test` / `--force-refresh`) —
  **живой смоук OAuth-транспорта `crm-sync` на SDK (#191, теперь дефолт-транспорт).** Первый (запускать **на
  сервере** с backend-Docker) вытаскивает креды установленного портала: читает свежую строку `portal_tokens`,
  расшифровывает refresh (`B24_TOKEN_ENC_KEY`, формат `iv:tag:ct` base64) **внутри backend-контейнера**, рефрешит на
  `oauth.bitrix.info` и печатает блок `B24_OAUTH_*` (адаптация проверенного паттерна `ai-price-import`; **ротирует**
  refresh — БД-строка устареет, переустанови на тесте). Второй прогоняет **наш реальный** `makePortalSdkCall`
  (`B24OAuth`, как воркер) с этими кредами (in-memory токен-стор, без pg/Redis): `profile`+`crm.item.list` (проверка
  конверта `{result,…}`) и `--force-refresh` (бэкдейтит истечение → проверяет **refresh+persist**). Креды — в
  git-ignored `.env.b24oauth` (шаблон `.env.b24oauth.example`). Dev-only, не часть SSG.
- `scripts/todo-activity-test.ts` (`pnpm activity:test --company <id>` / `--apply`) — **живой смоук
  записи дела (#259/#495)** (универсальное дело). Гоняет **тот же** код, что crm-sync:
  `buildTodoActivity`→`writeTodoActivityViaRest`→`findActivityByMarker` по OAuth-транспорту
  (`makePortalSdkCall`, in-memory токен-стор, креды из `.env.b24oauth`). **Dry-run по умолчанию** (печатает
  params); `--apply` создаёт дело и проверяет **round-trip дедупа** (поиск маркера находит созданное дело).
  ⚠ Отвечает на вопрос, который юнит-тесты не могут закрыть: фильтрует ли портал универсальное дело по
  `ORIGINATOR_ID` (маркер ставится ВТОРЫМ вызовом, `todo.add` его не принимает). Тот же вопрос теперь задаёт
  себе и сам воркер на первой живой записи (`verifyMarkerOnce`) и при отрицательном ответе падает — так что
  скрипт больше не единственная преграда перед тихим накоплением дублей. Ценность осталась прежней: он даёт
  ответ **до** выката, а не на первом платеже клиента. Dev-only, ПИШЕТ в реальный CRM.
- `scripts/trigger-register-test.ts` (`pnpm trigger:test` / `--apply`) — **живой смоук регистрации триггера
  автоматизации (#79)**. Гоняет **тот же** билдер, что установка: `buildTriggerRegisterCall(B24_PAYMENT_TRIGGER)`
  → `crm.automation.trigger.add` по OAuth-транспорту (`makePortalSdkCall`, креды `.env.b24oauth`). **Dry-run по
  умолчанию** (печатает call); `--apply` регистрирует `CODE` и проверяет **round-trip** (`trigger.list` содержит
  его). `trigger.add` — идемпотентен + OAuth-контекст + права админа, вебхуком не проверить (класс #79).
  **Подтверждён вживую** (`bel.bitrix24.by`: CODE `cba_payment_received` зарегистрирован, в списке). Dev-only.
- `scripts/seed-test-b24.mjs` (`pnpm seed:b24` / `--list` / `--purge`) — **идемпотентный посев тестовых
  данных в живой тестовый портал Б24** для ручной проверки #109 (стадия 4/§2 `PROCESSING.md`): смарт-
  процессы (с направлениями / без — `entityTypeId` назначается автоматически, на подтверждённом
  портале вышли `1032`/`1030`), смарт-счета (оплачен `DT31_11:P` /
  открытый `:N` / не оплачен `:D`=SEMANTICS=F, исключается `invoiceLookup`), сделки в разных воронках
  (сделка Опт несёт **реальную оплату** — объект `crm.item.payment`, цель `deal-payment` #109: товарная
  позиция → `payment.add` → `payment.product.add` → `payment.pay` — плюс привязанный оплаченный счёт;
  Розница без оплаты), товары, компании-клиенты (с реквизитами и без → путь
  UNMATCHED), «мои компании» (`isMyCompany=Y` + наш счёт для §2 Этап C). Всё под тегом `[TEST]`/XML_ID
  `CBATEST_`; повторный прогон обновляет, а не дублирует (восстановление при смене портала). Хук — из
  **git-ignored** `.env.b24test` (`B24_TEST_WEBHOOK`, шаблон `.env.b24test.example`; токен не коммитим).
  **Порядок purge важен**: банк-деталь → реквизит → компания, ПОКА компания жива — иначе Б24 осиротит
  реквизиты без прав на удаление, и «зомби»-банк-деталь навсегда испортит поиск по счёту. **Расчётный
  счёт `RQ_ACC_NUM` не уникален** (может быть на нескольких компаниях). **Ограничение:** удалить сделку с
  оплаченной оплатой нельзя без scope `sale` (`crm`-only токен → `insufficient_scope`); purge такую сделку
  пропускает с предупреждением. Подтверждено вживую: `companyLookup` (счёт→компания), поля смарт-счёта,
  реальная оплата сделки. Dev-only, не часть SSG.
- **Тестовый портал Б24 и скоупы вебхука** (для ручной проверки #109; сам портал сменный —
  восстанавливаем данные `pnpm seed:b24`). Вебхук храним **только** в git-ignored `.env.b24test`
  (`B24_TEST_WEBHOOK`), в репозиторий он не попадает; при смене портала переписываем эту строку.
  Скоупы вебхука (гейт того, что можно проверить руками):
  - **`crm`** — есть; хватает для всего текущего seed (компании/реквизиты/счета/сделки/смарт-процессы/
    товары) и путей #109 (поиск компании, инвойс, оплата сделки — создание/проведение, company-пул оплат).
  - **`sale`** — **в скоупах приложения** (`B24_REQUIRED_SCOPES`, #172) и на тестовом вебхуке. Роль в рантайме:
    **`order-id`** — `sale.payment.list` по `orderId` даёт id оплат заказа (`crm.item.payment.list` `orderId` не отдаёт),
    которые вызывающий пересекает с company-пулом (IDOR). `sale.order` **не несёт** связки со сделкой/компанией
    (`companyId=null`) → сам по себе к плательщику не привязать, поэтому `sale` — только для маппинга `orderId`→оплаты,
    а не как граница авторизации. Также `sale` нужен для **сторно** (`sale.payment.update PAID=N`, dev `--revert`/`--purge`).
  - **`documentgenerator`** — под мост-документ (`crm.documentgenerator.document.list`, `document-number` → сущность).
    **LIVE-VERIFIED** (#109): сгенерирован документ из шаблона #1 на seed-сделку → обратный `filter:{number}` работает,
    мост резолвит сущность (`pnpm verify:109` #8). **Теперь и в `B24_REQUIRED_SCOPES` приложения** (wiring в hot-path).
  - **`im`** — понадобится позже для уведомлений в чат (стадия 6, `im.message.add`); на текущем тестовом
    хуке не проверялось.
  Требуемые скоупы **самого приложения** (не вебхука) — `app/config/b24.ts` `B24_REQUIRED_SCOPES`
  (`crm`, **`sale`** (#172, `order-id`→`sale.payment.list`), `im`, **`documentgenerator`** (#109, `via-document` мост),
  **`userfieldconfig`** (#408 — `userfieldconfig.add` при провижининге полей dist-СП), `user_brief`, `placement`).
  ⚠ Добавление `sale`/`documentgenerator`/`userfieldconfig` **потребует ре-consent** на уже установленных
  порталах (мост-документ теперь в hot-path — `crm.documentgenerator.document.list` в `crm-sync`;
  без `userfieldconfig` кнопка «Настроить смарт-процессы» отказывает).
- **Скрипты крипто-разведки переехали.** `bee2evp-probe.sh` (проба открытого BY-крипто стека против
  прод-хоста банка) и `by-ca-bundle.sh` (сборка bundle корней ГосСУОК) жили здесь, пока мы решали,
  можно ли обойтись без проприетарного СКЗИ. Решили — можно, и всё это устройство теперь в
  [bx-shef/bee2-tls-gateway](https://github.com/bx-shef/bee2-tls-gateway). У нас остался только
  результат: замер и его следствия — [`PRIOR_API.md`](PRIOR_API.md), раздел про СКЗИ.
  ⚠ Сами файлы туда **ещё не доехали** — передача идёт задачей
  [bee2-tls-gateway#48](https://github.com/bx-shef/bee2-tls-gateway/issues/48); до её закрытия брать
  их из истории этого репозитория (коммит `c9a53d2`).
  ⚠ Оба по-прежнему **запускаются из Беларуси** (порт 9345 и `nces.by` недоступны иначе) — это
  свойство задачи, а не репозитория.
- `scripts/lib/*.mjs` — общая обвязка банк- и seed-скриптов (одинаковые запуск/проверка/вывод):
  `demo-utils`/`env` (чистые, покрыты тестами), `http` (единый `httpRequest`, TLS-проверку не отключает),
  `cli` (цвета `C`, префиксы `ok/warn/err/head`, `die`, кросс-платформенный `openBrowser` — URL-гейт
  `openBrowser` покрыт тестом `tests/cliOpenBrowser.test.ts`, #45).

---

Навигация: [указатель документов](README.md) · банки — [`ALFA_API.md`](ALFA_API.md), [`PRIOR_API.md`](PRIOR_API.md).
