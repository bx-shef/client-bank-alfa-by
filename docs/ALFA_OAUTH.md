# OAuth Альфа-Банка: Authorization Code Grant

> Last reviewed: 2026-06-30

Как устроена авторизация в partner-API Альфа-Банка (developerhub) и как **вживую
проверить** поток Authorization Code Grant нашими `client_id`/`client_secret`.

## Эндпоинты

OAuth-шлюз слушает **нестандартный порт `8273`** (это критично для firewall/proxy):

| Шаг | Метод | URL |
|---|---|---|
| Авторизация (браузер) | `GET` | `https://developerhub.alfabank.by:8273/authorize` |
| Обмен кода на токен | `POST` | `https://developerhub.alfabank.by:8273/token` |
| Обновление токена | `POST` | `https://developerhub.alfabank.by:8273/token` |

Время жизни: `access_token` — 3600 c, `refresh_token` — 36000 c.

## Поток

1. **`/authorize`** — пользователь открывает в браузере URL с
   `response_type=code&client_id=…&redirect_uri=…&scope=…&state=…`, логинится в
   Альфе и подтверждает доступ.
2. Альфа редиректит на `redirect_uri` c `?code=…&state=…`. `redirect_uri` обязан
   **точно совпадать** с зарегистрированным для приложения.
3. **`/token`** — `POST` с `grant_type=authorization_code`, `code`, `redirect_uri`;
   client-креды передаём заголовком `Authorization: Basic base64(client_id:client_secret)`.
   Ответ — JSON c `access_token`/`refresh_token`.
4. Обновление — `POST /token` c `grant_type=refresh_token&refresh_token=…`.

Скоупы (см. `app/config/alfa.ts`): для выписки нужны `accounts read_documents profile`.

## Чистое ядро (переносимо в backend)

- `app/config/alfa.ts` — эндпоинты, скоупы, время жизни токенов (без секретов).
- `app/utils/oauth.ts` — чистые билдеры: `buildAuthorizeUrl`,
  `buildAuthorizationCodeBody`, `buildRefreshTokenBody`, `basicAuthHeader`,
  `parseAuthorizationCallback`. Покрыто `tests/oauth.test.ts`.

Реальный сетевой обмен (fetch) делает backend (этап 3 плана) — здесь только
контракт и его тесты.

## Живая проверка: `scripts/alfa-oauth-test.mjs`

Самодостаточный Node-скрипт (без зависимостей и сборки, Node ≥ 18, Linux/macOS/Windows).
Проходит весь Code Grant и печатает каждый запрос/ответ. Секреты — только через
переменные окружения/флаги, в коде их нет.

```bash
# Linux/macOS
ALFA_CLIENT_ID=xxx ALFA_CLIENT_SECRET=yyy pnpm oauth:test

# Windows (PowerShell)
$env:ALFA_CLIENT_ID="xxx"; $env:ALFA_CLIENT_SECRET="yyy"; pnpm oauth:test

# уже есть code (без браузерного шага)
node scripts/alfa-oauth-test.mjs --client-id xxx --client-secret yyy --code AUTH_CODE

# только показать authorize-URL
node scripts/alfa-oauth-test.mjs --client-id xxx --url-only
```

Флаги: `--redirect-uri` (по умолчанию `https://www.client.example.com` — замените на
зарегистрированный), `--scope`, `--base`, `--state`, `--refresh <token>`.

### Если шлюз недоступен

Поток требует исходящего TCP на `developerhub.alfabank.by:8273`. Если порт закрыт
firewall/proxy — preflight скрипта это покажет. На стандартном `443` живёт
WSO2-консоль (не API-шлюз) и `/token` отдаёт generic `403`, поэтому проверять нужно
именно `8273`. При ошибке TLS-сертификата задавайте `NODE_EXTRA_CA_CERTS`,
**не отключая** проверку сертификата.
