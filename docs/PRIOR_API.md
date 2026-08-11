# Приорбанк — как работать с выпиской

> Last reviewed: 2026-08-11

С Приорбанком есть **два пути**, и оба реализованы: импорт текстовой выписки (раздел 1) и
живой Open Banking API по СПР (раздел 2 — движок опроса, connect-поток и включение в крон
готовы, A5b). Sandbox `:9344` работает обычным TLS. Для **прода** второму пути нужны **две
разные вещи**, и путать их нельзя:

1. **Инфраструктура** — BY-крипто TLS-шлюз (СКЗИ, СТБ 34.101.65),
   [#41](https://github.com/bx-shef/client-bank-alfa-by/issues/41). ⛔ **Не закрыто**: покупается
   у вендора, кодом не решается.
2. **Код** — прод-метод аутентификации `private_key_jwt`
   ([#444](https://github.com/bx-shef/client-bank-alfa-by/issues/444)), потому что
   `client_secret_basic` банк принимает **только в тестовой среде**. ✅ **Реализовано**
   (переключается `PRIOR_OAUTH_AUTH_METHOD`); осталось прогнать на sandbox — СКЗИ для этого
   не нужен.


## Движок опроса: две вещи, на которых легко ошибиться

- **`accountId` Приора — НЕ наш IBAN.** Перед созданием запроса выписки нужно резолвить опаковый
  идентификатор счёта из нашего номера (`resolvePriorAccountId` → `GET /accounts`). Это разные
  идентификаторы, и подстановка IBAN напрямую даёт отказ, который легко принять за «нет данных».
- **429/5xx на поллинге ресурса — это «ещё не готово», а НЕ пустая выписка.** Трактовать их как
  пустой ответ нельзя: троттл тихо съел бы окно операций, и импорт «прошёл бы успешно» без единой
  строки. Нераспознанное тело ответа — тоже ошибка, а не «пусто».

## 1. Импорт текстовой выписки client-bank (работает сейчас)

Приорбанк (и ручная выгрузка) отдаёт выписку в **текстовом формате client-bank**
(`***** ^Type=…`, родственник `1CClientBankExchange`), кодировка **windows-1251 (CP1251)**.
Это *формат*, а не банковский клиент, поэтому он обслуживает оба провайдера —
`prior-by` и `manual` (см. `app/config/banks.ts`).

- **Парсер (формат):** `app/utils/clientBankText.ts` → `parseClientBankText(text)` возвращает
  секции `GENERAL` / `IN_PARAM` / `OUT_PARAM` (`header` / `items` / `footer` / `unrouted`).
  Вход — уже декодированная строка (CP1251 → utf-8 декодируем заранее). `DocID`/`Cod` (BIC)
  теперь пишутся по строкам. Остаточный рефактор (словари ключей, лимит размера) — **issue #19**.
- **Нормализация:** `app/utils/clientBankStatement.ts` → `normalizeClientBank(parsed, ctx)` →
  `StatementItem[]` (контракт `StatementNormalizer`): приход/расход (плюсовой дебет → расход),
  валюта (нац/инвалюта: маркеры `I3`/`I1`/`I2`, иначе `BY…`-счёт → `BYN`), контрагент (имя/УНП/счёт/BIC),
  `Nazn`+`Nazn2` → назначение, `account|docId`-дедуп. Для инвалюты сумма берётся в валюте счёта
  (поле `…Q`) — правило подтверждено на образце CNY, проверить на реальных инвалютных выписках (#19).
- **Образцы:** `tests/fixtures/client-bank/demo-prior-byn.txt` (рубли),
  `demo-prior-cny.txt` (валюта) — обезличенные, CP1251 (`.gitattributes` → `binary`).
- **Тесты:** `tests/clientBankText.test.ts` (парсер) + `tests/clientBankStatement.test.ts` (нормализация)
  против образцов.

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

## 2. Живой Open Banking API по СПР (реализован; прод ждёт СКЗИ #41)

Контракт ниже — по **официальной инструкции Приорбанка** [«Инструкция по подключению к
Open-banking API согласно СПР для разработчиков»](https://api.priorbank.by/devportal/site/public/files/API%20setup%20instructionsSPR.pdf)
(PDF, 21 стр.; СПР 6.01-2020 / 6.02-2022, стек **WSO2 API Manager**). Портал:
<https://api.priorbank.by/> (Магазин API / devportal), Postman-коллекция — на devportal.
Ссылки на страницы ниже — по этому PDF (редакция, вычитанная 2026-08-10).

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
  (СТБ 34.101.65), требуется **СКЗИ** (см. ниже) и **Договор об использовании Платёжного API**
  с банком (стр. 5 инструкции). ✅ **Договор с банком заключён** (подтверждено владельцем,
  2026-08) — этот шаг закрыт, остаются СКЗИ
  ([#41](https://github.com/bx-shef/client-bank-alfa-by/issues/41)). Прод-метод аутентификации
  ([#444](https://github.com/bx-shef/client-bank-alfa-by/issues/444)) — **реализован**, см.
  «Способы аутентификации» ниже.
  ⚠ **Отдельного тестового хоста у прода нет** — эндпоинт тот же. В личном кабинете Магазина API
  создаются отдельные «тестовые» и «промышленные» ключи приложения (стр. 7, §1.3), но тип ключей
  **не влияет на транспорт**: любое обращение к `:9345` всё равно требует BY-крипто TLS, то есть
  без СКЗИ туда не достучаться никакими ключами.

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

Перечень и границы применимости — стр. 9 §2.2 инструкции, детали каждого метода — §4.1.1–4.1.4.

- `client_secret_basic` / `client_secret_post` — **только тестовая среда** (client_id/secret в
  Basic-хедере или в теле). Формулировка инструкции категоричная: «используется только для тестовой
  среды», §4.1.1 вынесено в заголовок.
- `private_key_jwt` — тестовая **и промышленная**. Подпись JWT (`client_assertion` +
  `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`); публичный ключ
  регистрируется в `jwks`.
- `tls_client_auth` — тестовая и промышленная, mTLS с сертификатом X.509 от доверенного УЦ
  (в РБ — **ГосСУОК**). Дополнительно при регистрации нужен один из параметров
  `tls_client_auth_subject_dn` / `_san_dns` / `_san_uri` / `_san_ip` / `_san_email` (§4.1.3).
- `self_signed_tls_client_auth` — тестовая и промышленная, mTLS с **самоподписанным** сертификатом,
  опубликованным в `jwks` (§4.1.4). ГосСУОК не нужен, но взаимный TLS остаётся.

> **Что берём:** sandbox — `client_secret_basic` (проще всего). Прод — **`private_key_jwt`**: из трёх
> допустимых в проде методов он единственный без взаимного TLS и без клиентского сертификата, то есть
> и без ГосСУОК. Это **не предпочтение, а требование** — `client_secret_basic` в проде не примут.
>
> ✅ **`private_key_jwt` реализован** ([#444](https://github.com/bx-shef/client-bank-alfa-by/issues/444)).
> Метод выбирается переменной **`PRIOR_OAUTH_AUTH_METHOD`** (`client_secret_basic` по умолчанию —
> sandbox; `private_key_jwt` — прод). Неизвестное значение ⇒ откат к sandbox-методу: fail-safe,
> чтобы не вооружить прод-метод, под который приложение может быть не зарегистрировано.
>
> ⚠ **DCR регистрирует ОДИН метод на приложение**, поэтому переключать надо согласованно: env
> сервера **и** регистрацию приложения (`pnpm prior:test --auth-method private_key_jwt --dcr`).
> Рассогласование = 401 на том месте, которое забыли.
>
> Все места аутентификации идут через **единую точку** — чистый `priorTokenRequest`
> (`app/utils/priorOauth.ts`) поверх `resolvePriorTokenAuth` (`server/utils/priorTokenAuth.ts`):
>
> 1. **Регистрация приложения (DCR)** — `buildRegistrationMetadata` (`tokenEndpointAuthMethod`);
> 2. **Токен Б** (создание согласия, `client_credentials`) — `server/utils/priorConnectStart.ts`;
> 3. **Обмен `code` на токен** — `server/utils/bankConnectCallback.ts`;
> 4. **Рефреш токена** — `server/utils/ensureBankToken.ts` (`bankRefreshRequest`).
>
> ⚠ Пункт 2 легко пропустить (он в connect-преамбуле, а не в «токенных» модулях) — а именно он
> ломает прод **на первом же шаге** подключения, раньше остальных. Есть отдельный тест ровно на это.
> В скрипте разведки то же самое касается и `/oauth2/revoke` (в backend такой ветки нет).
>
> **Что осталось:** живой прогон на sandbox (`pnpm prior:test --auth-method private_key_jwt`) —
> СКЗИ для него не нужен. ⚠ Sandbox докажет **механику JWT**, но не идентичность прод-стека WSO2:
> хост `:9345` недостижим до закрытия #41.
>
> Способ аутентификации приложения — **отдельный слой** от транспортного TLS: на проде BY-крипто TLS
> (СКЗИ) обязателен при любом из этих методов.

### Скрипт живой проверки sandbox: `pnpm prior:test`

`scripts/prior-oauth-test.mjs` — самодостаточный (без npm-зависимостей, ESM, как
`alfa-oauth-test.mjs`) прогон **sandbox** по контракту выше. Конфиг — `.env.priorbank`
(шаблон `.env.priorbank.example`); токены/счета маскируются, вывод — в `prior-demo-output.json`
(gitignored). Режимы:

```bash
pnpm prior:test --gen-key      # RSA-пара + jwks для регистрации приложения (kid ← PRIOR_KID)
pnpm prior:test --oidc         # token A → /oidcdiscovery (issuer, token endpoint = aud)
pnpm prior:test --dcr          # token A (тех-приложение) → POST /register → бизнес-app client_id/secret
pnpm prior:test                # consent → authorize (подписанный request-JWT) → code → выписка
pnpm prior:test --url-only     # только собрать и показать authorize-URL (без сети)
pnpm prior:test --revoke <t>   # отзыв токена
```

Поток по умолчанию: token Б (`scope=accounts`) → `POST /accountConsents` → печатает
authorize-URL (подписывает `request`-JWT ключом `PRIOR_PRIVATE_KEY`) → входишь тестовым
пользователем (`testspr_le`/`testspr_pi`) → вставляешь redirect с `code` → обмен на токен B →
`GET /accounts` → асинхронные `POST`/`GET /accounts/{id}/statements`. Живой запуск — на деплой-сервере
с кредами `.env.priorbank` (sandbox `:9344`). Флаги для итераций:
`--access-token <tokenB>` (пропустить браузер), `--account <id>`, `--all`, `--from/--to`,
`--expires`, `--verbose`.

**Прод-метод аутентификации (#444):** `--auth-method private_key_jwt` переключает клиентскую
аутентификацию на подписанный `client_assertion`. Флаг влияет и на `--dcr`, потому что
зарегистрированный метод обязан совпадать с тем, которым потом ходим:

```bash
pnpm prior:test --auth-method private_key_jwt --dcr   # НОВАЯ регистрация под прод-метод
pnpm prior:test --auth-method private_key_jwt         # тот же поток тем же методом
```

Токен A (тех-приложение) остаётся на Basic всегда — это не DCR-клиент, у него нет `jwks`.
Против среды, отличной от sandbox, задавай ещё и `--audience` (значение читается через `--oidc`):
дефолт — sandbox-issuer и за `--base` он не следует.

### ⚠ Переключение РЕАЛЬНОГО деплоя на `private_key_jwt`

Это не «поменять одну переменную». У существующего приложения метод не переключается — нужна
**новая DCR-регистрация**, а значит новый `client_id`/`client_secret`. Отсюда следствие, которое
легко проглядеть:

> **Смена `client_id` осиротит все уже подключённые счета Приора.** Их `refresh_token` выдан
> старому клиенту, поэтому при следующем обновлении они начнут падать, пока админ не переподключит
> банк заново из настроек портала. Пер-портальные отказы `bank-fetch-prior` намеренно исключены из
> алертинга (#426), так что первым сигналом станет молча остановившийся импорт.

Порядок:

1. Зарегистрировать новое приложение под метод (`--dcr --auth-method private_key_jwt`), сохранить
   выданные `client_id`/`client_secret`.
2. Обновить в env бэкенда: `PRIOR_OAUTH_CLIENT_ID`, `PRIOR_OAUTH_CLIENT_SECRET`,
   **`PRIOR_OAUTH_AUTH_METHOD=private_key_jwt`**, и убедиться, что `PRIOR_OAUTH_PRIVATE_KEY` /
   `_KID` / `_AUDIENCE` заданы **на всех** процессах, включая воркер и крон (рефреш живёт там,
   а не в API-контейнере). При старте `envCheck` предупредит, если чего-то не хватает.
3. Предупредить клиентов и **переподключить счета** через настройки портала.
4. Откат: вернуть прежние `client_id`/`client_secret` и снять `PRIOR_OAUTH_AUTH_METHOD` —
   код целиком вернётся к прежнему поведению. Счета придётся переподключить снова.

Общее правило про ротацию банковских кредов — [`OPERATIONS.md`](OPERATIONS.md).

### Подтверждено на живом прогоне sandbox (2026-07-01)

Весь поток пройден end-to-end по свагерам DCR и Open-banking. Нюансы, которые дал живой прогон
(учтены в скрипте):

- **DCR `POST /register`** (`application/json`): `jwks` передаётся **строкой** (сериализованный JWK
  Set), `token_endpoint_auth_method` — **массив**; обязателен только `redirect_uris`. Имя приложения
  (`client_name`) — свободный текст (кириллица/пробелы ок), но **уникальное** (дубль → `409`). Обновления
  имени по API нет (только `GET /register/{clientId}`) — смена имени = перерегистрация.
- **`aud` в `request`-JWT** = `issuer` из `/oidcdiscovery` = `https://api.priorbank.by:9544/oauth2/token`
  (порт **9544**, не 9344).
- **Согласие `POST /accountConsents`**: `data.expirationDate` — **срок действия согласия, в будущем**
  (не окно выписки); окно — `transactionFromDate/ToDate` (может быть в прошлом).
- **Выписка `POST /accounts/{id}/statements`**: тело `{ data: { statement: { fromBookingDate,
  toBookingDate } } }`, даты в формате **`yyyy-MM-dd`** (без времени), окно **≤ 3 месяцев** (иначе
  `BY.NBRB.Field.InvalidDate`). Ответ `201` → `data.statement.statementId` → опрос
  `GET …/statements/{statementId}` (200 = готова). Sandbox **жёстко троттлит** (`429`) — по одному счёту.
- **Ответ выписки**: `data.statement` c `openingAvailableBalance`/`closingAvailableBalance`
  (`creditDebitIndicator`, `currency`, `amount`) + `transaction[]` + `links`/`meta` (пагинация).
  Элемент транзакции (`StatementInfoTransaction`): `creditDebitIndicator` (Credit=приход/Debit=расход),
  `amount`/`currency`/`equivalentAmount`, `transactionDetails` (назначение), `transactionId`, `number`,
  `bookingDateTime`/`valueDate`, `debtor`/`creditor` (`name`), `debtorAccount`/`creditorAccount.identification`
  (IBAN), `debtorAgent`/`creditorAgent.identification` (BIC) — прямой маппинг в наш `StatementItem`.

### СКЗИ (средство криптозащиты) — только для прода

Требование СПР 6.02: TLS с сервером авторизации Приорбанка на проде должен идти на **белорусских
криптоалгоритмах** (СТБ 34.101.65). Инструкция (стр. 4) говорит дословно:

> «разработчику обязательно требуется приобрести СКЗИ … для взаимодействия с нашим сервером
> авторизации, который использует программный комплекс "Сервер TLS АВЕСТ" (AvTLSSrv). На стороне
> клиента должны быть установлены СКЗИ, обеспечивающие клиентскую часть TLS-соединения, согласно
> требованиям СТБ 34.101.65 **с возможностью аутентификации сервера авторизации или двусторонней
> аутентификации**. Такими СКЗИ **могут быть, в том числе**, AvAuthGate (ЗАО «АВЕСТ») или компоненты
> комплекта абонента АВЕСТ (AvUCK). СКЗИ настраиваются в соответствии с рекомендациями разработчика.»

Что отсюда следует буквально — и что **не** следует:

- **AvTLSSrv — это то, что стоит у банка.** Для нашей стороны инструкция продукт не предписывает
  вообще: список открытый («могут быть, **в том числе**»), названы **AvAuthGate** и **AvUCK**.
  ЗАО «АВЕСТ» на прямой запрос рекомендует **AvTLSSrv с настройками клиентской части** (2026-08) —
  это рекомендация вендора, а не требование банка. Банк на вопрос о совместимых версиях ответил:
  «перечня совместимых версий не имеем, выбор решения лежит на разработчике».
- **Достаточно односторонней аутентификации** (только сервера авторизации) — двусторонняя названа
  как альтернатива, не как обязанность. Подтверждено ответом банка (2026-08): «достаточно серверной
  аутентификации».
- **Сертификат ГосСУОК для нашего сценария НЕ нужен.** В разделе про СКЗИ он не упомянут ни разу;
  единственное место в инструкции — §4.1.3, в описании `tls_client_auth` (mTLS). Мы этот метод не
  используем, см. «Способы аутентификации» выше и [#444](https://github.com/bx-shef/client-bank-alfa-by/issues/444).
  *(Ранее в этом документе ГосСУОК ошибочно значился как обязательный для прода — два разных
  требования были склеены в одно.)*
- **Про носители ключей (НКИ) в инструкции нет ничего** — это свойство конкретного продукта СКЗИ,
  а не требование банка. Вопрос принципиальный для облачного сервера (аппаратный токен туда не
  вставить) и адресуется вендору, см. [#41](https://github.com/bx-shef/client-bank-alfa-by/issues/41).

Ниже — **наша трактовка деплоя** (в PDF деталей про шлюз/Docker нет):

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
  (продукт АВЕСТ). Разумно развернуть **отдельным сервисом** рядом с backend
  (сайдкар/на хосте) — **поддержку Linux/контейнера, требование к носителю ключей и лицензирование
  обязательно уточнить у АВЕСТ**. Прод-схема (шлюз + маршрут backend→шлюз→банк) — отдельный долг.
- **Адреса расщеплены — код к шлюзу готов** (#455). У `PRIOR_OAUTH_API_BASE` было **две роли**, и
  они требуют разных адресов:
  | Переменная | Кто ходит | Куда при шлюзе |
  |---|---|---|
  | `PRIOR_OAUTH_API_BASE` | backend: токен, согласие, счета, выписка | **на шлюз** (можно `http://` — внутренний адрес) |
  | `PRIOR_OAUTH_AUTHORIZE_BASE` | **браузер администратора**, top-level | **на публичный хост банка** (только `https://`) |

  `PRIOR_OAUTH_AUTHORIZE_BASE` не задан ⇒ берётся `PRIOR_OAUTH_API_BASE` — верно, пока шлюза нет.
  Правила адресов — чистый `app/utils/bankGatewayUrl.ts` (под тестами): `http://` разрешён **только**
  на внутренний хост (loopback / имя docker-сервиса / приватная сеть), потому что именно так работает
  шлюз; `http://` на публичный хост отвергается — это отправило бы токен открытым текстом. Внутренний
  адрес в authorize-origin отвергается тоже: это ровно та ошибка, которая убивает подключение молча.
  Заданное, но негодное значение **не подменяется** молча на API-base — конфиг просто не собирается.

  Где правило реально применяется (а где нет — чтобы не считать проверку тотальной):
  | Читатель env | Переменная | Проверка |
  |---|---|---|
  | `priorConnectStart.ts` (`priorConnectConfigFromEnv`) | `PRIOR_OAUTH_API_BASE` / `_AUTHORIZE_BASE` | обе, fail-closed → 400 |
  | `priorFetch.ts` (`priorApiBaseFromEnv`) | `PRIOR_OAUTH_API_BASE` | да |
  | `bankFetch.ts` (`bankApiConfig`) | `PRIOR_OAUTH_API_BASE`, `ALFA_OAUTH_API_BASE` | да (оба банка) |
  | `ensureBankToken.ts` (`bankCredsFromEnv`) | `{PRIOR,ALFA}_OAUTH_TOKEN_URL` | да |
  | `envCheck.ts` | всё вышеперечисленное | предупреждения на старте |

  Вне охвата **сознательно**: `PRIOR_OAUTH_AUDIENCE` (это claim в JWT, а не сетевой адрес),
  `ALFA_OAUTH_REDIRECT_URI`/`PRIOR_OAUTH_REDIRECT_URI` (их байт-в-байт сверяет банк — наша
  нормализация сломала бы сверку) и authorize-хост Альфы (выводится из её `TOKEN_URL`, который уже
  проверен).
- ⚠ **`PRIOR_OAUTH_AUDIENCE` трогать нельзя** — это claim `aud` внутри подписанного `request`-JWT,
  который проверяет банк, а не сетевой адрес. Переставить его «за компанию» на шлюз = банк начнёт
  отвергать JWT, а симптом будет выглядеть как ошибка авторизации, не как ошибка конфигурации.
- ⚠ **`PRIOR_OAUTH_API_BASE` и `PRIOR_OAUTH_TOKEN_URL` — независимые переменные**, код нигде не
  проверяет, что они смотрят на один адрес. Обновят одну, забудут вторую — рефреш токена тихо
  продолжит стучаться на старый хост. Проверять обе вместе.

> **Чего не хватает для подключения** (issue [#27](https://github.com/bx-shef/client-bank-alfa-by/issues/27),
> [#20](https://github.com/bx-shef/client-bank-alfa-by/issues/20)): тестовые `client_id/secret`
> тех-приложения, `redirect_uri` (наш публичный HTTPS); **для прода — СКЗИ на `:9345`**
> ([#41](https://github.com/bx-shef/client-bank-alfa-by/issues/41)) и **прод-метод аутентификации**
> ([#444](https://github.com/bx-shef/client-bank-alfa-by/issues/444)). Крипто — требование РБ, не
> сетевое ограничение: sandbox `:9344` достижим с деплой-сервера.
> Чистое ядро провайдера (сборка запросов, парсинг, нормализация) пишется и тестируется на моках
> без доступов — как сделано для Альфы.

## Связь с архитектурой

`prior-by` и `manual` — провайдеры из абстракции `BankProvider` (`app/config/banks.ts`).
Единый контракт разбора — `StatementNormalizer` (raw → `StatementItem[]`, см.
[`REFACTOR_PLAN.md`](REFACTOR_PLAN.md) «Единый интерфейс выписки»):

- **`prior-by` (путь №2)** — нормализация **сделана**: `normalizePrior` в `app/utils/priorStatement.ts`
  (операция Open Banking → `StatementItem`), покрыта тестами по живому sandbox-образцу. OAuth/DCR/consent-ядро
  **вынесено** в чистый `app/utils/priorOauth.ts` (URL/тела/claims + парсеры, без `node:crypto`; аналог
  `alfaOauth.ts`) под `tests/priorOauth.test.ts`; `scripts/prior-oauth-test.mjs` — тонкий потребитель.
  **Серверный движок опроса — собран (A5b, слайс 1):** `server/utils/priorFetch.ts` (`fetchPriorStatement`) —
  async `POST /accounts/{id}/transactions` → поллинг `GET …/{id}` (пока `BY.NBRB.Resource.NotCreated` → ждём и
  повторяем, бюджет `PRIOR_POLL_MAX_ATTEMPTS`) → `normalizePrior`; чистые билдеры путей/классификатор статуса
  (`buildPriorResourceCreatePath`/`PollPath`/`classifyPriorPoll`) в `priorOauth.ts`, DI-транспорт, юнит-тесты
  (`tests/priorFetch.test.ts`). Проведён в `fetchBankStatement` (делегат `deps.fetchPrior`).
  **Connect-поток — собран (A5b, слайсы 2a-2d):** подписчик `server/utils/priorJwt.ts` (`signPriorJwt` — RS256
  через `node:crypto`, зеркалит `signJwt` recon-скрипта) + оркестрация `server/utils/priorConnectStart.ts`
  (`buildPriorConnectUrl`: токен Б → `POST /accountConsents` → подписанный `request`-JWT → authorize-URL;
  `priorConnectConfigFromEnv` fail-closed) + диспетчер по провайдеру в `bankConnectStart`/`bankConnectCallback`
  (гейты и подписанный state — общие с Альфой; обмен кода у Приора идёт **по настроенному методу**
  — Basic-заголовок или подписанный `client_assertion`, см. «Способы аутентификации»; отсутствующий
  `refresh_token` допускается) + пикер банка в `BankConnectCard.vue`. Env —
  `PRIOR_OAUTH_{CLIENT_ID,CLIENT_SECRET,REDIRECT_URI,AUDIENCE,PRIVATE_KEY,KID,API_BASE,AUTHORIZE_BASE,AUTH_METHOD}`
  (`AUTHORIZE_BASE` — только при крипто-шлюзе, см. «СКЗИ» ниже; `CLIENT_SECRET` — только при
  `client_secret_basic`).
  **Автоопрос ВКЛЮЧЁН:** `prior-by` в `POLLABLE_PROVIDERS` (`server/queue/cron.ts`). Обе причины, по
  которым он раньше был выключен, закрыты:
  (1) лимитер A8 считал ЗАДАЧИ из расчёта «1 задача ≈ 1 запрос» (верно для Альфы), а задача Приора — до
  10 HTTP; (2) `bank-fetch` идёт с `QUEUE_CONCURRENCY`
  (дефолт 1), и задача Приора держит слот весь цикл create+poll, блокируя чужие выборки. Счета Приора
  подключаются и хранят токены, но автоматически не опрашиваются.
  **Осталось:** живой sandbox-прогон на кредах владельца (в т.ч. `--auth-method private_key_jwt`)
  и **прод-СКЗИ** (issue #41 — без BY-крипто TLS-шлюза прод-хост `:9345` недостижим;
  инфраструктура, кодом не решается). Прод-метод аутентификации (#444) — **сделан**. Sandbox
  `:9344` работает обычным TLS и не требует ни того, ни другого.
- **`manual` (путь №1)** — нормализация **сделана** для **двух форматов** (диспетчер
  `app/utils/manualImport.ts` → `detectManualFormat`/`normalizeManualStatement`):
  1. **`***** ^Type=`** (Приор/Альфа-выгрузка) — `normalizeClientBank` (`clientBankStatement.ts`).
     Проверено и на реальных `Type=4`-файлах: BYN-дефолт для старых 13-значных BY-счетов и фолбэк
     ключа дедупа `Num|DocDate`, когда в выгрузке нет `DocID` (**#19**).
  2. **`1CClientBankExchange`** (обмен 1С «Клиент-банк», версии 1.01–1.03) — `normalizeOneC`
     (`oneCExchange.ts` парсер + `oneCStatement.ts` нормализатор): направление по «наш счёт =
     плательщик/получатель», валюта из кода счёта (RU 20-знач `810`→RUB и т.п. / BY→BYN), дедуп
     `Номер|Дата`. Универсальный бухгалтерский формат 1С (РФ+РБ) — **#21**. Обезличенный образец —
     `tests/fixtures/1c-exchange/demo-1c.txt`.
  Осталось — UI-загрузка файла и остаточный рефактор парсера `***** ^Type=` (**#19**).

> **Дедуп/идемпотентность:** ключ операции — `account|docId`, где для Приорбанка `docId = transactionId`.
> Дедуп корректен, пока Приорбанк отдаёт **стабильный и уникальный** `transactionId` в разрезе счёта
> (подтвердить на проде; при переиздании id банком возможны дубли/потери). Для Альфы `docId` — учётный
> номер документа. При отсутствии `transactionId` ключ **не** схлопывается в `account|` (#430 C1):
> `dedupKey` падает на контент-сигнатуру (хеш суммы/валюты/даты/направления/назначения/счёта
> контрагента) — операции без id остаются различимы.
