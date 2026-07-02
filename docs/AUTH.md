# Авторизация оператора (вход для сотрудников)

> Last reviewed: 2026-07-01

Как сотрудник входит в **служебную/операторскую зону** приложения (сейчас — монитор
очередей `/queues`, дальше — страницы импорта авто/ручного). Модель портирована из
соседнего приложения **Procure AI** (`postroyka/purchase-ai-chat`) и адаптирована под
наш стек (Nuxt 4 SSG + Nitro-backend). Публичный лендинг `/` и встройка в Bitrix24
(`/app`, `/settings`) этой авторизацией **не** закрыты — там своя модель (портал/OAuth).

## Что это и что закрывает

- **Публичная форма `/login`** (вне Bitrix24) с общими креденшалами оператора.
- Закрывает страницы с `middleware: 'auth'` (пока `/queues`).
- **Реальная защита — на стороне API**: статический HTML пререндерится и публичен,
  поэтому клиентский `middleware` — это UX-редирект; данные должны отдавать только
  эндпоинты, требующие сессию (как `/api/queues` уже требует свой guard-токен).

## Поток

```
Сотрудник → /login (логин+пароль) → POST /api/auth/login
  ├─ нет пароля в env → 503 «вход не настроен» (зона открыта, auth выключен)
  ├─ неверно → 401
  └─ верно → Set-Cookie: cba_sess (подписанная, HttpOnly, SameSite=Lax, Secure)
             → редирект на ?redirect= (по умолчанию /queues)
Защищённая страница → middleware `auth` → GET /api/auth/session
  ├─ configured:false → пускаем (auth выключен)
  ├─ authenticated:false → редирект на /login?redirect=…
  └─ authenticated:true → показываем
Выход → POST /api/auth/logout → cookie очищается
```

## Реализация

| Слой | Файл | Что делает |
|---|---|---|
| Чистое ядро | `server/utils/session.ts` | `resolveAuthConfig`/`checkCredentials` (constant-time), `signSession`/`verifySession` (HMAC-SHA256, base64url), имена `SESSION_COOKIE`/`CSRF_HEADER`. Покрыто `tests/session.test.ts` |
| Логин | `server/api/auth/login.post.ts` | 503 если нет пароля; CSRF-заголовок; 401 на неверные; ставит подписанную cookie |
| Выход | `server/api/auth/logout.post.ts` | чистит cookie (CSRF-заголовок) |
| Статус | `server/api/auth/session.get.ts` | `{ configured, authenticated, user? }` для гварда |
| Клиент | `app/composables/useAuth.ts` | `login`/`logout`/`fetchSession` (шлёт CSRF-заголовок на мутациях) |
| Форма | `app/pages/login.vue` | публичная страница входа (`noindex`), редирект только на относительный путь |
| Гвард | `app/middleware/auth.ts` | клиентский редирект на `/login` (см. оговорку про API-защиту) |

## Безопасность

- **Cookie подписана, не Bearer в браузере**: `cba_sess = base64url(payload).base64url(HMAC)`,
  `HttpOnly` + `SameSite=Lax` + `Secure` (по `x-forwarded-proto`), `Max-Age` = TTL.
  Проверка подписи и сравнение — **constant-time** (`safeEqual`), истёкшая → отвергается.
- **CSRF**: мутации (`login`/`logout`) требуют кастомный заголовок `X-CBA-Auth` — его
  нельзя выставить кросс-сайтовой формой без CORS-preflight; плюс `SameSite=Lax`.
- **Креды не логируются**; пароль — только в env (`.env`, не в репозитории).
- Пароль пустой ⇒ вход **выключен** (зона открыта) — удобно для dev, но в проде
  пароль обязателен.

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `PUBLIC_PAGE_BASIC_AUTH_USER` | Логин оператора (по умолчанию `operator`) |
| `PUBLIC_PAGE_BASIC_AUTH_PASS` | Пароль. Пусто ⇒ вход выключен (503). Обязателен в проде |
| `SESSION_SECRET` | Секрет подписи cookie; если пусто — выводится из пароля |
| `SESSION_TTL_HOURS` | Срок сессии, ч (по умолчанию 12) |

## Осталось (follow-up)

- **Silent-сессия внутри Bitrix24 (`/session/b24`)**: в оригинале портал валидируется
  вызовом `app.info` + allowlist `B24_FRAME_ANCESTORS`, сессия ставится без формы. У нас
  фрейм уже даёт access-токен (`useAppSettings`) — на его основе можно выдавать сессию;
  вынесено в issue (зависит от валидации фрейм-токена через `app.info`).
- Защитить реальные data-эндпоинты сессией по мере их появления (страницы импорта).
