# Реестр методов Bitrix24 REST (что и где используем)

> Last reviewed: 2026-08-22

Единый учёт **всех** вызовов Bitrix24 REST в приложении: метод, его **версия/поколение**,
scope, транспорт (фрейм-SDK или серверный OAuth), файл-владелец, можно ли батчить, статус
(актуален / есть замена), назначение. Держим синхронно с кодом — при добавлении/замене метода
правим таблицу. Цель: быстро видеть поверхность интеграции и точечно мигрировать, когда Bitrix
депрекейтит метод.

> **Границы документа.** Только Bitrix24 REST. Банковский OAuth (Альфа `app/utils/alfaOauth.ts`,
> Приор `app/utils/priorOauth.ts` и dev-скрипты) — **не** Bitrix, сюда не входит (см. `docs/ALFA_API.md`,
> `docs/PRIOR_API.md`).

> **Про «версии».** Единого «REST v2/v3» у Bitrix нет — версионирование **помодульное и
> неровное**. Поэтому колонка «Поколение» — про сам метод, а не про API в целом:
> - **classic** — исторические методы (`crm.*`, `app.option.*`, `event.*`, `app.info`, `scope`) —
>   актуальны, массово используются, замен пока нет;
> - **im** — текущее поколение чат-методов модуля `im` (`im.message.add`, `im.recent.list`,
>   `im.search.chat.list`); старое поколение помечено в доке как «для предыдущей версии чата».
>   («im» здесь — наш ярлык поколения, не официальный термин Bitrix);
> - **v2-метод** — там, где Bitrix явно выпустил `*.v2.*` и депрекейтит старое (напр. `imbot.v2.*`);
>   у нас таких вызовов пока нет.
>
> Отдельно — **версия транспорта SDK** (`@bitrix24/b24jssdk`): фрейм-вызовы идём через
> `actions.v2.batch.make` / `actions.v2.call.make` (SDK 2.x). Это версия **обёртки вызова**, не метода
> (`callBatch`/`callMethod` — deprecated-шим в SDK 2.0). Не путать с «поколением метода» выше.

## Серверные вызовы (backend, OAuth-токен портала)

