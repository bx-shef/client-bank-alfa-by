# Реестр серверных модулей разнесения оплат

> Last reviewed: 2026-08-23

Карта модулей, из которых собран путь «распознали номер в назначении → нашли цель в CRM → решили,
куда разнести → провели». **Нормативная логика** (что должно происходить и почему) — в
[`PROCESSING.md`](PROCESSING.md) §2/§4; здесь — какой файл за что отвечает и **живые находки**:
имена полей и формы ответов Bitrix24, подтверждённые на реальном портале.

Вынесено из `CLAUDE.md`, где занимало 200 строк и мешало читать карту приложения. Ценность этих
записей в том, что почти каждая — след потраченного дня: REST Bitrix24 в документации и в реальном
ответе портала расходится, и такие расхождения обходятся дорого.

⚠ Live-находки помечены. Если правите вызов, к которому они относятся, — перепроверяйте на портале,
а не на документации.

## Модули

⚠ **Охват: и ПОИСК цели, и ЗАПИСЬ.** Раньше здесь лежал только слой поиска
(`*Lookup`/`intentResolver`/`negativeStages`), и это выглядело как осознанный скоуп — но одна из
самых дорогих находок проекта живёт ровно на стыке двух ПИШУЩИХ модулей (см. `paymentRegistryWrite`
ниже: разнесение и реестр делят один идемпотентный маркер, и порядок вызова решает, появятся ли
данные вообще). Документ существует ради таких находок, поэтому write-слой сюда входит.

