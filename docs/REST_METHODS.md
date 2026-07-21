# Реестр методов Bitrix24 REST (что и где используем)

> Last reviewed: 2026-07-21

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
- **UI-фрейм-роуты** (`settings`/`chat-settings`/`chat-search`/`import`/`import/status`/`metrics*`) —
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
| `app.option.set` | classic | — (app) | `server/utils/appSettings.ts`, `settingsHandler.ts` | да | актуален | Запись настроек приложения (тест-ключ; чат-настройки — #16). **Admin-only (#182):** `handleWriteSetting` гейтит на `profile.ADMIN` (`verifyFrameAdmin`) до записи. |
| `crm.requisite.bankdetail.list` | classic | `crm` | `server/utils/companyLookup.ts` | да | актуален | Поиск реквизитов по счёту контрагента (`RQ_ACC_NUM`→`RQ_IIK`). |
| `crm.requisite.list` | classic | `crm` | `server/utils/companyLookup.ts` | да | актуален | Реквизит → компания (`ENTITY_TYPE_ID=4`). |
| `crm.item.list` | classic | `crm` | `server/utils/{invoiceLookup,companyLookup,itemByIdLookup,paymentLookup}.ts` | да | актуален | Поиск смарт-счёта (`entityTypeId=31`) по номеру+компании (#109); фильтр «моей» компании (`entityTypeId=4`, `isMyCompany='Y'`, Этап C); резолв цели **по id+компании** (IDOR-скоуп, `itemByIdLookup`; стратегия `by-id`: invoice-id/deal-id/smart-id); **сделки компании** (`entityTypeId=2`, фильтр `companyId`) для company-пула оплат (`paymentLookup.findCompanyDealPayments`). Поля подтверждены на живом портале. |
| `crm.status.list` | classic | `crm` | `server/utils/stageLoader.ts` | да | актуален | Справочник стадий → множество «отрицательных» (`SEMANTICS='F'`/`EXTRA.SEMANTICS='failure'`) для фильтра целей (#109). `ENTITY_ID`: инвойс `SMART_INVOICE_STAGE_<catId>`, сделка `DEAL_STAGE`(воронка 0)/`DEAL_STAGE_<catId>`, смарт-процесс `DYNAMIC_<etid>_STAGE_<catId>` (всегда с реальным id категории). Подтверждено вживую: инвойс `DT31_11:D`, сделка `LOSE`/`APOLOGY`, смарт-процесс `DT1032_67:FAIL`. |
| `crm.category.list` | classic | `crm` | `server/utils/negativeStages.ts` | да | актуален | Список воронок (категорий) типа объекта (`entityTypeId`) → ids для перебора стадий (#109). Ответ `result.categories[].id`; дефолтная воронка сделок — `id:0` (`isDefault:'Y'`), валидна для `crm.status.list`. Строит **единый предикат `isNegativeStage`** на весь портал (объединение отрицательных стадий всех воронок инвойсов+сделок), раз на джобу. |
| `crm.item.payment.list` | classic | `crm` | `server/utils/paymentLookup.ts` | нет (`ERROR_BATCH_METHOD_NOT_ALLOWED`) | актуален | Оплаты **известной** сделки (`entityId`+`entityTypeId=2`) → кандидаты `deal-payment` (#109). Ответ — массив **прямо** в `result`; поля `id`/`accountNumber`/`paid`(`Y`/`N`)/`sum`/`currency` подтверждены вживую. Оплаченные (`paid='Y'`) в кандидаты не берём. Метод требует `entityId` (**известную** сделку); company-скоуп в нём не встроить (нет поля `companyId`). Резолв `order-number`/`payment-number` без известной сделки — **company-scoped обходом** `paymentLookup.findCompanyDealPayments` (сделки компании → их оплаты; «сделка проксирует заказ»), а **не** глобальным `sale.*`: `sale.order` не несёт связки со сделкой/компанией (`companyId=null`), привязать к плательщику нельзя (IDOR). **`order-id`** (id заказа, которого нет в crm-оплате) — исключение: `sale.payment.list` по `orderId` даёт id оплат заказа, которые пересекаются с company-пулом (см. ниже, #172). |
| `sale.payment.list` | classic | `sale` | `server/utils/saleLookup.ts` | нет (`ERROR_BATCH_METHOD_NOT_ALLOWED`) | актуален | **`order-id`→оплаты заказа** (#172): фильтр `orderId` → **массив id оплат** (`result.payments[]`, поля `id`/`orderId` подтверждены вживую — `crm.item.payment.list` `orderId` **не** отдаёт). **Список глобальный** (не company-scoped), поэтому вызывающий **обязан** пересечь ids с company-пулом (`filterByPaymentIds`) — это и держит IDOR. Пустой `orderId` → без вызова. |
| `crm.item.payment.pay` | classic | `crm` | `server/utils/allocationMutationWrite.ts` | нет (`ERROR_BATCH_METHOD_NOT_ALLOWED`) | актуален | **Мутация разнесения** (§2, #109): помечает оплату сделки «Оплачено» для цели `deal-payment`. Параметр только `id` (числовой), ответ `{result:true}`. За гейтом `autoDistribute` (default OFF); идемпотентный порядок mutation-before-fact. Подтверждён вживую (`pnpm mutate:test`). |
| `crm.item.update` | classic | `crm` | `server/utils/allocationMutationWrite.ts` (+ билдер `app/utils/allocationMutation.ts`) | нет (`ERROR_BATCH_METHOD_NOT_ALLOWED`) | актуален | **Мутация разнесения** (§2, #109): переводит смарт-счёт (`entityTypeId=31`) на «оплаченную» стадию `allocation.invoicePaidStageId` из настроек для цели `invoice`. Параметры `entityTypeId`/`id`/`fields.stageId`; ответ `{result:{item:{…}}}` (транспорт отдаёт полный конверт, applied-детект различает с `{result:true}` от `payment.pay`). За гейтом `autoDistribute` (default OFF) + непустой стадии (пустая ⇒ инвойс не трогаем). Подтверждён вживую (apply/revert стадии seed-счёта). |
| `crm.automation.trigger.execute` | classic | `crm` | `server/utils/allocationMutationWrite.ts` (+ билдер `app/utils/allocationMutation.ts`) | нет (`ERROR_BATCH_METHOD_NOT_ALLOWED`) | **подключён в hot-path (best-effort, #79); регистрация И firing live-verified** | **Триггер разнесения** (§2, #109): сигнал «деньги пришли» для trigger-целей `deal`/`smart-process`. Параметры **только** `CODE`+`OWNER_TYPE_ID`+`OWNER_ID` (доп. сумму/валюту метод не принимает; сверено с офдок); `OWNER_TYPE_ID`: сделка=2, смарт-процесс=его `entityTypeId`; `CODE` из `allocation.triggerCode` (маска `[a-z0-9.\-_]`). Ответ `{result:true}`. **Требует OAuth-контекста приложения** («Application context required» на webhook) + зарегистрированного `CODE` (`crm.automation.trigger.add` на установке). Проводка в hot-path — `applyTriggerDep`/`worker.ts` за гейтом `autoDistribute`+`triggerCode` (single-shot, best-effort). **Регистрация И firing подтверждены вживую** (`pnpm trigger:test --apply --fire`, `bel.bitrix24.by`: `{result:true}` на сделке `OWNER_TYPE_ID=2` и смарт-процессе). Осталось: реакция правила автоматизации на `CODE` — за админом портала. |
| `crm.documentgenerator.document.list` | classic | `documentgenerator` | `server/utils/documentLookup.ts` → `intentResolver.ts`/`worker.ts` | да | актуален | Мост-документ (#109, **wired в hot-path**): `document-number` → **массив** привязанных сущностей `{entityTypeId, entityId}[]` (фильтр `number`, ответ `result.documents[]`; номер **не** уникален по порталу → список). Гард: `doc.number` сверяется с запрошенным. **LIVE-VERIFIED** (`pnpm verify:109` #8): обратный `filter:{number}` работает, `entityTypeId`/`entityId` присутствуют. ⚠ **Live:** портал игнорирует `select` → ответ всегда несёт `*UrlMachine` (access-токен в URL); модуль читает только id-поля, сырой ответ не логируем. Scope **`documentgenerator`** (в `B24_REQUIRED_SCOPES`). Ref недоверенный → `intentResolver` рескоупит каждый по компании через `findCandidateById` (IDOR). |
| `crm.activity.configurable.add` | classic | `crm` | `server/utils/configurableActivityWrite.ts` (+ билдер `app/utils/configurableActivity.ts`) | нет (`ERROR_BATCH_METHOD_NOT_ALLOWED`) | актуален | Запись операции **настраиваемым делом** с маркером `originatorId`+`originId` (#259, стадия 4). Ответ `{result:{activity:{id}}}`. ⚠ **только OAuth-контекст** (`ERROR_WRONG_CONTEXT`, класс #79) — вебхуком не создать. |
| `crm.activity.list` | classic | `crm` | `server/utils/activityMarkerLookup.ts` | да | актуален | **Read-before-write дедуп (#259):** поиск дела по маркеру `filter[ORIGINATOR_ID][ORIGIN_ID]` (пара обязательна против ложного матча), `select[ID]` — есть → операция уже внесена, пропускаем. |
| `im.message.add` | im | `im` | `server/utils/chatNotifyWrite.ts`, `server/utils/allocationErrorNotify.ts` | да | актуален | Уведомление об операции в чат (стадия 6); тем же методом — заметка об `ambiguous`/`manual` разнесении в чат ошибок (#184). |
| `im.search.chat.list` | im | `im` | `server/utils/chatSearch.ts` | **нет** | актуален | Поиск чата по названию/участникам для пикера (`FIND`≥3, `LIMIT`≤50, `OFFSET`; отдаёт `total`/`next`). |
| `im.recent.list` | im | `im` | `server/utils/chatSearch.ts` | нет | актуален | Дефолтный список пикера — последние групповые чаты (`SKIP_DIALOG=Y`, `OFFSET`/`LIMIT`). |
| `profile` | classic | — | `server/api/import.post.ts`, `server/api/import/status.get.ts`, `server/api/import/metrics.get.ts`, `server/api/import/metrics-reset.post.ts`, `server/api/bank/connect.post.ts`, `server/api/app-rating.get.ts`, `server/api/app-rating.post.ts`, `server/api/feedback.post.ts`, `server/utils/settingsHandler.ts` | нет | актуален | Валидация фрейм-токена (ручной импорт + `GET /api/import/status` + метрики `#78` + старт подключения банка `POST /api/bank/connect` + попап «оцените приложение» `GET/POST /api/app-rating` + канал обратной связи `POST /api/feedback` + **запись настроек** `chat-settings.post`/`settings.post` через `verifyFrameAdmin`, #182 + **сброс метрик** `metrics-reset.post` (admin-only, #182 паритет)): успех доказывает, что токен принадлежит этому порталу (иначе B24 отвергает), блокирует спуфинг `X-B24-Domain`, + даёт id пользователя-инициатора **и флаг `ADMIN`** (базовый scope) — для гейта админа при подключении банка (A7b-1), **записи настроек** (#182: `autoDistribute`/карта распознавания/чат-цели скоуплены на весь портал → только админ) **и сброса метрик**. |

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
| `parent.setTitle` | SDK frame | `app/pages/install.vue`, `app/pages/app.vue`, `app/pages/settings.vue` | Заголовок окна приложения в портале. |
| `parent.fitWindow` | SDK frame | `app/pages/install.vue`, `app/pages/app.vue`, `app/pages/settings.vue` | Подгонка высоты iframe под контент. |

> `placement.bind` пока **не** вызываем — плейсменты финализируем на тестовом портале (см.
> `docs/REFACTOR_PLAN.md`). Когда добавим — строка сюда.

## Точные сигнатуры

Параметры/ответы/ошибки методов — в официальной доке (через MCP `b24-dev-mcp`,
`bitrix-method-details`) и `apidocs.bitrix24.ru`. Здесь — только **карта использования**, не
дублируем сигнатуры (иначе разъедется).

> **TODO (drift-guard):** синка этого реестра с кодом сейчас держится на дисциплине. Стоит завести
> Vitest-гуард (грепает method-литералы в `server/`/`app/` и сверяет с таблицей) — как для других
> реестров репо (дедуп-ключи, i18n-паритет, md-штампы). Отдельная issue.
