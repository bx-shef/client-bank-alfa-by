# Приорбанк — как работать с выпиской

> Last reviewed: 2026-07-01

С Приорбанком есть **два пути**. Сейчас в проекте реализован первый (импорт текстовой
выписки); второй (живой Open Banking API по СПР) пока не подключён, но контракт
зафиксирован по официальной инструкции банка (раздел 2) — можно писать чистое ядро.

## 1. Импорт текстовой выписки client-bank (работает сейчас)

Приорбанк (и ручная выгрузка) отдаёт выписку в **текстовом формате client-bank**
(`***** ^Type=…`, родственник `1CClientBankExchange`), кодировка **windows-1251 (CP1251)**.
Это *формат*, а не банковский клиент, поэтому он обслуживает оба провайдера —
`prior-by` и `manual` (см. `app/config/banks.ts`).

- **Парсер:** `app/utils/clientBankText.ts` → `parseClientBankText(text)` возвращает
  секции `GENERAL` / `IN_PARAM` / `OUT_PARAM` (`header` / `items` / `footer` / `unrouted`).
  Вход — уже декодированная строка (CP1251 → utf-8 декодируем заранее).
  ⚠️ Это **портированный пример**, требует рефакторинга — см. **issue #19** (нет нормализации
  в `StatementItem`, `unrouted`-корзина, `DocID` не пишется по строкам, нет лимита размера).
- **Образцы:** `tests/fixtures/client-bank/demo-prior-byn.txt` (рубли),
  `demo-prior-cny.txt` (валюта) — обезличенные, CP1251 (`.gitattributes` → `binary`).
- **Тесты:** `tests/clientBankText.test.ts` (characterization-тесты против образцов).

### Скрипт просмотра: `pnpm parse:statement`

`scripts/parse-statement.ts` — читает CP1251-файл, декодирует, прогоняет через
**канонический** `parseClientBankText` (логика не дублируется) и печатает разбор:
`GENERAL` (тип, счёт — маскирован, заголовок), по секциям `IN_PARAM`/`OUT_PARAM` —
число операций, период, остатки, первые операции и счётчик `unrouted`-ключей.

```bash
pnpm parse:statement tests/fixtures/client-bank/demo-prior-byn.txt
pnpm parse:statement path/to/your-export.txt another.txt   # можно несколько
```

Запускается нативным TS-стриппингом Node (`--experimental-strip-types`, **нужен Node ≥ 22**,
что совпадает с `engines` и CI) — без сборки и без новых зависимостей. Кросс-платформенно
(Linux/Windows). Декод CP1251 требует **full-ICU** Node (по умолчанию в официальных сборках).

> ⚠️ Вывод содержит **данные контрагентов и назначения платежей (PII)**, номер счёта —
> маскируется. Не запускай на боевых выписках в логируемых/расшаренных средах. Образцы в
> `tests/fixtures/` обезличены.

## 2. Живой Open Banking API по СПР (на будущее, ещё не подключён)

Контракт ниже — по **официальной инструкции Приорбанка** «Инструкция по подключению к
Open-banking API согласно СПР для разработчиков» (СПР 6.01-2020 / 6.02-2022, стек
**WSO2 API Manager**). Портал: <https://api.priorbank.by/> (Магазин API / devportal),
Postman-коллекция — на devportal.

### Три API

| API | Назначение |
|---|---|
| **Open-banking-authorize** | Аутентификация/авторизация, токены (`/oauth2/token`, `/oauth2/authorize`, `/oauth2/revoke`) |
| **Open-banking-DCR** | Динамическая регистрация бизнес-приложения (`/register`, `/oidcdiscovery`) |
| **Open-banking** | Согласия и счета (`/accountConsents`, `/accounts/...`) |

### Хосты и среды

- **Sandbox:** `https://api.priorbank.by:9344` — **обычный TLS** (OpenSSL). СКЗИ не нужен.
  Тестовый конечный пользователь для авторизации согласия: ЮЛ `testspr_le` / `445_e58$a7e8`,
  ФЛ `testspr_pi` / `jghh6ZQX`.
- **Прод:** `https://apibel.priorbank.by:9345` — **TLS на белорусских криптоалгоритмах**
  (СТБ 34.101.65), требуется **СКЗИ** (см. ниже) и договор об использовании Платёжного API.

### Поток подключения (4 шага)

1. **Тех-приложение (DCR).** В Магазине API создать технологическое приложение → подписать
   на **Open-banking-DCR** → создать ключи (`client_id`/`client_secret`).
   - Токен A: `POST /open-banking-authorize/v1.0/oauth2/token`,
     `grant_type=client_credentials`, `scope=apim:subscribe apim:app_manage`
     (креды тех-приложения — Basic-auth).
2. **Бизнес-приложение (DCR register).** `POST /open-banking-dcr/v1.0/register` с токеном A →
   создаётся бизнес-приложение (его `client_id`/`client_secret`). В теле:
   - `redirect_uri` — куда банк вернёт `code`;
   - `grant_types`: `client_credentials` (для согласия) + `authorization_code` (для счетов)
     + `refresh_token` (если нужен рефреш);
   - `token_endpoint_auth_method` (см. «Способы аутентификации»);
   - `jwks` (публичные ключи в формате JWK Set) — если метод `private_key_jwt` /
     `self_signed_tls_client_auth` или `grant_types` содержит `authorization_code`.
   - Конфиг сервера авторизации (в т.ч. `aud` для JWT) — `GET /open-banking-dcr/v1.0/oidcdiscovery`.
   - Затем подписать бизнес-приложение на **Open-banking API**.
