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
>
> Прямые ссылки `item-info.jag?…` — динамические и могут смениться при обновлении портала;
> при недоступности искать API через каталог `developerhub.alfabank.by/developerhub/`.

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

> **Scope:** нам нужен только `accounts` (счета + выписка). У API «Авторизация» есть и другие
> области (profile, документы/платежи, карты, валютообмен и т.д.) — понадобятся, если будем
> подключать платежи/чат через Альфу; пока не запрашиваем.

| Метод | Назначение | Используем |
|---|---|---|
| `GET /partner/1.2.0/accounts/` | список счетов и остатков | да — выбор счетов |
| `GET /partner/1.2.0/accounts/statement` | выписка по счёту(ам) | да — основной поток |

**Ключевые поля ответа `GET /accounts/`** (`accounts[]`): `number` (номер счёта),
`currIso` (валюта, симв.), `amount` (остаток бухгалтерский), `type`/`isCard` (тип/карточный),
флаги `isArrested`/`isReserved`/`isOverdraft` (арест/бронь/овердрафт), `actualBalanceDate`
(на какую дату актуальны остатки).

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

## Пример вызовов (проверено на sandbox, 2026-06-30)

Полный поток **OAuth (Authorization Code) → `/accounts/` → выписка → refresh** прогнан
вживую на песочнике `developerhub.alfabank.by:8273` тестовыми `client_id/secret`.
Все значения ниже — маскированы. `base = https://developerhub.alfabank.by:8273`.

> Перепроверить вживую: `pnpm oauth:test` (скрипт `scripts/alfa-oauth-test.mjs`,
> без зависимостей, Node ≥ 18). Это **песочничный** инструмент: конфиг берётся из
> `.env.sandbox` — скопируй шаблон `.env.sandbox.example` → `.env.sandbox` и впиши
> `ALFA_CLIENT_SECRET` (файл в `.gitignore`). Скрипт в баннере явно помечает режим
> `● SANDBOX`/`● NON-SANDBOX`. Токены и номера счетов в консоли маскируются; в дамп
> `alfa-demo-output.json` (gitignore) токены пишутся **замаскированными** (полные —
> только под `--full`). Флаги: `--env <file>`, `--from-year/--to-year`, `--account`,
> `--code`, `--refresh`, `--url-only`, `--full`.
>
> ⚠ По умолчанию опрашиваются **все годы 2000…2029** по каждому счёту с паузой 700 мс —
> это несколько минут. Для быстрой проверки сузь период: `pnpm oauth:test --from-year 2024 --to-year 2024`.

### 1. Authorize (браузер)

```http
GET {base}/authorize?response_type=code&client_id={clientId}
    &redirect_uri={redirectUri}&scope=accounts&state={state}
```

Пользователь логинится у Альфы и подтверждает доступ → редирект на
`{redirectUri}?code=1c00f727-…&state={state}`. `state` сверяем (CSRF), `code` короткоживущий.

### 2. Обмен `code` → токены

```http
POST {base}/token
Authorization: Basic base64(clientId:clientSecret)
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code={code}&redirect_uri={redirectUri}
```
```jsonc
// HTTP 200
{
  "access_token":  "ibHZMkuo…",   // ~89 симв.
  "refresh_token": "J0k+lQXu…",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "accounts"             // выдаётся ровно запрошенный scope
}
```

### 3. Счета — `GET /accounts/`

```http
GET {base}/partner/1.2.0/accounts/
Authorization: Bearer {access_token}
```
```jsonc
// HTTP 200 → { "accounts": [ … ] }; на sandbox вернулось 5 счетов:
{ "number": "BY…0000", "currIso": "BYN", "amount": 15000,     "type": "Текущий (расчетный)", "actualBalanceDate": "2018-02-07T12:30:42.190" }
{ "number": "BY…0000", "currIso": "USD", "amount": 57800.17,  "type": "Текущий (расчетный)", "isArrested": true }
{ "number": "BY…0000", "currIso": "BYN", "amount": 648540.76, "type": "Текущий (расчетный)", "isArrested": true }
// (поля type/isCard/isArrested/isReserved/isOverdraft/actualBalanceDate)
```

### 4. Выписка — `GET /accounts/statement`

```http
GET {base}/partner/1.2.0/accounts/statement?number={acc}
    &dateFrom=01.01.2024&dateTo=31.12.2024&transactions=0&pageNo=0&pageRowCount=0
Authorization: Bearer {access_token}
```
```jsonc
// HTTP 200 → { page:[…], statistics:[…], errors:[…] }
{
  "page": [
    {
      "number": "BY…0000", "operType": "C",            // C = приход / D = расход
      "amount": 150, "currIso": "BYN",
      "purpose": "ОПЛАТА ЗА ТОВАРЫ СОГЛАСНО ДОГОВОРУ…",
      "corrName": "ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИ…", "corrNumber": "BY…0000",
      "docId": "…", "docNum": "…",
      "operDate": "13.01.2024", "acceptDate": "2024-01-13T14:00:00.000"
    }
  ],
  "errors": []   // ВАЖНО: errored-ответ может прийти с пустым page — проверять errors[]
}
```

Нормализуем ответ в `StatementItem` через `normalizeAlfaStatement()` (см.
`app/utils/alfaStatement.ts`); ошибки по счёту — `alfaStatementErrors()`.

### 5. Refresh

```http
POST {base}/token
Authorization: Basic base64(clientId:clientSecret)
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token={refresh_token}
```
```jsonc
// HTTP 200 → новый access_token + refresh_token (expires_in: 3600)
```

### Замечания по sandbox

- **Песочница отдаёт фиксированные данные, игнорируя `dateFrom/dateTo` и номер счёта** —
  одна и та же выписка на каждый год. Фильтр по периоду проверяется только на проде.
- **Часть тестовых счетов отвечает `HTTP 500`** на `/statement` (серверная сторона
  песочницы) — транспорт должен это переживать и не считать ошибку за «нет операций».
- Лимит **~100 запросов/мин** на API (пилот; по данным на 2026-06-30, уточняй в договоре /
  на developerhub) — при массовом опросе нужна пауза/троттлинг.
