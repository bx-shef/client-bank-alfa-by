# Наблюдаемость: OpenTelemetry (#78)

> Last reviewed: 2026-07-21

Глубокая телеметрия backend'а на **OpenTelemetry** (официальный вектор Bitrix24 —
`bitrix-tools/b24-ai-starter-otel`): трейсы + метрики (+ логи) по OTLP в коллектор →
хранилище → Grafana. Разнесено на два слайса.

## Слайс 1 — инструментирование Node (app-side) ✅

**По умолчанию ВЫКЛЮЧЕНО.** Без `OTEL_EXPORTER_OTLP_ENDPOINT` бэкенд работает ровно как раньше —
`otel.instrument.mjs` при старте ничего не поднимает (лог `[otel] disabled …`).

- **Бутстрап `otel.instrument.mjs`** — грузится через `NODE_OPTIONS=--import` **до** приложения
  (иначе авто-инструментирование не успеет перехватить `http`/`pg`/`ioredis`; Nitro-плагин — поздно,
  а бандлер Nitro ломает require-хуки OTel, поэтому deps **вне** бандла — отдельный
  `otel-preload-package.json`, ставится в backend-образ). Поднимает `NodeSDK` +
  `getNodeAutoInstrumentations()` (http/pg/ioredis; `fs` выключен как шум) + OTLP trace/metric
  экспортёры. Эндпоинт/заголовки — из env.