Идут **целиком через jssdk-транспорт** (`@bitrix24/b24jssdk`, `server/utils/b24Sdk.ts`) — сырой
`$fetch`-`callRest` ретайрнут (миграция #191/«всё на jssdk»). Два входа:
- **`crm-sync`** — per-portal `B24OAuth` из сохранённого токена (SDK-резолвер `portalSdkResolver.ts`,
  пер-JOB мемоизация клиента = один rate-limiter-бакет + один token-load на джобу);
- **UI-фрейм-роуты** (`settings`/`chat-settings`/`chat-search`/`import`/`import/status`/`import/batch`/`metrics*`) —
  `liveDeps.frameRestCall` → `makeFrameRestCall` (тот же SDK по фрейм-access-токену, за SSRF-гейтом
  `assertPortalHost`; refresh-токена нет — фрейм-токен свежий, рефреш не нужен).

`server/utils/b24Rest.ts` теперь несёт **только SSRF-гейт** (`assertPortalHost`, #149). SSRF-гейт
`isAllowedPortalHost` (allowlist хоста), rate-limiter и реактивный ретрай `expired_token` — общие для
обоих входов (у SDK). Личность серверных `crm-sync`-вызовов — **пользователь, установивший приложение**
(владелец сохранённого refresh-токена); фрейм-роуты действуют личностью вызывающего оператора (его
фрейм-токен). Права важны для `im.*` (см. ниже).

| Метод | Поколение | Scope | Файл-владелец | Батч | Статус / замена | Назначение |
|-------|-----------|-------|---------------|------|-----------------|------------|
| `app.option.get` | classic | — (app) | `server/utils/appSettings.ts`, `settingsHandler.ts` | да | актуален | Чтение настроек приложения (per-portal, per-app KV). |
| `app.option.set` | classic | — (app) | `settingsHandler.ts` | да | актуален | Запись настроек приложения (чат-настройки под `SETTINGS_KEY`, #16). **Admin-only (#182):** `handleWriteSetting` гейтит на `profile.ADMIN` (`verifyFrameAdmin`) до записи. |
| `imbot.v2.Bot.register` | **v2** | `imbot` | `app/pages/install.vue`, `server/utils/chatBotSend.ts` | нет | актуален | Регистрация чат-бота приложения (#496). ⚠ Пара `imbot.register`/`imbot.message.add` — УСТАРЕВШЕЕ поколение, в новом коде не использовать. Идемпотентен по `code` (повтор возвращает существующего бота), поэтому зовётся и на установке, и лениво воркером — своего дедупа не нужно. `botToken` под OAuth не шлём (он только для вебхуков), `eventMode` не задаём (умолчание `fetch` — боту, который только шлёт, колбэки не нужны). |
| `imbot.v2.Chat.Message.send` | **v2** | `imbot` | `server/utils/{chatBotSend,chatNotifyWrite}.ts` | нет | актуален | Сообщение в чат ОТ ИМЕНИ ПРИЛОЖЕНИЯ (#496). ⚠ **Откат обязателен**: `ACCESS_DENIED` (REST только на коммерческих тарифах) и `BOT_LIMIT_EXCEEDED` — свойства портала клиента, и при них шлём через `im.message.add`. Чат ошибок — единственный канал до бухгалтера, замолчать там нельзя. |
| `crm.requisite.bankdetail.list` | classic | `crm` | `server/utils/{companyLookup,myCompanyRequisites}.ts` | да | актуален | Поиск реквизитов по счёту контрагента (`RQ_ACC_NUM`→`RQ_IIK`); обратный ход — счета «моих компаний» для предусловия #493 и сверки #494. |
| `crm.requisite.list` | classic | `crm` | `server/utils/{companyLookup,myCompanyRequisites}.ts` | да | актуален | Реквизит → компания (`ENTITY_TYPE_ID=4`) и компания → её реквизиты (фильтр `ENTITY_ID`). |
| `crm.item.list` | classic | `crm` | `server/utils/{invoiceLookup,companyLookup,itemByIdLookup,paymentLookup,myCompanyRequisites}.ts` | да | актуален | Поиск смарт-счёта (`entityTypeId=31`) по номеру+компании (#109); фильтр «моей» компании (`entityTypeId=4`, `isMyCompany='Y'`, Этап C); резолв цели **по id+компании** (IDOR-скоуп, `itemByIdLookup`; стратегия `by-id`: invoice-id/deal-id/smart-id); **сделки компании** (`entityTypeId=2`, фильтр `companyId`) для company-пула оплат (`paymentLookup.findCompanyDealPayments`). Поля подтверждены на живом портале. |
| `crm.status.list` | classic | `crm` | `server/utils/stageLoader.ts` | да | актуален | Справочник стадий → множество «отрицательных» (`SEMANTICS='F'`/`EXTRA.SEMANTICS='failure'`) для фильтра целей (#109). `ENTITY_ID`: инвойс `SMART_INVOICE_STAGE_<catId>`, сделка `DEAL_STAGE`(воронка 0)/`DEAL_STAGE_<catId>`, смарт-процесс `DYNAMIC_<etid>_STAGE_<catId>` (всегда с реальным id категории). Подтверждено вживую: инвойс `DT31_11:D`, сделка `LOSE`/`APOLOGY`, смарт-процесс `DT1032_67:FAIL`. |
| `crm.category.list` | classic | `crm` | `server/utils/negativeStages.ts` | да | актуален | Список воронок (категорий) типа объекта (`entityTypeId`) → ids для перебора стадий (#109). Ответ `result.categories[].id`; дефолтная воронка сделок — `id:0` (`isDefault:'Y'`), валидна для `crm.status.list`. Строит **единый предикат `isNegativeStage`** на весь портал (объединение отрицательных стадий всех воронок инвойсов+сделок), раз на джобу. |
| `crm.item.payment.list` | classic | `crm` | `server/utils/paymentLookup.ts` | нет (`ERROR_BATCH_METHOD_NOT_ALLOWED`) | актуален | Оплаты **известной** сделки (`entityId`+`entityTypeId=2`) → кандидаты `deal-payment` (#109). Ответ — массив **прямо** в `result`; поля `id`/`accountNumber`/`paid`(`Y`/`N`)/`sum`/`currency` подтверждены вживую. Оплаченные (`paid='Y'`) в кандидаты не берём. Метод требует `entityId` (**известную** сделку); company-скоуп в нём не встроить (нет поля `companyId`). Резолв `order-number`/`payment-number` без известной сделки — **company-scoped обходом** `paymentLookup.findCompanyDealPayments` (сделки компании → их оплаты; «сделка проксирует заказ»), а **не** глобальным `sale.*`: `sale.order` не несёт связки со сделкой/компанией (`companyId=null`), привязать к плательщику нельзя (IDOR). **`order-id`** (id заказа, которого нет в crm-оплате) — исключение: `sale.payment.list` по `orderId` даёт id оплат заказа, которые пересекаются с company-пулом (см. ниже, #172). |
| `sale.payment.list` | classic | `sale` | `server/utils/saleLookup.ts` | нет (`ERROR_BATCH_METHOD_NOT_ALLOWED`) | актуален | **`order-id`→оплаты заказа** (#172): фильтр `orderId` → **массив id оплат** (`result.payments[]`, поля `id`/`orderId` подтверждены вживую — `crm.item.payment.list` `orderId` **не** отдаёт). **Список глобальный** (не company-scoped), поэтому вызывающий **обязан** пересечь ids с company-пулом (`filterByPaymentIds`) — это и держит IDOR. Пустой `orderId` → без вызова. |
| `crm.item.payment.pay` | classic | `crm` | `server/utils/allocationMutationWrite.ts` | нет (`ERROR_BATCH_METHOD_NOT_ALLOWED`) | актуален | **Мутация разнесения** (§2, #109): помечает оплату сделки «Оплачено» для цели `deal-payment`. Параметр только `id` (числовой), ответ `{result:true}`. За гейтом `autoDistribute` (default OFF); идемпотентный порядок mutation-before-fact. Подтверждён вживую (`pnpm mutate:test`). |
| `crm.item.update` | classic | `crm` | `server/utils/allocationMutationWrite.ts` (+ билдер `app/utils/allocationMutation.ts`) | нет (`ERROR_BATCH_METHOD_NOT_ALLOWED`) | актуален | **Мутация разнесения** (§2, #109): переводит смарт-счёт (`entityTypeId=31`) на «оплаченную» стадию `allocation.invoicePaidStageId` из настроек для цели `invoice`. Параметры `entityTypeId`/`id`/`fields.stageId`; ответ `{result:{item:{…}}}` (транспорт отдаёт полный конверт, applied-детект различает с `{result:true}` от `payment.pay`). За гейтом `autoDistribute` (default OFF) + непустой стадии (пустая ⇒ инвойс не трогаем). Подтверждён вживую (apply/revert стадии seed-счёта). |
| `crm.automation.trigger.execute` | classic | `crm` | `server/utils/allocationMutationWrite.ts` (+ билдер `app/utils/allocationMutation.ts`) | нет (`ERROR_BATCH_METHOD_NOT_ALLOWED`) | **подключён в hot-path (best-effort, #79); регистрация И firing live-verified** | **Триггер разнесения** (§2, #109): сигнал «деньги пришли» для trigger-целей `deal`/`smart-process`. Параметры **только** `CODE`+`OWNER_TYPE_ID`+`OWNER_ID` (доп. сумму/валюту метод не принимает; сверено с офдок); `OWNER_TYPE_ID`: сделка=2, смарт-процесс=его `entityTypeId`; `CODE` из `allocation.triggerCode` (маска `[a-z0-9.\-_]`). Ответ `{result:true}`. **Требует OAuth-контекста приложения** («Application context required» на webhook) + зарегистрированного `CODE` (`crm.automation.trigger.add` на установке). Проводка в hot-path — `applyTriggerDep`/`worker.ts` за гейтом `autoDistribute`+`triggerCode` (single-shot, best-effort). **Регистрация И firing подтверждены вживую** (`pnpm trigger:test --apply --fire`, `bel.bitrix24.by`: `{result:true}` на сделке `OWNER_TYPE_ID=2` и смарт-процессе). Осталось: реакция правила автоматизации на `CODE` — за админом портала. |
| `crm.documentgenerator.document.list` | classic | `documentgenerator` | `server/utils/documentLookup.ts` → `intentResolver.ts`/`worker.ts` | да | актуален | Мост-документ (#109, **wired в hot-path**): `document-number` → **массив** привязанных сущностей `{entityTypeId, entityId}[]` (фильтр `number`, ответ `result.documents[]`; номер **не** уникален по порталу → список). Гард: `doc.number` сверяется с запрошенным. **LIVE-VERIFIED** (`pnpm verify:109` #8): обратный `filter:{number}` работает, `entityTypeId`/`entityId` присутствуют. ⚠ **Live:** портал игнорирует `select` → ответ всегда несёт `*UrlMachine` (access-токен в URL); модуль читает только id-поля, сырой ответ не логируем. Scope **`documentgenerator`** (в `B24_REQUIRED_SCOPES`). Ref недоверенный → `intentResolver` рескоупит каждый по компании через `findCandidateById` (IDOR). |
| `crm.item.add` | classic | `crm` | `server/utils/{distributionLedgerWrite,paymentRegistryWrite}.ts` (+ билдер `app/utils/distributionLedger.ts`) | нет | актуален | Создание элемента смарт-процесса: **носитель платежа** (payment-СП) и **строка распределения** (dist-СП). С #575 носитель — это РЕЕСТР: он пишется на КАЖДУЮ операцию и несёт восемь полей выписки. Ответ `{result:{item:{id}}}`. ⚠ **Замерено 2026-08-22:** метод **молча игнорирует неизвестные UF-ключи** (элемент создаётся, значение отбрасывается, ошибки нет), поэтому СП, созданный версией до #575, продолжает работать без колонок реестра. ⚠ Там же замерено: строковое UF-поле приняло 5000 символов без обрезки, а `enumeration` с инлайновым списком значений НЕ годится (элементы списка не регистрируются, текст сохраняется как `0`). |
| `crm.item.get` | classic | `crm` | `scripts/verify-registry-live.ts` | нет | актуален | Чтение элемента СП обратно в живой проверке реестра (#575). Именно чтение и доказывает, что колонка записалась: `crm.item.add` неизвестный ключ глотает молча, поэтому опечатка в имени поля не падает — значение просто исчезает. |
| `userfieldconfig.add` / `.list` / `.delete` | classic | `userfieldconfig` | `server/utils/distributionSpProvision.ts` | да (`list`) | актуален | Провижининг пользовательских полей обоих СП: `list` — что уже есть, `add` — только недостающие (самолечение). ⚠ Имя поля и `entityId` берут **тип-id** СП (`CRM_<id>` / `UF_CRM_<id>_<postfix>`), а не `entityTypeId`. ⚠ Scope `userfieldconfig` — отдельное право (#408); у тестового вебхука его нет, поэтому живые проверки провижининга идут только по OAuth. `.delete` — только в дев-пробах, в проде не зовём. |
| `crm.activity.todo.add` | classic | `crm` | `server/utils/todoActivityWrite.ts` (+ билдер `app/utils/todoActivity.ts`) | нет | актуален | Запись операции **универсальным делом** (#495). Ответ `{result:{id}}`. Цвет по направлению, срок, дело НЕ закрывается. ⚠ Маркер `ORIGINATOR_ID`/`ORIGIN_ID` метод **НЕ принимает** — он ставится следующим вызовом. |
| `crm.activity.update` | classic | `crm` | `server/utils/todoActivityWrite.ts` | нет | актуален | Ставит на созданное дело **маркер дедупа** + `DESCRIPTION_TYPE=3` (BB). Одним вызовом, потому что два стоили бы лишнего обращения на каждую операцию. ⚠ Между `todo.add` и этим вызовом дело существует БЕЗ маркера — окно закрыто компенсирующим удалением. |
| `crm.activity.delete` | classic | `crm` | `server/utils/{todoActivityWrite,eraseActivitiesWrite}.ts` | **да** (#576 п.4) | актуален | Сносит дело, которому не удалось поставить маркер: немаркированное дело хуже отсутствующего — дедуп не найдёт его никогда, и повтор положит рядом второе. **Плюс массовое стирание дел приложения** (#576 п.4): пачками до 50 через `batch`. ⚠ Замерено на живом портале 2026-08-22, что метод в БАТЧЕ **разрешён** — пробный вызов вернул ошибку КОМАНДЫ («Activity is not found»), а не `ERROR_BATCH_METHOD_NOT_ALLOWED`. Без этого 400 дел удалялись бы по одному при 2 req/s, то есть три минуты — не в HTTP-запросе, а в очереди. ⚠ Батч останавливается на первой упавшей команде, поэтому «сколько удалено» НЕ считается по отправленным командам, а измеряется разницей `total` до и после. |
| `crm.activity.list` | classic | `crm` | `server/utils/{activityMarkerLookup,eraseActivitiesWrite}.ts` | да | актуален | **Read-before-write дедуп (#259):** поиск дела по маркеру `filter[ORIGINATOR_ID][ORIGIN_ID]` (пара обязательна против ложного матча), `select[ID]` — есть → операция уже внесена, пропускаем. **Плюс перечисление СВОИХ дел для стирания** (#576 п.4, `eraseActivitiesWrite`): тот же `ORIGINATOR_ID` + диапазон `>=DEADLINE`/`<=DEADLINE`, страницы по 50 с `total`. ⚠ Замерено на живом портале 2026-08-22: диапазон по `DEADLINE` работает, `total` приходит — значит «сколько попадёт под удаление» показывается ДО удаления. ⚠ Возвращённый `ORIGINATOR_ID` перепроверяется В ОТВЕТЕ перед удалением: фильтр запроса это наш код, и его ошибка не должна означать удаление чужих дел. |
| `im.message.add` | im | `im` | `server/utils/chatNotifyWrite.ts` (единственная точка отправки) | да | актуален | **ОТКАТ** для `imbot.v2.Chat.Message.send` (#496): шлёт от имени владельца токена, когда бот на портале недоступен. Все пять видов сообщений (импорт, ошибка разнесения, цель не найдена, клиент не определён, удаление сущности) идут через `postChatMessage` — маршрут выбирается в одном месте, иначе на одном портале часть сообщений была бы от приложения, а часть от коллеги. |
| `im.dialog.get` | im | `im` | `server/utils/chatSearch.ts` | **нет** | актуален | Название сохранённого чата по `DIALOG_ID` для пикера настроек (иначе в форме виден сырой `chat123`). Зовётся только когда названия нет ни в кэше настроек, ни в списке недавних. ⚠ Вход ограничен маской `chat<N>` (`isChatDialogId`): метод принимает ЛЮБОЙ `DIALOG_ID`, и числовой резолвил бы личный 1-1 диалог, который мы целью не предлагаем. |
| `im.search.chat.list` | im | `im` | `server/utils/chatSearch.ts` | **нет** | актуален | Поиск чата по названию/участникам для пикера (`FIND`≥3, `LIMIT`≤50, `OFFSET`; отдаёт `total`/`next`). |
| `im.recent.list` | im | `im` | `server/utils/chatSearch.ts` | нет | актуален | Дефолтный список пикера — последние групповые чаты (`SKIP_DIALOG=Y`, `OFFSET`/`LIMIT`). |
| `profile` | classic | — | `server/api/import.post.ts`, `server/api/import/status.get.ts`, `server/api/import/batch.get.ts`, `server/api/import/metrics.get.ts`, `server/api/import/metrics-reset.post.ts`, `server/api/bank/connect.post.ts`, `server/api/bank/accounts.get.ts`, `server/api/bank/disconnect.post.ts`, `server/api/bank/pause.post.ts`, `server/api/bank/set-account.post.ts`, `server/api/bank/matrix.get.ts`, `server/api/setup-status.get.ts`, `server/api/activities/erasable.get.ts`, `server/api/activities/erase.post.ts`, `server/api/app-rating.get.ts`, `server/api/app-rating.post.ts`, `server/api/feedback.post.ts`, `server/utils/settingsHandler.ts` | нет | актуален | Валидация фрейм-токена (ручной импорт + `GET /api/import/status` + **итоги конкретных загрузок** `GET /api/import/batch` (#417 — роут ОПРАШИВАЕТСЯ, то есть тот же вектор усиления, что у статуса; закрыт nginx-зоной `import`) + метрики `#78` + старт подключения банка `POST /api/bank/connect` + **список/отключение счетов** `GET /api/bank/accounts`, `POST /api/bank/disconnect` (#404, admin-only) + **пауза автоопроса** `POST /api/bank/pause` (#576, admin-only) + **сверка счетов CRM↔банк** `GET /api/bank/matrix` (#494, admin-only) + **экран готовности** `GET /api/setup-status` (#409/#405, admin-only) + попап «оцените приложение» `GET/POST /api/app-rating` + канал обратной связи `POST /api/feedback` + **запись настроек** `chat-settings.post` через `verifyFrameAdmin`, #182 + **сброс метрик** `metrics-reset.post` (admin-only, #182 паритет)): успех доказывает, что токен принадлежит этому порталу (иначе B24 отвергает), блокирует спуфинг `X-B24-Domain`, + даёт id пользователя-инициатора **и флаг `ADMIN`** (базовый scope) — для гейта админа при подключении банка (A7b-1), **записи настроек** (#182: `autoDistribute`/карта распознавания/чат-цели скоуплены на весь портал → только админ) **и сброса метрик**. |

> **HTTP, не REST-метод:** OAuth-токен портала обновляем на `oauth/token` (endpoint Bitrix
> `oauth.bitrix.info/oauth/token/`) — это не REST-метод транспорта, а прямой запрос к token endpoint.
> Теперь он тоже идёт **через jssdk** (`sdkRefreshTransport` → `B24OAuth.auth.refreshAuth`, `b24Sdk.ts`),
> так что весь исходящий B24-трафик — один транспорт. Единственный его вызыватель — проактивный
> keep-alive-крон (`tokenKeepAlive.ts`→`ensureAccessToken.ts`, #175); вокруг рефреша `ensureAccessToken`
> держит per-portal **advisory-lock** (#35) — его SDK не даёт, поэтому лок остаётся на этом пути (крон
> идемпотентно рефрешит простаивающие порталы, реактивного ретрая-подстраховки у него нет). `b24Oauth.ts`
> оставляет только чистые `buildRefreshBody`/`parseRefreshResponse` (тело/разбор).
>
> **Одно осознанное исключение — install-verify (#162):** `verifyInstallMember.ts` (`rawOauthRefresh`)
> делает **один сырой POST** на тот же `oauth.bitrix.info/oauth/token/` при верификации установки, т.к.
> SDK-рефреш **выбрасывает** `member_id` из ответа, а привязка `member_id`→грант его требует. Хост
> **фиксирован** (не из клиентского ввода → нет SSRF), секреты в теле POST (не в URL), AbortSignal-таймаут,
> обёрнут в `withDependencySpan`. Это единственный сырой Bitrix-запрос; весь прочий B24-трафик — через jssdk.

## Планируется (следующие PR)

| Метод | Поколение | Scope | Назначение |
|-------|-----------|-------|------------|
| `crm.item.payment.add` (+`.product.add`) | classic | `crm` | Создать оплату + привязать товарную позицию (задаёт сумму). Используются в seed-скрипте для реальной оплаты сделки. |
| `sale.payment.update` `PAID=N` | classic | `sale` | **Сторно** оплаты (снятие «Оплачено»). Пока только в dev-скрипте `mutate:test --revert` (восстановление фикстуры); в рантайме приложения — при реализации отмены разнесения (§3). |

> **Важно про scope:** **отмена/удаление оплаченной оплаты** (`sale.payment.update PAID=N`, снятие блокировки «У заказа есть активные оплаты») требует scope **`sale`** — `crm`-only токен получает `insufficient_scope`. Учесть в правах приложения на этапе проводки оплат #109.

_Новые REST-методы добавляем сюда до внедрения, затем переносим наверх._

> **Тонкость идентичности (`im.*`) — важно.** `im.search.chat.list`/`im.recent.list` возвращают
> чаты, доступные **текущему пользователю** токена. Пикер (`/api/chat-search`) сейчас ходит по
> **фрейм-токену** — то есть по личности **оператора**, открывшего настройки. А уведомления шлёт
> воркер **серверным** токеном портала (личность **установщика**, `im.message.add`). Если настройщик
> ≠ установщик и установщик не состоит в выбранном чате — отправка молча не пройдёт (`notifyChat`
> глотает ошибку и логирует). В типовом случае (настраивает админ-установщик) совпадает. **Робастная
> развязка** (слать от имени **зарегистрированного бота**, либо искать/слать одной личностью через
> `member_id`-по-домену) — отдельный шаг; см. `docs/PROCESSING.md` §7 про бота. Ядро `chatSearch.ts`
> к личности нейтрально (работает над любым `RestCall`) — сменить транспорт роута можно точечно.

## Фрейм-вызовы (браузер, `@bitrix24/b24jssdk`, только установка + UI-хром)

Через `useB24()` → `B24Frame`. Личность — текущий пользователь портала в iframe. Данные/настройки
через фрейм **не** тянем (это делает backend по OAuth) — здесь только install-flow и UI-хром окна.

| Метод / вызов | Транспорт SDK | Файл | Назначение |
|---------------|---------------|------|------------|
| `event.bind` / `event.unbind` | `actions.v2.batch.make` | `app/pages/install.vue` (+ билдер `app/utils/b24EventBind.ts`) | Привязка `ONAPPINSTALL`/`ONAPPUNINSTALL` на `…/api/b24/events` (до `installFinish`). |
| `event.get` | `actions.v2.batch.make` | `app/pages/install.vue` | Диагностика: текущие привязки событий. |
| `app.info` | `actions.v2.batch.make` | `app/pages/install.vue` | Диагностика: метаданные приложения. |
| `scope` | `actions.v2.batch.make` | `app/pages/install.vue` | Диагностика: выданные права. |
| `installFinish` | SDK frame | `app/pages/install.vue` | Завершение установки. |
| `parent.setTitle` | SDK frame | `app/pages/install.vue`, `app/pages/app.vue`, `app/pages/import.vue` | Заголовок окна приложения в портале. |
| `parent.fitWindow` | SDK frame | `app/pages/install.vue`, `app/pages/app.vue`, `app/pages/import.vue` | Подгонка высоты iframe под контент. |

> `placement.bind` пока **не** вызываем — плейсменты финализируем на тестовом портале (см.
> `docs/REFACTOR_PLAN.md`). Когда добавим — строка сюда.

## Точные сигнатуры

Параметры/ответы/ошибки методов — в официальной доке (через MCP `b24-dev-mcp`,
`bitrix-method-details`) и `apidocs.bitrix24.ru`. Здесь — только **карта использования**, не
дублируем сигнатуры (иначе разъедется).

> **TODO (drift-guard):** синка этого реестра с кодом сейчас держится на дисциплине. Стоит завести
> Vitest-гуард (грепает method-литералы в `server/`/`app/` и сверяет с таблицей) — как для других
> реестров репо (дедуп-ключи, i18n-паритет, md-штампы). Отдельная issue.
