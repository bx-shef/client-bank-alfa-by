# Reporting Kit — отчётность и работа с агентом

> Last reviewed: 2026-06-29

Переносимый набор (kit) для работы с AI-агентом и отчётности проекта в Telegram:
навыки-отчёты (`/report-status`, `/report-digest`, `/report-questions`), безопасная
отправка в Telegram, типовые сценарии review/merge, проверки и собственный CI. Сам
бандл лежит в репозитории — [`../reporting-kit/`](../reporting-kit/) (этот документ —
указатель и карточка интеграции; быстрый старт и детали — в
[README кита](../reporting-kit/README.md)).

## TL;DR

- **Что это:** самодостаточный шаблон в `reporting-kit/` — три навыка-отчёта + скрипт
  отправки в Telegram + проверки + собственный CI.
- **Навыки только готовят текст** отчёта; отправляет `reporting-kit/scripts/tg-send.sh`
  и только по явной команде «шли». Все отчёты идут в один канал (`TG_CHAT_ID`).
- **Канон промптов — `reporting-kit/docs/reports/`**, навыки `.claude/skills/*/SKILL.md` —
  их зеркало; идентичность проверяет `check-skills`.
- **Как лежит у нас:** вендорный бандл — держим как есть для синхронизации с источником
  (`ai-agent`). **Не линтуется** нашими проверками: исключён из ESLint (`eslint.config.mjs`)
  и `.dockerignore`. У него свои конвенции и собственный CI внутри `reporting-kit/.github/`,
  который GitHub **не запускает** (активны только workflow в корневом `.github/`).
- **`project-map.md` — шаблон:** карту проекта (репозитории, дорожную карту, этапы)
  под client-bank-alfa-by нужно заполнить перед первыми осмысленными отчётами.
- **Telegram пока не заведён.** Бот/канал не созданы, `.env` не заполнен — отчёты можно
  генерировать навыками, но отправка (`tg-send.sh`) включится после настройки токенов.

## Состав (кратко)

| Путь | Назначение |
|---|---|
| [`reporting-kit/CLAUDE.md`](../reporting-kit/CLAUDE.md) | Правила репозитория + типовые сценарии review и merge |
| `reporting-kit/docs/project-map.md` | Шаблон карты проекта (заполнить под client-bank; источник для отчётов) |
| `reporting-kit/docs/reports/*` | Канон промптов отчётов (эталон, зеркалится в навыки) |
| `reporting-kit/.claude/skills/`, `.claude/commands/` | `/report-status`, `/report-digest`, `/report-questions` |
| `reporting-kit/scripts/tg-send.sh` | Отправка текста в Telegram (отказывает без токена/`chat_id`) |
| `reporting-kit/scripts/check-*.{sh,ps1}` | Проверки kit (Linux + Windows) |
| `reporting-kit/.github/` | Собственный CI бандла + оффлайн-проверка ссылок |

Полная таблица и быстрый старт — в [README кита](../reporting-kit/README.md).

## Навыки и отчёты

| Навык | Команда | Что делает |
|---|---|---|
| report-status | `/report-status` | срез состояния проекта по `project-map.md` |
| report-digest | `/report-digest` | дайджест по репозиториям за период (кратко + подробно) |
| report-questions | `/report-questions` | вопросник заказчику по открытым пунктам карты |

## Проверки бандла

Свои self-checks запускаются **из корня бандла** (относительные пути внутри):

```bash
cd reporting-kit
bash scripts/check-skills.sh   # навыки == канон docs/reports
bash scripts/check-docs.sh     # ссылки/маркеры/эмодзи в документах кита
bash scripts/check-tg.sh       # поведение tg-send.sh (моки curl)
```

При заносе в этот репозиторий все три — зелёные.

## Безопасность

> [!CAUTION]
> **Токен Telegram-бота — секрет.** `.env` хранится только локально (`chmod 600`),
> в репозиторий не коммитится (`.gitignore` кита). В CI/облаке — переменные
> окружения, не файл. `tg-send.sh` уводит токен из argv через `curl --config`
> (не виден в `ps aux`), но запускать всё равно на доверенном хосте.

## Связанное

- [README кита](../reporting-kit/README.md) — быстрый старт, переменные, навыки.
- [Визуальная верификация](./VISUAL_VERIFICATION.md) — Definition of Done для UI-задач.