3. **Согласие (consent).** Токен Б: `POST /oauth2/token`, `grant_type=client_credentials`,
   `scope=accounts` → `POST /open-banking/v1.0/accountConsents` с `permissions` (нужное нам:
   `ReadStatementsBasic`/`ReadStatementsDetail`, `ReadTransactionsBasic`/`Detail`/`Credits`/`Debits`,
   `ReadAccountsBasic`/`Detail`, `ReadBalances`), `expirationDate`, `transactionFromDate/ToDate`
   → получаем `openbanking_intent_id`. Затем **авторизация согласия пользователем**:
   `GET|POST /oauth2/authorize`, `response_type=code`, `scope=openid accounts`, параметр
   `request` = **подписанный JWT** (с `openbanking_intent_id`) → пользователь вводит логин/пароль
   от интернет-банка **на странице Приорбанка** → `code` на `redirect_uri`.
4. **Выписка.** Обмен `code` → токен B: `POST /oauth2/token`, `grant_type=authorization_code`.
   Затем **асинхронно**: `POST /accounts/{accountId}/statements` (или `.../transactions`) → потом
   опрашивать `GET /accounts/{accountId}/statements/{statementId}` (пока не готово — ошибка
   `BY.NBRB.Resource.NotCreated`). Рефреш: `grant_type=refresh_token`; отзыв: `POST /oauth2/revoke`.

### Способы аутентификации приложения (`token_endpoint_auth_method`)

- `client_secret_basic` / `client_secret_post` — **только sandbox** (client_id/secret в Basic-хедере
  или в теле).
- `private_key_jwt` — sandbox и прод. Подпись JWT (`client_assertion` + `client_assertion_type=
  urn:ietf:params:oauth:client-assertion-type:jwt-bearer`); публичный ключ регистрируется в `jwks`.
- `tls_client_auth` / `self_signed_tls_client_auth` — sandbox и прод, mTLS с клиентским
  сертификатом X.509 (доверенный УЦ в РБ — ГосСУОК; для self-signed — сертификат в `jwks`).

> **Рекомендация:** sandbox — `client_secret_basic` (проще всего). Прод — `private_key_jwt`
> (пара RSA-ключей, без mTLS-возни). Способ аутентификации приложения — **отдельный слой** от
> транспортного TLS: на проде BY-крипто TLS (СКЗИ) обязателен при любом из этих методов.

### СКЗИ (средство криптозащиты) — только для прода

Требование СПР 6.02: TLS с сервером авторизации Приорбанка на проде должен идти на **белорусских
криптоалгоритмах** (СТБ 34.101.65). Их сервер — «Сервер TLS АВЕСТ» (AvTLSSrv); с нашей стороны
нужен совместимый **клиентский СКЗИ** — инструкция называет **AvAuthGate** или **AvUCK**
(ЗАО «АВЕСТ»), плюс сертификат ГосСУОК.

Инструкция говорит буквально одно: «на стороне **клиента** должны быть установлены СКЗИ,
обеспечивающие клиентскую часть TLS-соединения» (клиент здесь = разработчик/его сервер, не
конечный пользователь). Ниже — **наша трактовка деплоя** (в PDF деталей про шлюз/Docker нет):

- **Где стоит:** на **нашем сервере (backend)**, а не у конечного пользователя. Практично
  развернуть как локальный **TLS-шлюз**: наш код ходит в него обычным HTTP(S), а он поднимает
  BY-крипто TLS до `apibel.priorbank.by:9345`; base URL Приора на проде указывает на шлюз.
- **Конечному пользователю ничего не нужно** — он лишь вводит логин/пароль интернет-банка на
  странице банка (обычный браузер/HTTPS); его пароль наше приложение не видит. *(Это уже из
  инструкции: авторизация согласия — на странице Приорбанка.)*
- **Sandbox работает без СКЗИ** — весь флоу разрабатываем и тестируем на `:9344` обычным TLS,
  СКЗИ подключаем последним шагом перед продом. *(Из инструкции: BY-крипто требуется для
  взаимодействия с сервером авторизации по `:9345`.)*
- **Docker (наша интерпретация):** СКЗИ — **не библиотека в образ**, а отдельный крипто-шлюз
  (продукт АВЕСТ) + гос-сертификат. Разумно развернуть **отдельным сервисом** рядом с backend
  (сайдкар/на хосте) — **поддержку Linux/контейнера и лицензирование обязательно уточнить у АВЕСТ**.
  Прод-схема (шлюз + сертификат + маршрут backend→шлюз→банк) — отдельный долг.

> **Чего не хватает для подключения** (issue [#27](https://github.com/bx-shef/client-bank-alfa-by/issues/27),
> [#20](https://github.com/bx-shef/client-bank-alfa-by/issues/20)): тестовые `client_id/secret`
> тех-приложения, `redirect_uri` (наш публичный HTTPS), **сетевой доступ к `api.priorbank.by:9344`**
> с BY-сервера (из облака агента недоступно), для прода — СКЗИ АВЕСТ + сертификат ГосСУОК.
> Чистое ядро провайдера (сборка запросов, парсинг, нормализация) пишется и тестируется на моках
> без доступов — как сделано для Альфы.

## Связь с архитектурой

`prior-by` и `manual` — провайдеры из абстракции `BankProvider` (`app/config/banks.ts`),
оба пока `implemented: false`. Путь №1 даёт парсинг формата; путь №2 (когда будут доступы) —
автоматическое получение выписки. Нормализация обоих в общий `StatementItem` — задача #19.
