# Авторизация оператора (вход для сотрудников)

> Last reviewed: 2026-07-02

Как сотрудник входит в **служебную/операторскую зону** приложения (сейчас — монитор
очередей `/queues`, дальше — страницы импорта авто/ручного). Модель портирована из
соседнего приложения **Procure AI** (`postroyka/purchase-ai-chat`) и адаптирована под
наш стек (Nuxt 4 SSG + Nitro-backend). Публичный лендинг `/` и встройка в Bitrix24
(`/app`, `/settings`) этой авторизацией **не** закрыты — там своя модель (портал/OAuth).

## Что это и что закрывает

- **Публичная форма `/login`** (вне Bitrix24) с общими креденшалами оператора.
- Закрывает страницы с `middleware: 'auth'` (пока `/queues`).
- **Реальная защита — на стороне API**: статический HTML пререндерится и публичен,
  поэтому клиентский `middleware` — это UX-редирект. `/queues` берёт реальные данные из
  **`GET /api/ops/queues`**, который проверяет сессию `cba_sess` (`operatorAllowed`) — вот
  где настоящая защита; `?demo=1` — превью на синтетике. Отдельный `/api/queues` (токен
  `B24_APPLICATION_TOKEN` только заголовком, не сессия, + nginx `deny all`) — для консольной
  диагностики. Правило на будущее: любые реальные данные служебных страниц отдаёт эндпоинт,
  проверяющий сессию `cba_sess`, — полагаться на клиентский `middleware` нельзя.

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
| Чистое ядро | `server/utils/session.ts` | `resolveAuthConfig`/`checkCredentials` (constant-time), `signSession`/`verifySession` (HMAC-SHA256, base64url), имена `SESSION_COOKIE`/`CSRF_HEADER`, **статус-матрикс роутов** `decideLogin`/`decideLogout`/`sessionStatus` (тестируется без сервера). Покрыто `tests/session.test.ts` |
| Логин | `server/api/auth/login.post.ts` | тонкий I/O → `decideLogin`: 503 если нет пароля; 403 без CSRF-заголовка; 400 на битое тело; 401 на неверные; иначе ставит подписанную cookie |
| Выход | `server/api/auth/logout.post.ts` | тонкий I/O → `decideLogout` (403 без CSRF-заголовка, иначе чистит cookie) |
| Статус | `server/api/auth/session.get.ts` | тонкий I/O → `sessionStatus` → `{ configured, authenticated, user? }` для гварда |
| Клиент | `app/composables/useAuth.ts` | `login`/`logout`/`fetchSession` (шлёт CSRF-заголовок на мутациях) |
| Форма | `app/pages/login.vue` | публичная страница входа (`noindex`) на **b24ui** (layout `clear` → `<B24App>`, темизуется light/dark), редирект только на относительный путь |
| Гвард | `app/middleware/auth.ts` | клиентский редирект на `/login` (см. оговорку про API-защиту) |
| Анти-мигание | `app/components/AuthGate.vue` | client-only обёртка тела служебной страницы: пока идёт `fetchSession`, показывает нейтральное «Проверка доступа…» и раскрывает слот **только** после подтверждения сессии. SSG-HTML публичен, а `middleware`-редирект срабатывает уже **после** отрисовки — без гейта защищённый хром мелькнул бы до редиректа. Fail-open при недоступном backend (как middleware); реальная защита — на API |

## Безопасность

- **Cookie подписана, не Bearer в браузере**: `cba_sess = base64url(payload).base64url(HMAC)`,
  `HttpOnly` + `SameSite=Lax` + `Secure` (по `x-forwarded-proto`), `Max-Age` = TTL.
  Проверка подписи и сравнение — **constant-time** (`safeEqual`), истёкшая → отвергается.
  Флаг `Secure` берётся из `X-Forwarded-Proto` — это **доверенный** заголовок: в проде
  его безусловно проставляет nginx (`proxy_set_header X-Forwarded-Proto $scheme`), backend
  наружу не публикуется. Прямое обращение к backend в обход прокси недопустимо (в dev-compose
  порт backend замаплен — там заголовок можно подделать, это только для локальной разработки).
- **CSRF**: мутации (`login`/`logout`) требуют кастомный заголовок `X-CBA-Auth` — его
  нельзя выставить кросс-сайтовой формой без CORS-preflight (CORS-заголовки нигде не
  выставляются); плюс `SameSite=Lax`. Брутфорс-защиты (rate-limit) на `/api/auth/login`
  пока нет — вынесено в follow-up (nginx `limit_req`).
- **Открытый редирект**: `?redirect=` пропускается только как относительный путь —
  чистый гвард `safeRedirect` (`app/utils/loginRedirect.ts`, покрыт тестами) отвергает
  `//host` **и** backslash-обход `/\host` (WHATWG нормализует `\`→`/`), не полагаясь на
  внутренности `navigateTo`/`ufo`.
- **Креды не логируются**; пароль — только в env (`.env`, не в репозитории).
- Пароль пустой ⇒ вход **выключен** (зона открыта) — удобно для dev, но **в проде
  пароль обязателен**. `SESSION_SECRET` в проде тоже **обязателен и независим от пароля**:
  при деривации из пароля утёкшая cookie позволяет офлайн-подбор самого пароля. На старте
  backend (`server/plugins/authGuard.ts`) при `NODE_ENV=production` без пароля или без
  `SESSION_SECRET` пишет не-секретный `console.warn` (`authStartupWarning`).

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `PUBLIC_PAGE_BASIC_AUTH_USER` | Логин оператора (по умолчанию `operator`) |
| `PUBLIC_PAGE_BASIC_AUTH_PASS` | Пароль. Пусто ⇒ вход выключен (503). Обязателен в проде |
| `SESSION_SECRET` | Секрет подписи cookie; если пусто — выводится из пароля. **В проде обязателен** и независим от пароля |
| `SESSION_TTL_HOURS` | Срок сессии, ч (по умолчанию 12) |

## Осталось (follow-up)

- **Silent-сессия внутри Bitrix24 (`/session/b24`)**: в оригинале портал валидируется
  вызовом `app.info` + allowlist `B24_FRAME_ANCESTORS`, сессия ставится без формы. У нас
  фрейм уже даёт access-токен (`useAppSettings`) — на его основе можно выдавать сессию;
  вынесено в issue (зависит от валидации фрейм-токена через `app.info`).
- Защитить реальные data-эндпоинты сессией по мере их появления (страницы импорта).
