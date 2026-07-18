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

## Слайс 2 — коллектор + хранилище + Grafana (infra-side) — дальше

Приёмная сторона по образцу `b24-ai-starter-otel`, но **как opt-in `--profile telemetry`** в
`docker-compose.prod.yml` (чтобы не грузить дефолтный однодерверный деплой):
`otel-collector-contrib` (OTLP 4317/4318, bearer-auth, batch, PII-фильтр «поясом») →
**ClickHouse** (TTL 72ч) → **Grafana** (datasource + дашборды backlog/throughput/failed/REST-latency +
алерты на рост очереди/failed-set). За операторской аутентификацией/внутренней сетью, наружу не смотрит.
До этого слайса можно нацелить `OTEL_EXPORTER_OTLP_ENDPOINT` на любой внешний OTLP-приёмник — код
приложения не меняется.

## Чем это дополняет «лёгкую» наблюдаемость

Не заменяет: снапшот-счётчики `GET /api/queues` / `/api/ops/queues`, страница-монитор `/queues`
(ECharts), `/api/health` (liveness), `/api/ready` (readiness), пожизненные счётчики портала
(`metrics_counter`) — остаются. OTel добавляет **историю, трейсы «где падает/тормозит по порталам» и
метрики латентности REST/джоб**, чего снапшоты не дают.
