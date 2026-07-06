# Реестр методов Bitrix24 REST (что и где используем)

> Last reviewed: 2026-07-06

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

Идут через `server/utils/b24Rest.ts` `callRest(domain, accessToken, method, params)` (per-portal,
`makePortalRestCall` подгружает+рефрешит токен). Личность — **пользователь, установивший приложение**
(владелец сохранённого refresh-токена); это важно для методов, чувствительных к правам (см. `im.*`).

| Метод | Поколение | Scope | Файл-владелец | Батч | Статус / замена | Назначение |
|-------|-----------|-------|---------------|------|-----------------|------------|
| `app.option.get` | classic | — (app) | `server/utils/appSettings.ts`, `settingsHandler.ts` | да | актуален | Чтение настроек приложения (per-portal, per-app KV). |
| `app.option.set` | classic | — (app) | `server/utils/appSettings.ts`, `settingsHandler.ts` | да | актуален | Запись настроек приложения (тест-ключ; чат-настройки — #16). |
| `crm.requisite.bankdetail.list` | classic | `crm` | `server/utils/companyLookup.ts` | да | актуален | Поиск реквизитов по счёту контрагента (`RQ_ACC_NUM`→`RQ_IIK`). |
| `crm.requisite.list` | classic | `crm` | `server/utils/companyLookup.ts` | да | актуален | Реквизит → компания (`ENTITY_TYPE_ID=4`). |
| `crm.item.list` | classic | `crm` | `server/utils/invoiceLookup.ts` | да | актуален | Поиск смарт-счёта (`entityTypeId=31`) по номеру+компании для разнесения оплаты (#109). Поля подтверждены на живом портале: `accountNumber`/`companyId`/`mycompanyId`/`stageId`/`opportunity`/`currencyId`. |
| `crm.activity.todo.add` | classic | `crm` | `server/utils/crmActivityWrite.ts` | да | актуален | Запись универсального дела по операции (стадия 4). |
| `im.message.add` | im | `im` | `server/utils/chatNotifyWrite.ts` | да | актуален | Отправка уведомления об операции в чат (стадия 6). |
| `im.search.chat.list` | im | `im` | `server/utils/chatSearch.ts` | **нет** | актуален | Поиск чата по названию/участникам для пикера (`FIND`≥3, `LIMIT`≤50, `OFFSET`; отдаёт `total`/`next`). |
| `im.recent.list` | im | `im` | `server/utils/chatSearch.ts` | нет | актуален | Дефолтный список пикера — последние групповые чаты (`SKIP_DIALOG=Y`, `OFFSET`/`LIMIT`). |

> **HTTP, не REST-метод:** OAuth-токен портала обновляем на `oauth/token` (endpoint Bitrix
> `oauth.bitrix.info/oauth/token/`, `server/utils/b24Oauth.ts`) — это не метод `callRest`, а прямой
> запрос к token endpoint. Других Bitrix-token-endpoint'ов нет.

## Планируется (следующие PR)

| Метод | Поколение | Scope | Назначение |
|-------|-----------|-------|------------|
| `crm.status.list` | classic | `crm` | Справочник стадий (счёта/сделки) → фильтр «отрицательных» стадий по `SEMANTICS='F'` (на живом портале «Не оплачен» `DT31_11:D`). Из него `invoiceLookup` строит предикат `isNegativeStage`; сейчас предикат инъектируется, loader — следующий слайс #109. |

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