- **Ручные спаны** (`@opentelemetry/api`, no-op когда SDK не зарегистрирован) — **покрывают весь конвейер**:
  - `withDependencySpan()` — **каждый исходящий B24-вызов**: одиночный `makeSdkRestCall` (`dep bitrix24 <method>`),
    **батч `makeSdkBatchCall`** (`dep bitrix24 batch`, `dep.op_count`=число команд) и **OAuth-refresh**
    (`sdkRefreshTransport` → `dep bitrix24 oauth.refresh`). Атрибуты `{system, operation, method, scope, status,
    error_kind, op_count?, portal.hash}`.
  - `withSpan('<job>', …)` — **все четыре job-воркера**: `crm-sync` (исходы `{op_count, recognized, resolved,
    allocated, ambiguous, manual, distributed}`), `bank-fetch` (`{provider, op_count=fetched}`), `file-parse`
    (`{provider, op_count=parsed}` — единственная стадия без авто-дочернего спана, чистый CPU), `b24-events`
    (`{kind, portal.hash}`). Плюс **крон-корни** `cron.real-poll`/`cron.keep-alive`/`cron.sweep` — иначе их
    pg/redis/http-спаны экспортируются сиротами без родителя.
  - Bank-fetch HTTP (`$fetch` к Альфе) и bank-OAuth POST ловит **авто-undici** — дочерние спаны под `bank-fetch`-root.
  - `withSpan('http.<route>', …)` / `withFrameRouteSpan(...)` — **все фрейм-токен HTTP-роуты** (порт #220/#221):
    роуты настроек (`chat-settings.get/post`, `settings.get/post`) + через общий хелпер `server/utils/frameRouteSpan.ts`
    остальные — `chat-search`, `app-rating.get/post`, `feedback.post`, `import.post`, `poll-now.post`,
    `import/{status,metrics,metrics-reset}`, `bank/connect` и `distribution/{ledger,provision,recompute}` (у последних
    — внешний `http.<route>`-спан поверх внутреннего бизнес-спана `ledger-read`/`provision-sp`/`ledger-recompute`)
    (`{http.method, http.op, http.outcome, portal.hash}`). `http.outcome` — PII-safe enum из `httpOutcomeForStatus(status)`
    (`ok/no_auth/forbidden/bad_request/conflict/throttled/unavailable/upstream_error/error`); тело запроса/ответа
    (настройки/чаты/выписка/отзыв/URL авторизации банка) в спан не попадает. `feedback.get` (публичный булев, нет
    домена) не оборачивается; публичный вебхук `b24/events` — на очередном спане.
    Клиентский pull-канал синка настроек (`useSettingsSync`, #219) телеметрией **не** покрыт (браузер, best-effort no-op).
- **Приватность (docs/PRIVACY.md) — тройная защита финансовых ПДн:**
  1. наши спаны эмитят **только allowlist** безопасных ключей (`server/utils/telemetryAttributes.ts`
     `pickSafeAttributes`) — назначение/контрагент/счёт/сумму прикрепить физически нельзя;
  2. **redaction-SpanProcessor** в бутстрапе срезает чувствительные атрибуты авто-инструментирования
     (`db.statement`, `*.url`/`*.query`, `*body*`/`*token*`/`*secret*`/…) до экспорта; `pg` — с
     `enhancedDatabaseReporting:false` (значения параметров не собираются);
  3. member_id идёт как **необратимый `portal.hash`** (SHA-256/12), не сам id; `error_kind` — токен из
     `code`/`name`, **не** текст ошибки.
  Ядра чисты и покрыты тестами (`tests/telemetryAttributes.test.ts`, `tests/telemetrySpan.test.ts`);
  drift между inline-списком бутстрапа и каноническим TS-списком ловит parity-тест.

### Env (Слайс 1)

| Переменная | Назначение |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | **База** OTLP-эндпоинта коллектора (напр. `http://otel-collector:4318`, **без** `/v1/traces`). **Не задан ⇒ телеметрия выключена**. ⚠ Экспортёр сам добавляет `/v1/traces`/`/v1/metrics` к общему эндпоинту — указывать базу, иначе путь удвоится |
| `TELEMETRY_ENABLED` | `0` — принудительно выключить даже при заданном эндпоинте (дефолт вкл, если эндпоинт есть) |
| `OTEL_EXPORTER_OTLP_HEADERS` | Заголовки OTLP (напр. `Authorization=Bearer <token>`) — для bearer-auth коллектора |
| `OTEL_SERVICE_NAME` | Имя сервиса в трейсах (дефолт `client-bank-alfa-by-backend`) |
| `OTEL_SERVICE_VERSION` | Версия сервиса (дефолт — `NUXT_PUBLIC_COMMIT_SHA`) |

## Слайс 2 — общая станция (коллектор + ClickHouse + Grafana) ✅

Приёмная сторона по образцу `b24-ai-starter-otel` — **отдельный общий сервис** (свой
`docker-compose`), а не профиль внутри приложения: под цель «много приложений в одной Grafana»
станция стоит один раз, а все приложения (это + до N других) шлют в неё по адресу и различаются
по `service.name`. Живёт в [`telemetry-station/`](../telemetry-station/README.md) (самодостаточно,
выносится в свой репозиторий):
- `otel-collector-contrib` — OTLP `:4318`/`:4317` с **bearer-auth**, batch, `transform`-процессор
  (второй барьер PII: срезает `db.statement`/URL/…);
- **ClickHouse** — хранилище, TTL 72ч (`create_schema:true`, схему создаёт коллектор);
- **Grafana** `:3001` — провижининг datasource (ClickHouse-плагин) + стартовый дашборд
  «Apps — Overview» (спаны/ошибки/p95-латентность/топ-ошибок, фильтр по `service.name`).
- **Переносимый Node-клиент** — [`telemetry-station/clients/node/`](../telemetry-station/clients/node/README.md):
  копируешь бутстрап + ставишь deps + 2 переменные окружения → приложение в дашбордах.

Подключить это приложение: задать `OTEL_EXPORTER_OTLP_ENDPOINT` (база станции, без `/v1/traces`),
`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <токен>`. Бутстрап у него уже
есть (слайс 1). **Живой прогон станции — за владельцем на сервере** (отдельный деплой, в CI не гоняется).

## Чем это дополняет «лёгкую» наблюдаемость

Не заменяет: снапшот-счётчики `GET /api/queues` / `/api/ops/queues`, страница-монитор `/queues`
(ECharts), `/api/health` (liveness), `/api/ready` (readiness), пожизненные счётчики портала
(`metrics_counter`) — остаются. OTel добавляет **историю, трейсы «где падает/тормозит по порталам» и
метрики латентности REST/джоб**, чего снапшоты не дают.
