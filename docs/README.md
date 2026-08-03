# Указатель документации

> Last reviewed: 2026-08-03

Что где лежит и когда это читать. Документов много, и без такой таблицы половина из них
недостижима: раньше на `APP_RATING.md`, `DEPENDABOT.md`, `REPORTING_KIT.md` и
`MARKETPLACE_SUBMISSION_CHECKLIST.md` вела единственная ссылка из глубины `CLAUDE.md`.

## С чего начинать

| Документ | О чём | Когда читать |
|---|---|---|
| [`../README.md`](../README.md) | что за продукт, быстрый старт | первым |
| [`../CLAUDE.md`](../CLAUDE.md) | карта модулей и обязательные конвенции | перед первой правкой кода |
| [`ONBOARDING.md`](ONBOARDING.md) | маршрут чтения кода, что можно потрогать без портала, словарь терминов | если проект видите впервые |
| [`project-map.md`](project-map.md) | срез состояния: сделано / дальше / блокеры | «что сейчас происходит» |
| [`REFACTOR_PLAN.md`](REFACTOR_PLAN.md) | целевая архитектура и что ещё не сделано | планирование |

## Как работает продукт

| Документ | О чём |
|---|---|
| [`PROCESSING.md`](PROCESSING.md) | **главный доменный документ**: подбор компании, распознавание номеров, разнесение оплат, ошибки |
| [`QUEUES.md`](QUEUES.md) | очереди BullMQ, воркеры, масштабирование, REST-бюджет |
| [`B24_EVENTS.md`](B24_EVENTS.md) | события портала (install/uninstall), токены, контракт вебхука |
| [`API_ROUTES.md`](API_ROUTES.md) | **наши** входящие роуты: авторизация, коды, троттлинг |
| [`REST_METHODS.md`](REST_METHODS.md) | учёт **исходящих** вызовов REST Bitrix24 — правится при добавлении метода |
| [`BACKEND_MAP.md`](BACKEND_MAP.md) | реестр серверных модулей разнесения + живые находки по полям REST |
| [`ALFA_API.md`](ALFA_API.md) · [`PRIOR_API.md`](PRIOR_API.md) | API банков, OAuth, живые находки |
| [`AUTH.md`](AUTH.md) | вход оператора в служебную зону (`/queues`) |
| [`APP_RATING.md`](APP_RATING.md) | попап «оцените приложение» в Маркете |
| [`FEEDBACK.md`](FEEDBACK.md) · [`FEEDBACK_TRIAGE_AGENT.md`](FEEDBACK_TRIAGE_AGENT.md) | сбор отзывов и их разбор в бэклог |

## Интерфейс

| Документ | О чём |
|---|---|
| [`PAGE_GUIDE.md`](PAGE_GUIDE.md) | как создавать страницы: лендинг vs in-portal, темы, b24ui, a11y |
| [`VISUAL_VERIFICATION.md`](VISUAL_VERIFICATION.md) | обязательная проверка пикселями после правок UI |
| [`DEMO_LANDING.md`](DEMO_LANDING.md) | демо «попробуйте на своей выписке» на лендинге |

## Эксплуатация

| Документ | О чём |
|---|---|
| [`DEPLOY.md`](DEPLOY.md) | развернуть с нуля и обновлять (основной путь: GHCR + Watchtower + nginx) |
| [`DEPLOY_VIBECODE.md`](DEPLOY_VIBECODE.md) | альтернативный таргет: Битрикс24 Вайбкод Black Hole |
| [`OPERATIONS.md`](OPERATIONS.md) | runbook: health, типовые аварии, откат, **бэкапы**, эскалация |
| [`OBSERVABILITY.md`](OBSERVABILITY.md) | телеметрия OpenTelemetry, что можно и нельзя класть в спаны |
| [`PRIVACY.md`](PRIVACY.md) | что храним, сколько и как чистим (финансовые ПДн) |
| [`REPO_SETUP_CHECKLIST.md`](REPO_SETUP_CHECKLIST.md) · [`DEPENDABOT.md`](DEPENDABOT.md) | защита `main`, CI, обновления зависимостей |

## Другие корни документации

| Где | О чём |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | короткий указатель для AI-агентов (ведёт в `CLAUDE.md`) |
| [`../telemetry-station/README.md`](../telemetry-station/README.md) | приёмная станция телеметрии (коллектор + ClickHouse + Grafana), разворачивается отдельным compose |
| `../reporting-kit/` | вендорный бандл отчётности со **своими** конвенциями и своим CI — нашими проверками не линтуется (карточка — [`REPORTING_KIT.md`](REPORTING_KIT.md)) |

## Продукт и продажи

| Документ | О чём |
|---|---|
| [`POSITIONING.md`](POSITIONING.md) | позиционирование, ICP, отстройка от конкурентов |
| [`MARKETPLACE_LISTING.md`](MARKETPLACE_LISTING.md) · [`MARKETPLACE_SUBMISSION_CHECKLIST.md`](MARKETPLACE_SUBMISSION_CHECKLIST.md) | карточка Маркета и чек-лист сабмита |
| [`MARKET_GRAPHICS.md`](MARKET_GRAPHICS.md) | тексты для **графики** карточки — задание внешнему дизайнеру |
| [`PRICING.md`](PRICING.md) · [`PARTNERS.md`](PARTNERS.md) | цена внедрения, работа с интеграторами |

## Журналы и служебное

| Документ | О чём |
|---|---|
| [`DEV_SCRIPTS.md`](DEV_SCRIPTS.md) | дев-скрипты: разведка банков, посев портала, живые прогоны (какие **пишут** в портал) |
| [`WORKLOG.md`](WORKLOG.md) | append-only журнал проходов (историю не переписываем) |
| [`IDEAS.md`](IDEAS.md) | идеи, к которым возвращаемся по спросу |
| [`REPORTING_KIT.md`](REPORTING_KIT.md) | вендорный бандл отчётности (свои конвенции, наш CI его не линтует) |

## Правила

- Каждый документ несёт `> Last reviewed: YYYY-MM-DD` строкой под заголовком; дату бампим при
  содержательной правке. Наличие штампа проверяет `tests/mdReviewStamp.test.ts`.
- Один факт — одно место. Если он нужен в двух документах, во втором ставится ссылка: расходятся
  именно продублированные утверждения, и заметить это можно только случайно.
