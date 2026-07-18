# Наблюдаемость: OpenTelemetry (#78)

> Last reviewed: 2026-07-18

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
- **Ручные спаны** (`@opentelemetry/api`, no-op когда SDK не зарегистрирован):
  - `withDependencySpan()` — оборачивает **каждый B24 REST-вызов** (`makeSdkRestCall`) в спан
    `dep bitrix24 <method>` со `{system, operation, method, scope, status, error_kind, portal.hash}`;
  - `withSpan('crm-sync', …)` — **job-спан конвейера** с исходами `{op_count, recognized, resolved,
    allocated, ambiguous, manual, distributed, outcome, portal.hash}`.
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
