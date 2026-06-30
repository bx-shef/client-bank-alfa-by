# API Альфа-Банка Беларусь — справка

> Last reviewed: 2026-06-30

Краткая карточка: что используем из Open API Альфа-Банка и с какими параметрами.
Реализация контракта — `app/utils/alfaOauth.ts` (OAuth) и `app/utils/alfaStatement.ts`
(нормализация выписки). Общий план — [`REFACTOR_PLAN.md`](./REFACTOR_PLAN.md).

## Ссылки на документацию

- **Developer Hub (каталог API):** <https://developerhub.alfabank.by/developerhub/>
- **API «Авторизация»** (OAuth 2.0), partner.authorization 1.0.0 — guides:
  <https://developerhub.alfabank.by/developerhub/site/pages/item-info.jag?name=partner.authorization&version=1.0.0&provider=admin&tab=guides>
- **API «Счета»** (счета + выписка), partner.accounts 1.2.0:
  <https://developerhub.alfabank.by/developerhub/site/pages/item-info.jag?name=partner.accounts&version=1.2.0&provider=admin>
- **Обзорная статья «Open API Альфа-Банка»:** <https://www.alfabank.by/about/articles/main/new-Alfa-API/>

> Полные спецификации (Swagger) и регистрация партнёрского приложения — за входом на Developer Hub.
> Хосты: **sandbox** `developerhub.alfabank.by:8273`, **prod** `ibapi2.alfabank.by:8273`.
> Лимит запросов: **100/мин** на API (пилот). Из облака агента хосты недоступны (TLS-сброс) —
> живые вызовы только с BY-доступного сервера (см. REFACTOR_PLAN → «Ограничение сети»).

## Что используем

### 1. Авторизация (OAuth 2.0, Authorization Code + refresh)

Уходим с legacy password-grant на **Authorization Code** — пользователь логинится у Альфы и
даёт согласие; мы храним `refresh_token` и обновляем `access_token`.

| Шаг | Запрос | Ключевые параметры |
|---|---|---|
| (1) Authorize | `GET {base}/authorize` | `response_type=code`, `client_id`, `scope=accounts`, `redirect_uri`, `state` |
| (2) Callback | `→ {redirect_uri}?code=…&state=…` | проверяем `state` (CSRF), `code` короткоживущий — меняем сразу |
| (3) Token | `POST {base}/token` | `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret` |
| (4) Refresh | `POST {base}/token` | `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret` |

- Ответ токена: `access_token`, `token_type` (default `Bearer`), `expires_in=3600` (1 ч, в коде —
  дефолт `parseTokenResponse`), `refresh_token`. TTL refresh — `ALFA_REFRESH_TOKEN_TTL_SEC` ≈ 36000 с
  (~10 ч; по доке/свагеру Альфы, уточнить на живом прогоне).
- `redirect_uri` обязан **точно совпадать** с зарегистрированным в приложении; берётся из env
  (`ALFA_REDIRECT_URI`, см. `.env.example`), а не хардкодится в коде/доке.
- `client_secret` — только в env сервера (никогда в репозиторий/логи/URL).

### 2. Счета и выписка

Все вызовы — с заголовком `Authorization: Bearer {access_token}`, scope `accounts`, на тот же
базовый хост `{base}` (`…:8273`), что и OAuth (sandbox/prod — см. блок-цитату выше).

| Метод | Назначение | Используем |
|---|---|---|
| `GET /partner/1.2.0/accounts/` | список счетов и остатков | да — выбор счетов |
| `GET /partner/1.2.0/accounts/statement` | выписка по счёту(ам) | да — основной поток |

**Параметры `GET …/accounts/statement`:**

| Параметр | Значение |
|---|---|
| `number` | номера счетов — несколько query-параметров `number=…` (до 50) |
| `dateFrom` / `dateTo` | период, формат **DD.MM.YYYY** |
| `transactions` | `1` = приход (кредит), `2` = расход (дебет), `0` = все |
| `pageNo` / `pageRowCount` | пагинация; `0` = «все» (нестандартная семантика Альфы) |
| `amountFrom` / `amountTo`, `transactionType`, `cacheKey` | опционально (фильтры/кэш) |

**Ответ** — `page[]` (операции) + `statistics[]` (остатки/обороты) + `errors[]` (ошибки по счёту).
Из модели операции берём: `operType` (C/D → приход/расход), `amount`/`currIso`, `purpose`,
`corrName/corrUnp/corrNumber/corrBic/corrBank` (контрагент → поиск компании по корр-счёту),
`docId/docNum`, `operCodeName`, и даты: `acceptDate` — **timestamp** `2023-01-13T14:00:00.000`
(local, без TZ-суффикса), `operDate` — **дата** `DD.MM.YYYY`. `errors[]` обязательно проверяем
(не считать errored пустой `page` за «нет операций»).

> Печатные формы (`/statement/{format}` pdf/xlsx/…), аресты, брони, SWIFT, реестр — **пока не
> используем**; подключим по мере необходимости.
