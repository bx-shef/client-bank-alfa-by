# Приорбанк — как работать с выпиской

> Last reviewed: 2026-06-30

С Приорбанком есть **два пути**. Сейчас в проекте реализован первый (импорт текстовой
выписки); второй (живой Open Banking API) — на будущее, после получения доступов.

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

## 2. Живой Open Banking API (на будущее, ещё не подключён)

У Приорбанка есть портал разработчика на стеке **WSO2 API Manager** (как у Альфы):

- **API Store / devportal:** <https://api.priorbank.by/> и <https://api.priorbank.by/devportal/>
- **Инструкции (PDF):** «API setup instructions» и вариант «…SPR» (по стандарту
  открытого банкинга НБРБ, СПР) — на devportal в разделе public/files.

Из того, что известно по докам (**все эндпоинты/скоупы требуют подтверждения** из
devportal/PDF и на живом прогоне — ниже ориентир, а не финальный контракт):

- OAuth 2.0 поверх WSO2 API Manager. Регистрация приложения — обычно в два шага:
  1. получить токен управления: `POST /oauth2/token`, `grant_type=client_credentials`,
     `scope=apim:subscribe apim:app_manage`;
  2. зарегистрировать клиента (**Dynamic Client Registration**) — отдельный эндпоинт
     WSO2 (`/client-registration/<version>/register`), точный путь уточнить в devportal.
- Далее — доступ к счетам/выписке клиента по access-токену через Open-banking API.

> **Чего не хватает для подключения** (вынесено в [issue #27](https://github.com/bx-shef/client-bank-alfa-by/issues/27)):
> партнёрские `client_id/secret` Приорбанка, **сетевой доступ к `api.priorbank.by`** (в текущей
> среде разработки этот хост недоступен), и подтверждение точных эндпоинтов/скоупов из devportal/PDF.
> До этого живой клиент Приорбанка не реализуем и не проверяем — работаем через путь №1.

## Связь с архитектурой

`prior-by` и `manual` — провайдеры из абстракции `BankProvider` (`app/config/banks.ts`),
оба пока `implemented: false`. Путь №1 даёт парсинг формата; путь №2 (когда будут доступы) —
автоматическое получение выписки. Нормализация обоих в общий `StatementItem` — задача #19.