- `server/utils/companyLookup.ts` — поиск компании по счёту (контрагент и «моя компания»); живёт
  вне этого файла исторически, но находки о ФИЛЬТРАХ B24 замерены именно на нём (тестовый портал,
  2026-08-21). ⚠ Поведение у ДВУХ ПОКОЛЕНИЙ списковых методов РАЗНОЕ — замерено на обоих, и
  переносить выводы между ними нельзя:
  - **старое поколение** (`crm.requisite.bankdetail.list`, `crm.requisite.list`,
    `crm.activity.list`…): ⚠ **неизвестное поле фильтра игнорируется МОЛЧА** — список возвращает
    ВСЕ строки, ошибки нет (`filter: {RQ_TYPO_FIELD: …}` → все реквизиты портала). Разъехавшееся
    имя поля превращает «поиск по счёту» в «первая компания портала», поэтому
    `resolveCompanyIdsByAccount` сверяет каждую возвращённую строку с искомым счётом
    (`matchingEntityIds`, select запрашивает само поле);
  - **новое поколение** (`crm.item.list`): неизвестное поле **отвергается громко** —
    `400 INVALID_ARG_VALUE "field … is not allowed in filter"` (замерено 2026-08-23 повторно, для
    простого и для UF-поля одинаково). То есть дрейф имени поля в `invoiceLookup`/`itemByIdLookup`
    роняет джобу, а не отдаёт чужие строки — сверка строк там не нужна ради этого вектора;
    ⚠ **но у того же кода есть вторая роль** (#572): когда имя поля пришло не из нашего кода, а из
    «карты сопоставления» (`deal-field`/`smart-field`/`smart-id`), тот же отказ означает **ошибку
    НАСТРОЙКИ**, и ронять им джобу вредно — повтор даст тот же результат все три раза, а в
    логе это выглядит отказом транспорта. Поэтому `resolveConfigured` (`intentResolver.ts`) ловит
    его ТОЛЬКО на этих трёх видах и отдаёт статус `misconfigured`; наши собственные запросы
    по-прежнему падают громко. Код ошибки доезжает через `PortalRestError` (`portalError.ts`) —
    ⚠ до #572 он терялся: `makeSdkRestCall` бросал голый `Error` из `getErrorMessages()`, а тот
    отдаёт только `e.message`, равный ОПИСАНИЮ без кода. ⚠ И даже это было мимо: `INVALID_ARG_VALUE`
    для SDK — код ЖЁСТКИЙ (`RestrictionManager.BUILT_IN_HARD_ERROR_CODES`), поэтому
    `abstract-http.mjs` не возвращает неуспешный результат, а БРОСАЕТ свой `AjaxError` — ветка
    `!res.isSuccess` для этого случая недостижима вовсе, и `portalErrorCode` читает код с ЛЮБОЙ
    формы ошибки;
    ⚠ **Набора кодов ДВА, и это замер, а не симметрия ради красоты.** У `deal-field`/`smart-field`
    админ задаёт ИМЯ ПОЛЯ, и ошибка приходит как `INVALID_ARG_VALUE`. У `smart-id` имени поля в
    запросе нет вовсе (фильтр `{id, companyId}`) — админ задаёт `entityTypeId`, и замер 2026-08-23
    дал ДРУГИЕ коды: несуществующий смарт-процесс → `NOT_FOUND` («Смарт-процесс не найден»),
    `entityTypeId: 0` → `ENTITY_TYPE_NOT_SUPPORTED`, нечисловой → код `100`. Первая редакция ловила
    только `INVALID_ARG_VALUE` и для `smart-id` не сработала бы НИ РАЗУ на самой вероятной ошибке
    админа — при зелёных тестах. ⚠ `NOT_FOUND` на пути СДЕЛКИ в набор не входит: там `entityTypeId`
    — наша константа (2), и проглотив его, мы спрятали бы НАШУ ошибку за «проверьте настройки»;
  - ⚠ **Неизвестное поле в `select` портал ИГНОРИРУЕТ молча** (HTTP 200, замерено 2026-08-23) —
    строг только фильтр. А вот `parentId2` на СДЕЛКЕ отвечает ошибкой «An entity type can't be a
    parent/child type to itself»: `selectFields` (`itemByIdLookup.ts`) её уже обходит, и замер это
    независимо подтвердил;
  - ⚠ **`companyId` на смарт-процессе БЕЗ привязки к клиенту — FAIL-CLOSED** (замерено 2026-08-23,
    `pnpm probe:sp-filter`). Комментарий в `intentResolver` годами предупреждал об обратном («B24
    may ignore the unknown filter key → scope fails open»), и это оказалось неверно, причём исход
    третий — не fail-open и не громкий отказ. СП, созданный с `isClientEnabled: false`, содержит
    один элемент; `crm.item.list` с `filter: {companyId: <чужой>}` **принимается** и возвращает
    `items: []`, `total: 0`, тогда как без фильтра тот же вызов отдаёт этот элемент.
    ⚠ Вторая сторона замера важнее первой: на таком СП фильтр по компании не совпадёт **никогда** —
    элементу негде нести `companyId`. Значит указавший такой СП администратор получает вечное «цель
    не найдена» без единой подсказки. Это тупик настройки, а не дыра в безопасности;
  - ⚠ **`%` в ЗНАЧЕНИИ фильтра работает как подстрока В ОБОИХ поколениях** (`%30120A%` матчит на
    старом, `accountNumber: '%СЧ%'` — на `crm.item.list`, оба замерены). До companyLookup такой
    ввод доезжает из выписки (в ручном пути — из файла) и закрыт сверкой строк; до
    `invoiceLookup` — не доезжает: `recognizeByMatrices` пропускает только цифры и литералы маски
    (значение с `%` не матчится литералом), `%` туда может вписать лишь админ в СВОЮ маску;
  - **точный фильтр регистронезависим** (`by11…` находит `BY11…`) — сверка строк поэтому тоже
    сравнивает без регистра, иначе отбрасывала бы совпадения, которые портал уже сделал.

  Отдельно, **`RQ_IIK`** (повторный замер, сходится с `PROCESSING.md` §Грабли): 28-значный IBAN
  `crm.requisite.bankdetail.add` отвергает (400 «Array» — валидация формата), а **значение
  ≤20 знаков записывается и читается обратно** (проверено на 20-значном, проба удалена). Фолбэк
  `RQ_ACC_NUM→RQ_IIK` оправдан: короткие/легаси номера в поле лежать могут, а промах по нему —
  лишний запрос, не ошибка.
- `server/utils/invoiceLookup.ts` — чистый lookup смарт-счёта `findInvoicesByNumber(accountNumber,
  {companyId, isNegativeStage?}, call)`: `crm.item.list` `entityTypeId=31`, фильтр по номеру **И
  компании** (IDOR-скоуп), отбрасывает отрицательные стадии (предикат от вызывающего) → массив
  `AllocationCandidate` (сумма=`opportunity`, валюта=`currencyId`, **`dealId`=`parentId2`** — связь
  смарт-счёт→сделка, #229, для `collapseSameTarget`; чистый хелпер `parentDealId` нормализует к
  положительному целому). **Имена полей подтверждены на живом портале**:
  `accountNumber`/`companyId`/`mycompanyId`/`stageId`/`opportunity`/`currencyId`/`parentId2` (только у сделко-связанного счёта).
- `server/utils/allocationFactStore.ts` — **УДАЛЁН (§9.3 #6, готово)**. Персистентный Postgres-стор факта
  разнесения `allocation_fact` полностью снят: идемпотентность/аудит/сторно разнесения (amount **и** триггеры)
  живут на строке/маркере dist-СП (`writeLedger`/`writeTriggerFact`, `status`). Модуль и таблица удалены
  (`server/db/client.ts` — `DROP TABLE IF EXISTS allocation_fact` на старте, идемпотентно). `allocationFactKey`
  (`app/utils/allocation.ts`) сохранён — строит маркер строки dist-СП.
- `server/utils/allocationApplied.ts` — **чистое чтение состояния цели** (Фаза A, DI над `RestCall`, тесты):
  `readAllocationApplied(target, call, opts)` — идемпотентный пре-чек мутации разнесения по **состоянию в B24**,
  не по `allocation_fact`: `deal-payment` → оплата `paid='Y'` (`crm.item.payment.list`, реюз `paymentListParams`/
  `extractPayments`); `invoice` → уже на `opts.invoicePaidStageId` (`crm.item.list` 31 по id). Триггер-цели → `false`
  (у firing нет читаемого состояния). Точнее факта (факт пишется ПОСЛЕ оплаты → чтение состояния закрывает окно
  ре-оплаты при крэше между оплатой и фактом). Проведён в `crm-sync` как деп `isTargetApplied`. **Live-verified**
  (`bel.bitrix24.by`: инвойс #39 `DT31_7:P` → своя стадия=true/чужая=false; чтение оплат сделки отработало).
- `server/utils/stageLoader.ts` — чистый **loader «отрицательных» стадий** (DI над `RestCall`, тесты):
  `loadNegativeStages(stageEntityId, call)` — `crm.status.list` → множество `STATUS_ID` с `SEMANTICS='F'`;
  билдеры `ENTITY_ID`: `invoiceStageEntityId(catId)` (`SMART_INVOICE_STAGE_<catId>`), `dealStageEntityId(catId)`
  (`DEAL_STAGE` для воронки 0 / `DEAL_STAGE_<catId>` — **не** `DYNAMIC_…`, подтверждено вживую) и
  `smartProcessStageEntityId(etid, catId)` (**кастомный смарт-процесс** — `DYNAMIC_<etid>_STAGE_<catId>`, стадии
  `DT<etid>_<cat>:FAIL`=`SEMANTICS='F'`; **всегда** реальный id категории — даже СП «без направлений» имеет свою
  дефолт-категорию, не `0`; подтверждено вживую на `DYNAMIC_1032_STAGE_67` и `DYNAMIC_1030_STAGE_63`);
  `makeIsNegativeStage(set)` строит предикат, который принимает `findInvoicesByNumber` (раньше инъектировался
  «снаружи»); `loadInvoiceNegativeStage`/`loadDealNegativeStage`/`loadSmartProcessNegativeStage` — loader+предикат
  одним вызовом. Читает **оба** формата семантики (легаси верхний `SEMANTICS='F'` — он и на живом портале; и
  современный `EXTRA.SEMANTICS='failure'`). **`loadStageExclusions(entityId, call, {includeSettled})`** — за
  **один** `crm.status.list` отдаёт `{negative, settled}`: `settled` = стадии **успеха/оплаты** (`SEMANTICS='S'`/
  `EXTRA.SEMANTICS='success'`, `extractSettledStageIds`) — нужно, чтобы **оплаченный инвойс** не пере-матчился на
  вторую оплату той же суммы (симметрично `paid:'Y'` в `paymentLookup`; подтверждено вживую: `DT31_11:P`=`'S'`,
  сделка `WON`=`'S'`). Множества **раздельны**: предикат исключает `negative ∪ settled`, но fail-open считает
  **только** negative.
  **Подтверждено вживую**: инвойс «Не оплачен» `DT31_11:D`; сделка `LOSE`/`APOLOGY`; смарт-процесс `DT1032_67:FAIL` = `SEMANTICS='F'`. ⚠ **fail-open**:
  пустое множество = «ничего не отрицательно» (неотличимо от битого запроса) — на проводке в `crm-sync` алертить,
  если для известной категории пусто.
- `server/utils/itemByIdLookup.ts` — чистый **резолвер цели по id** `findCandidateById(kind, entityTypeId, id,
  {companyId, isNegativeStage?}, call)` для стратегии `by-id` — три идентификатора, у которых значение = собственный
  id целевой сущности: `invoice-id`→инвойс, `deal-id`→сделка, `smart-id`→смарт-процесс (все — один `crm.item.list`,
  разный `entityTypeId`). **Не** `order-id`/`payment-id` — те идут к `deal-payment` (объект `crm.item.payment.*`):
  `payment-id` — по собственному id в company-пуле (`filterByPaymentId`, #172), `order-id` — через `sale.payment.list`
  (`orderId`→id оплат) ∩ company-пул (`saleLookup.findOrderPaymentIds`+`filterByPaymentIds`, `sale`-скоуп, #172). Запрос фильтром **id+companyId** (id из назначения недоверенный →
  IDOR-скоуп в запросе, чужая сущность не вернётся) + отсев отрицательной стадии → `AllocationCandidate`.
  `crm.item.list`, а не `crm.item.get` (тот бросает `NOT_FOUND`; список отдаёт пусто). Подтверждено вживую: стадия
  категорийной сделки несёт префикс `C<cat>:` (`C5:LOSE`) — совпадает с `DEAL_STAGE_<cat>`. **`select` строит
  `selectFields(entityTypeId)`: `parentId2` (ссылка на сделку, #229) выбирается для инвойса/СП, но НЕ для сделки
  (`entityTypeId=2`) — там `parentId2`=«родитель типа 2»=сама сделка, self-reference, портал отвергает live
  («An entity type can't be a parent/child type to itself»; #109 — вскрыто мостом via-document, `deal-id`-путь
  раньше живьём не гонялся). Теперь `findCandidateById('deal',2,…)` подтверждён вживую (`pnpm verify:109` #8).** Amount-цели
  (invoice/deal-payment) сверяют сумму (нефинитная → `null`, fail-closed как в `invoiceLookup`), триггер-цели
  (deal/smart-process) её игнорируют. **`findCandidateByField(kind, entityTypeId, fieldName, value, opts, call)`** —
  стратегия `by-config-field` (`deal-field`, §4): тот же `crm.item.list`, но фильтр по **настроенному полю**
  `{[fieldName]:value, companyId}` (имя поля из «карты сопоставления»; маска `[A-Za-z][A-Za-z0-9_]*` — нет инъекции
  ключа фильтра). Общий маппинг строки-ответа в кандидата (`candidateFromItem`) — с `findCandidateById` (нет дрейфа).
- `server/utils/paymentLookup.ts` — чистый **резолвер оплаты сделки** `findDealPayments(dealId, {includePaid?}, call)`
  для цели `deal-payment` (§2, действие `payment.pay`): `crm.item.payment.list` по **известной** сделке
  (`entityId`+`entityTypeId=2`) → кандидаты `deal-payment` (`id`=id оплаты, `amount`=`sum`, `currency`, `dealId`).
  **Подтверждено вживую** (seed-сделка с реальной оплатой): ответ — массив **прямо** в `result` (не `result.items`),
  поля `id`/`accountNumber`/`paid`(`Y`/`N`)/`sum`/`currency`; оплаченные (`paid='Y'`) в кандидаты не берём
  (нечего проводить), нефинитная сумма — пропуск. Разрешает `deal-payment` **когда сделка уже известна и
  скоуплена по компании**; сам company-скоуп в `crm.item.payment.list` не встроить (нет поля `companyId`) —
  предусловие на вызывающем. **`findCompanyDealPayments(companyId, {includePaid?, isNegativeStage?}, call)`** —
  **company-scoped пул** кандидатов `deal-payment` (IDOR-safe путь для `order-number`/`payment-number` и источник
  amount-матчинга §2): `crm.item.list` сделки компании (фильтр `companyId`) → отсев отрицательной стадии → на
  каждую сделку `findDealPayments` (N+1; `crm.item.payment.list` **не батчится**, per-deal вызовы **последовательны**
  — rate-safe by construction; bounded concurrency — за лимитером #191). **Список сделок пагинируется** (`start`/top-level
  `total`, кап `MAX_DEAL_PAGES`; #191): у компании с >50 сделками часть пула иначе молча терялась → неверный
  `manual`/`none`. Нет `total` → одностраничный фолбэк. **Сделка проксирует заказ**: `crm.item.payment.list`
  по сделке отдаёт оплаты заказа (та же `sale.payment` id, `orderId` за ними) — «оплата заказа» = «оплата сделки»,
  отдельного lookup заказа нет. **Глобальный** `sale.payment.list` находит оплату по номеру, но её `sale.order` **не
  несёт связки со сделкой/компанией** (`companyId=null` у CRM-заказов) — привязать к компании плательщика нельзя,
  поэтому для `order-number`/`payment-number`/`payment-id` используем company-scoped обход (не `sale.*`). Для
  **`order-id`** (id заказа, которого нет в crm-оплате) — `saleLookup` ниже (`sale.payment.list` по `orderId`) с
  обязательным **∩ company-пул** (IDOR).
- `server/utils/saleLookup.ts` — **`order-id`→id оплат заказа** `findOrderPaymentIds(orderId, call)` (`sale`-скоуп, #172):
  `sale.payment.list` фильтром `orderId` → **массив id оплат** (ответ `result.payments[]`, поля `id`/`orderId` подтверждены
  вживую; `crm.item.payment.list` `orderId` **не** отдаёт — потому `sale`). Пустой `orderId` → `[]` без REST (пустой фильтр
  листнул бы все оплаты); гард — сверка `orderId`-эха (портал мог проигнорить фильтр). **Список глобальный, не company-scoped** —
  вызывающий **обязан** пересечь ids с company-пулом (`filterByPaymentIds`), это и держит IDOR. DI, тесты.
- `server/utils/documentLookup.ts` — **мост-документ** `findDocumentEntities(number, call)`: `document-number` из
  назначения → `crm.documentgenerator.document.list` (фильтр `number`) → **массив** привязанных сущностей
  `{entityTypeId, entityId}[]` (ответ `result.documents[]`; номер документа **не** уникален по порталу —
  нумерация генератора per-шаблон/редактируема, поэтому список, как в `invoiceLookup`). Дальше вызывающий
  **перебирает** и **роутит** каждый ref по `entityTypeId` (2→сделка, 31→инвойс, кастом→смарт) через
  `itemByIdLookup` **с проверкой компании**, собирает **все прошедшие** кандидаты (дальше их разводит
  `summarizeAllocation`) — номер недоверенный, метод без
  company-фильтра, IDOR-скоуп на вызывающем (как by-id в `identifierDispatch`, `strategy: 'via-document'`).
  **Защитный гард**: `doc.number` сверяется с запрошенным после ответа. **LIVE-VERIFIED** (тест-портал: документ из
  шаблона #1 на сделку): конверт `{result:{documents:[…]}}` + обратный `filter:{number}` **работает** (возвращает
  документ; несуществующий номер → `[]`), `entityTypeId`/`entityId` присутствуют. ⚠ **Live-находка:** портал
  **игнорирует `select`** — ответ **всегда** несёт `downloadUrlMachine`/`pdfUrlMachine` (URL с живым access-токеном);
  `findDocumentEntities` берёт только `number`/`entityTypeId`/`entityId`, остальное отбрасывает (утечки нет), но сырой
  ответ **нельзя логировать целиком**. Scope **`documentgenerator`** (метод под `crm.documentgenerator.*`; добавлен в
  `B24_REQUIRED_SCOPES` вместе с wiring, #109 — потребует ре-consent).
- `server/utils/intentResolver.ts` — **чистый диспетчер `resolveIntentCandidates(intent, ctx, call, deps)`** (слайс 2
  капстоуна): по распознанному `RecognitionIntent` (§4) вызывает нужный резолвер сущности и отдаёт `IntentResolution`
  (`status: 'resolved'|'unsupported'`, `candidates`, `reason`). Резолверы **инъектируются** (чистый роутинг тестируется
  без сети). Диспатчатся подтверждённые вживую стратегии: `invoice-number`→`findInvoicesByNumber`, `invoice-id`/`deal-id`→
  `findCandidateById` (фиксированный `entityTypeId` 31/2), `payment-number`→`findCompanyDealPayments`+`filterByAccountNumber`,
  **`order-number`→`findCompanyDealPayments`+`filterByOrderNumber`** (order-префикс `<заказ>/<seq>`, #172, live-confirmed —
  делит тот же пул с `payment-number`, фетч один раз), **`order-id`→`findOrderPaymentIds`+`filterByPaymentIds`**
  (`sale.payment.list` по `orderId` → id оплат заказа **∩** company-пул → IDOR-safe, `sale`-скоуп, #172, live-confirmed;
  делит тот же пул) (по `ctx.companyId` — IDOR-скоуп плательщика, отсев отрицательных
  стадий). **`deal-field` (`by-config-field`, §4) — подключён:** имя поля берётся из `ctx.configFields['deal-field']`
  («карта сопоставления» настроек), сущность — сделка (`entityTypeId` фикс. 2), поиск `findCandidateByField`
  (`crm.item.list` фильтр `{[поле]:значение, companyId}`, IDOR-скоуп; имя поля валидируется маской `[A-Za-z][A-Za-z0-9_]*`
  — нет инъекции ключа фильтра); нет настроенного поля ⇒ `unsupported`. **`smart-id`/`smart-field` — подключены:**
  портало-специфичный `entityTypeId` берётся из `configFields['smart-entity']` (`parseConfiguredEntityTypeId` —
  положит. целое, иначе fail-closed `unsupported`); `smart-id` → `findCandidateById('smart-process', <etid>, value)`,
  `smart-field` → `findCandidateByField('smart-process', <etid>, configFields['smart-field'], value)` (нужны оба).
  Кандидат несёт `entityTypeId` (для `OWNER_TYPE_ID` триггера, #79). **`document-number` — ПОДКЛЮЧЁН (мост
  `via-document`, live-verified):** `findDocumentEntities(value)` → на каждый ref чистый `routeDocumentRef`
  (`entityTypeId` 2→deal / 31→invoice / == `configFields['smart-entity']`→smart-process; иначе — пропуск) →
  `findCandidateById(<kind>, <etid>, entityId, {companyId})` **со скоупом по компании плательщика** (IDOR — номер
  недоверенный, метод без company-фильтра); первые прошедшие кандидаты. Все виды `IdentifierKind` теперь
  диспатчатся (нет `unsupported`-веток по kind — только по отсутствию конфига у config-driven видов).
  Свитч по `kind` покрывает все виды — исчерпывающий by construction (нет `default`, каждая ветка `return`):
  пропущенный вид роняет `typecheck:server` (TS2366; `server/**` теперь в typecheck, #187), плюс страхует тест
  (гоняет каждый `IdentifierKind` через диспетчер). **Батч-резолвер `resolveIntentsForOp(intents, ctx, call, deps)`**
  резолвит все интенты одной операции, **тянет пул оплат один раз** (`findCompanyDealPayments` company-scoped и не
  зависит от значения → не сканируем компанию на каждый `payment-number`/`order-number`, #191); общий
  `resolveFromPool`-хелпер у одиночного и батч-путей (нет дрейфа). **Встроен в `crm-sync` (слайс 3):** `resolveIntents`-обёртка воркера зовёт
  `resolveIntentsForOp` на матч-компанию → лог кандидатов (`onResolved`), счётчик `resolved`; пока log/count без
  записи. **Отсев отрицательных стадий (`isNegativeStage`) — сделан** (`negativeStages.ts`, ниже): предикат
  грузится ленивым `loadNegativeStagePredicate` ровно один раз на джобу и прокидывается в `resolveIntentsForOp`.
  **Запись факта разнесения + чат ошибок — сделаны (#184; §9.3 #6):** durable-запись = строка dist-СП (`writeLedger`) + `notifyError`.
  **Мутация портала для `deal-payment` + `invoice` — сделана:** гейт `autoDistribute` (default OFF) →
  `deal-payment`: `crm.item.payment.pay`; `invoice`: `crm.item.update` на стадию `allocation.invoicePaidStageId`
  (нет стадии в настройках ⇒ инвойс не трогаем)
  (`allocationMutation.ts` билдер + `allocationMutationWrite.ts` транспорт, конверт-aware applied-детект,
  идемпотентный порядок mutation-before-fact),
  счётчик `distributed`; подтверждено вживую (`pnpm mutate:test` + live apply/revert стадии инвойса). **Триггер-цели
  (deal/smart-process): проводка в hot-path подключена — best-effort (#79)** (`buildTriggerExecution`/`executeTriggerViaRest`
  за гейтом `autoDistribute`+`triggerCode`; дедуп по kind+id (within-run) + **маркер dist-СП** (`hasTriggerFact`/
  `writeTriggerFact`, §9.3 #6 — Postgres на триггер-пути ретайрен), запись фаершего = нулевая строка dist-СП,
  `distributed` только на firing; сбой глотается (single-shot — промах не пере-пробуется)). Регистрация CODE на установке — сделана (best-effort);
  **регистрация И firing подтверждены вживую** (`pnpm trigger:test --apply --fire`, `bel.bitrix24.by`: `executeTriggerViaRest`
  → `{result:true}` на сделке OWNER_TYPE_ID=2 и смарт-процессе OWNER_TYPE_ID=1044; незарегистрированный CODE → `not registered`).
- `server/utils/negativeStages.ts` — чистый билдер **единого предиката `isNegativeStage` на весь портал**
  (инвойсы + сделки + смарт-процесс, если настроен) над `stageLoader`: `crm.category.list` (на тип объекта) → на каждую воронку
  `crm.status.list` → **объединение** исключаемых стадий. **Инвойсы грузятся с `includeSettled:true`** →
  предикат исключает `negative(инвойс) ∪ settled(инвойс) ∪ negative(сделка) ∪ negative(СП, если настроен `smart-entity`)`: **оплаченный инвойс (`:P`,
  `SEMANTICS='S'`) больше не кандидат** (иначе вторая оплата той же суммы молча садилась на закрытый счёт и —
  при `autoDistribute` — пере-проводила `crm.item.update`). Сделки — только negative (WON-сделку не исключаем:
  её namespace иной — `WON` без `DT31_`, а «оплаченность» сделки решается на уровне оплаты `paid:'Y'`).
  Namespace'ы стадий не пересекаются (инвойс `DT31_<cat>:…`, сделка `LOSE`/`C<cat>:LOSE`; candidate.stageId ≡
  STATUS_ID, подтверждено вживую) → один предикат обслуживает инвойсы, сделки и company-пул оплат.
  `crm.category.list` **пагинируется** (метод одностраничный, max 50; >50 воронок иначе молча теряются — fail-open).
  Диагностика по типу (число воронок/отрицательных стадий + **`emptyCategories`** — сколько отдельных воронок
  вернули 0 негативов; settled в счётчик **не** идёт) → **fail-open алерт** `failOpenEntities` (**0 отрицательных
  стадий** инвойсов ИЛИ сделок **ИЛИ `emptyCategories>0`** = битый запрос/урезанные права → воркер логирует warning
  с разбивкой по типу; **гранулярность #242**: агрегат маскирует одну урезанную воронку среди многих, поэтому
  считаем и пер-воронковые пустышки; **включая `categories===0`** — когда `crm.category.list` вообще не отдал
  воронки: пустое множество исключений = «ничего не исключили», алертим независимо). Грузится **раз на джобу**
  (лениво, только когда первая операция реально резолвит намерение). **`stripDealCategoryPrefix`** — предикат матчит и сырой `stageId`, и без
  `C<cat>:`-префикса (форма stage-id дефолтной воронки сделки — `LOSE` vs `C0:LOSE` — вживую не подтверждена;
  strip false-negative-safe: только добавляет матч по фиксированным `LOSE`/`APOLOGY`, валидного кандидата не
  теряет). ⚠ **live-verify формы дефолтной воронки — гейт перед записью разнесения** (сейчас log/count).
  **Смарт-процессы включены в предикат** (когда `entityTypeId` СП настроен, `configFields['smart-entity']` →
  `parseConfiguredEntityTypeId`): `buildPortalNegativeStagePredicate(call, batch, smartEntityTypeId?)` грузит FAIL-стадии
  СП (`DYNAMIC_<etid>_STAGE_<cat>` → `DT<etid>_<cat>:FAIL`, live-confirmed) и юнионит их — лост-элемент СП больше не
  кандидат на разнесение; namespace `DT<etid>_…` не пересекается с инвойсом (`DT31_…`)/сделкой (`LOSE`). СП **не
  настроен** ⇒ его стадии не грузятся (поведение прежнее, СП не отсеивается). `handlers.ts` прокидывает разобранный
  etid в `loadNegativeStagePredicate`; `failOpenEntities` и диагностика расширены на `smartProcess` (участвует в
  fail-open-алерте только когда настроен). DI, тесты (`tests/negativeStages.test.ts`).

- `server/utils/paymentRegistryWrite.ts` + `server/utils/distributionLedgerWrite.ts` — ЗАПИСЬ элемента
  смарт-процесса «Платежи». Оба зовут один `ensurePaymentElement`, идемпотентный по маркеру операции
  (= ключ дедупа дела).
  ⚠ **Находка (#575, 2026-08-22): `ensurePaymentElement` НЕ дописывает поля элементу, который нашёл.**
  Он find-or-create, ветки update у него нет. А `writeLedgerAllocation`/`writeTriggerLedgerFact` зовут
  его БЕЗ полей реестра. Значит порядок вызова в `handleCrmSyncJob` решает, будут ли у платежа колонки
  выписки вообще: отработай разнесение первым — элемент создался бы голым, реестр нашёл бы маркер
  занятым и тихо вышел, и это не посчиталось бы даже отказом. Поэтому запись реестра идёт **до** блока
  разнесения. ⚠ Промах был бы ЛАТЕНТНЫМ: сегодня совпадений «плательщик в CRM» ноль, ветка разнесения
  не срабатывает вовсе — он выстрелил бы ровно тогда, когда контрагентов начнут заводить, то есть в
  момент, который считают прогрессом. Первая версия теста на это использовала два НЕЗАВИСИМЫХ фейка и
  проходила против сломанного порядка; ловит только тест с общим складом элементов.
  ⚠ Замерено на живом портале: `crm.item.add` **молча игнорирует неизвестные UF-ключи** — значит СП,
  созданный до #575, не ломается, а просто не получает колонок; строковое UF приняло 5000 символов без
  обрезки (лимита в 255 у него нет); поле типа `date` переводит присланный момент в часовой пояс
  портала прежде, чем взять дату (`…T23:30:00Z` → следующие сутки), поэтому дата пишется голой
  календарной частью; `enumeration` с инлайновым списком не годится — элементы не регистрируются, а
  текст сохраняется как `0`.

- `server/utils/activityBindingsWrite.ts` + чистый `app/utils/activityBindings.ts` — ПРИВЯЗКИ дела к
  сущностям CRM (#579): элемент реестра платежей, сущность списания, «моя компания». Владельца
  портал держит сам, его планировщик исключает.
  ⚠ **Находка (2026-08-22, `pnpm verify:bindings --oauth`): повторная привязка той же пары —
  ОШИБКА** `ACTIVITY_IS_ALREADY_BOUND`. То есть «поставить ещё раз на всякий случай» нельзя, а
  разбирать текст ошибки бесполезно: через SDK доезжает только локализованная строка
  (`getErrorMessages()`), без кода. Отсюда устройство отступления: батч halt-on-error, и на его
  отказе транспорт читает `crm.activity.binding.list` и ставит только недостающее.
  ⚠ **Там же: привязка к НЕСУЩЕСТВУЮЩЕЙ сущности отвечает `{result:true}`** — тот же silent-accept,
  что у `crm.item.add` в #575. Значит успешный ответ ничего не доказывает: защита — валидация ссылок
  в чистом планировщике (нечисловой/нулевой id отбраковывается) плюс чтение обратно в живой проверке.
  ⚠ `binding.list` отвечает ключами в ВЕРХНЕМ регистре (`ENTITY_TYPE_ID`/`ENTITY_ID`).
  ⚠ У оплаты сделки своей ленты нет — дело вяжется к САМОЙ СДЕЛКЕ по `dealId`; id-пространства
  разные, и взять `id` записи оплаты значит показать платёж в чужой карточке.

## Статус проводки (#109)

**SSRF-гейт на ОБОИХ путях (#149/#430 S1):** `assertPortalHost` вызывается в `oauthParamsFromToken`
(`b24Sdk.ts`) — единственной точке, где строится `clientEndpoint` (`https://<host>/rest/`), поэтому
allowlist-проверка домена покрывает и **stored-token** путь (crm-sync/keep-alive/poll/distribution —
домен приходит из install-события, т.е. клиентский), и **frame**-путь. До #430 stored-token путь домен
не проверял: подделанный `ONAPPINSTALL` с `domain=169.254.169.254` давал blind-SSRF из воркера.

**SDK-транспорт `crm-sync` — единственный, по умолчанию** (#191): `portalSdkResolver.ts`→`b24Sdk.ts`,
встроенный RestrictionManager = rate-limiter (lever-1), **пер-JOB мемоизация клиента = lever-2** (общий bucket +
одна загрузка токена на джобу вместо ~6·N на батч) + evict-on-error/TTL, реактивный рефреш у самого SDK. Прежний ручной advisory-locked
`callRest`-резолвер (`portalRestResolver.ts`/`portalRest.ts`, bind-once + reactive-retry) **удалён** — фолбэка и
флага `QUEUE_SDK_TRANSPORT` больше нет. Компромисс (осознанный, выбор пользователя): SDK-рефреш мимо advisory-lock
(проигранная гонка = транзиентный ретрай, persist — **UPDATE-only** `updatePortalTokenSecrets` (#510), не
порча кредов; advisory-lock остаётся на keep-alive #175). **Батчинг (`callBatch`) — частично сделан:**
`negativeStages` фанит пер-воронковые `crm.status.list` **одним батчем на тип сущности** (`RestBatch` на том же
мемоизированном клиенте, halt-on-error, чанкинг 50). Пул оплат раз-на-op **и пагинация списка сделок** уже сделаны;
осталось: `crm.item.payment.list` не батчится (`ERROR_BATCH_METHOD_NOT_ALLOWED`) — пул оплат остаётся N+1; дизайн —
[`QUEUES.md`](QUEUES.md) «REST-бюджет проводки платежей». **`order-number`-матчинг — сделан** (по order-префиксу
`accountNumber` оплаты `<заказ>/<seq>`, `filterByOrderNumber`, live-confirmed #172); **`payment-id`-матчинг — сделан**
(по собственному id оплаты в company-пуле, `filterByPaymentId`, IDOR-safe, live-confirmed #172); **`order-id`-матчинг — сделан**
(`sale.payment.list` по `orderId` → id оплат заказа **∩** company-пул, `saleLookup.findOrderPaymentIds`+`filterByPaymentIds`,
IDOR-safe, `sale`-скоуп в `B24_REQUIRED_SCOPES`, live-confirmed #172); **invoice-кандидат несёт `dealId`**
(`parentId2`) → `collapseSameTarget` больше не даёт ложный `ambiguous` (#229). **#172 закрыт полностью** (order/payment по id и номеру).
**Запись факта разнесения + чат ошибок в `crm-sync` — сделаны (#184; §9.3 #6):** durable-запись при `allocate` —
**строка dist-СП** (`writeLedger`, идемпотентно по маркеру, счётчик `allocated`; Postgres `allocation_fact`
**полностью снят** — §9.3 #6) + `notifyError` (чат ошибок) при `ambiguous`/`manual`;
покрыто тестами (`allocationErrorMessage`/`allocationErrorNotify`/
`queuePhase2`). **Мутация портала (`deal-payment` → `crm.item.payment.pay`, `invoice` → `crm.item.update` на
стадию `allocation.invoicePaidStageId` из настроек) за гейтом `autoDistribute` — сделана**
(`allocationMutation.ts`/`allocationMutationWrite.ts`, счётчик `distributed`, конверт-aware applied-детект
(`{result:true}` vs `{result:{item}}`), идемпотентный порядок mutation-before-fact,
live-verify `pnpm mutate:test` + apply/revert стадии инвойса на seed-счёте). **Триггеры deal/smart-process —
чистый билдер `buildTriggerExecution` + транспорт `executeTriggerViaRest` + настройка `allocation.triggerCode`
(маска `[a-z0-9.\-_]`, fail-safe) + **проводка в hot-path (best-effort) + запись факта триггера — сделаны (#79)**:
за гейтом `autoDistribute`+`triggerCode` распознанная trigger-цель фаерит `crm.automation.trigger.execute` через
OAuth-резолвер воркера (контекст приложения есть — вебхуку вернулось бы «Application context required»); дедуп по
kind+id (within-run) + **маркер dist-СП** (`hasTriggerFact`/`writeTriggerFact`, §9.3 #6), строка+`distributed` только на firing; сбой (в т.ч. незарегистрированный `CODE`)
глотается (single-shot — промах не пере-пробуется). Регистрация `CODE` на установке (`crm.automation.trigger.add`,
best-effort) — **сделана; регистрация И firing подтверждены вживую** (`pnpm trigger:test --apply --fire` на
`bel.bitrix24.by`: `trigger.add`→`trigger.list` round-trip + `executeTriggerViaRest`→`{result:true}` на сделке и
смарт-процессе; детали — [`PROCESSING.md`](PROCESSING.md) §2). Реакция правила автоматизации на `CODE` — за админом (наш код
доставляет сигнал). UI-переключатель `autoDistribute` в форме настроек — **сделан**.
Поиск моей компании, стадии инвойса/сделки/смарт-процесса, резолв по id (invoice/deal/smart-process), оплаты
известной сделки, company-пул оплат (**с пагинацией списка сделок**, #191), мост-документ, `payment-number`-фильтр
по `accountNumber`, **хранение матриц/карты в настройках**, **распознавание намерения в `crm-sync`** (слайс 1),
**диспетчер intent→кандидаты** (слайс 2: `intentResolver.ts`), **резолюция намерения в кандидаты в `crm-sync`**
(слайс 3: `resolveIntents`/`onResolved`, log/count) — **готовы**.

---

Навигация: [указатель документов](README.md) · нормативная логика — [`PROCESSING.md`](PROCESSING.md) ·
очереди и REST-бюджет — [`QUEUES.md`](QUEUES.md).
