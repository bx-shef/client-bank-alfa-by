# Переносимый OTel-клиент для Node/Nitro приложения

> Last reviewed: 2026-07-18

Как подключить **любое** Node/Nitro-приложение к общей станции телеметрии (#78) — авто-спаны
(http/pg/ioredis) за 3 шага. Ручные спаны (по своим операциям) — опционально, см. ниже.

> **Источник истины — корневой `otel.instrument.mjs` в репо приложения импорта выписок.** Этот
> файл — его переносимая копия (отличается только дефолтным `OTEL_SERVICE_NAME`). При правке
> бутстрапа (новый redact-ключ, опция инструментации) — синхронизировать обе копии.

## 3 шага

1. **Скопируй два файла** (`otel.instrument.mjs`, `package.json`) в приложение — **в одну папку**
   (напр. `otel/`), чтобы deps и бутстрап лежали рядом.
2. **Поставь зависимости** этого `package.json` в образ/окружение приложения — **вне бандла**
   (иначе бандлер ломает require-хуки OTel) и **рядом с бутстрапом** (Node ищет deps, поднимаясь
   вверх от файла бутстрапа — `node_modules` должен быть в его каталоге или выше). В Docker:
   ```dockerfile
   COPY otel/ /otel/
   RUN cd /otel && npm install --omit=dev && npm cache clean --force
   ENV NODE_OPTIONS="--import /otel/otel.instrument.mjs"
   ```
   (deps окажутся в `/otel/node_modules` — рядом с `/otel/otel.instrument.mjs`, так они
   разрешатся. `--import` грузит бутстрап **до** старта приложения, чтобы авто-инструментирование
   успело перехватить http/pg/ioredis. Значение `NODE_OPTIONS` **обязательно в кавычках** —
   без них Docker спотыкается о пробел в `--import <path>`.)
3. **Задай три переменные окружения** — и приложение появится в Grafana:
   ```
   OTEL_EXPORTER_OTLP_ENDPOINT = http://<хост-станции>:4318   # БАЗА, без /v1/traces
   OTEL_SERVICE_NAME           = имя-приложения               # как подписать в Grafana
   OTEL_EXPORTER_OTLP_HEADERS  = Authorization=Bearer <OTEL_COLLECTOR_AUTH_TOKEN>
   ```
   Без `OTEL_EXPORTER_OTLP_ENDPOINT` бутстрап **ничего не поднимает** — приложение работает как раньше.

Готово: в Grafana → дашборд «Apps — Overview» → выбери свой сервис в списке «Сервис».

## Приватность

Тот же тройной барьер, что и в основном приложении: redaction-SpanProcessor срезает
чувствительные атрибуты авто-инструментирования (SQL/URL/токены/тела), `pg` — с
`enhancedDatabaseReporting:false`. ⚠ Держи SQL **параметризованным** (имя pg-спана не
редактируется). Не клади в спаны свои ПДн — если добавляешь **ручные** спаны, эмить только
безопасные «форма/счётчики/статус», не содержимое.

## Ручные спаны (опционально)

Авто-инструментирование уже даёт спаны http/pg/redis. Если нужны спаны по своим операциям —
подключи `@opentelemetry/api` (он no-op, пока телеметрия выключена) и оборачивай:
```js
import { trace, SpanStatusCode } from '@opentelemetry/api'
const tracer = trace.getTracer('<app>')
const span = tracer.startSpan('моя-операция')
try { /* ... */ } catch (e) { span.setStatus({ code: SpanStatusCode.ERROR }); throw e }
finally { span.end() }
```
(В основном приложении есть готовые обёртки `withDependencySpan`/`withSpan` с PII-allowlist —
`server/utils/telemetrySpan.ts` — переносимы при желании.)
