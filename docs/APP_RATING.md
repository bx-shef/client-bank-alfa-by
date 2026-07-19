# Оценка приложения в Маркете («оцените приложение»)

> Last reviewed: 2026-07-19

Ненавязчивый попап, который просит сотрудника оценить приложение в Маркете Bitrix24
**после того, как он получил пользу** — здесь: после успешной записи выписки в CRM
(`StatementUpload` → «Записать в CRM»). Механика портирована из соседнего
`bx-shef/ai-price-import` (PR #199 попап + серверный троттлинг, PR #204 управление из UI
оператора); домен свой (импорт выписки, не «прайс»), тексты/код листинга Маркета — свои.

## Почему решение показа — на сервере

Показывать попап «раз в несколько дней, но не на каждом открытии» и «замолкать, пока
владелец не проверит отзыв» — это **состояние**, а не разовое клиентское событие. Поэтому
решение живёт **рядом с авторизацией** (таблица `portal_app_rating`, ключ `member_id`, как
`portal_tokens`), а не в `localStorage` браузера сотрудника (который сбрасывается и не
скоуплен на портал).

## Состояние и правила

Таблица `portal_app_rating` (`server/db/client.ts`): `prompted_at` / `opened_at` /
`reviewed`. Чистое ядро решения — `server/utils/appRatingPolicy.ts` `shouldPrompt`:

- `reviewed === true` → **никогда** больше не показываем (отзыв подтверждён вручную);
- `opened_at` задан → сотрудник нажал «Оценить»; молчим, пока владелец **вручную** не
  проверит, появился ли отзыв. Если через ~`RATING_REPROMPT_DAYS` (4 дня) отзыва нет —
  владелец сбрасывает флаг, и попап возвращается;
- иначе → показываем, но **не чаще** одного раза в `RATING_REPROMPT_DAYS` (троттл по
  `prompted_at`).

## Роуты

**Фрейм-токен** (`Bearer` + `X-B24-Domain`, `member_id` из проверенного домена — модель
как у `/api/import/status`; чистое ядро `server/utils/appRatingHandler.ts`, DI + тесты):

- `GET /api/app-rating` → `{ show }` (side-effect-free; любой промах авторизации → `show:false`,
  без наггинга и без ошибки);
- `POST /api/app-rating { action: 'prompted' | 'opened' }` — фиксирует жизненный цикл.

**Сессия оператора** (`cba_sess`; POST также требует CSRF-заголовок `X-CBA-Auth` — как
`/api/auth/logout`) — управление из `/queues`:

- `GET /api/ops/app-rating` → `{ portals }` (только не-секретные поля: домен + метки времени;
  `server/utils/appRatingStatus.ts` `buildRatingStatuses`);
- `POST /api/ops/app-rating { memberId, action: 'reviewed' | 'reset' }`
  (`server/utils/appRatingOpsHandler.ts`): `reviewed` — подтверждённый отзыв (терминально);
  `reset` — сбросить `opened/prompted`, чтобы попап показался снова.

## UI

- `app/components/AppRatingModal.vue` (на `B24Modal`) + `app/composables/useAppRating.ts` —
  попап и клиент. Инертны вне портала (нет фрейм-токена) и при пустом коде листинга. По
  «Оценить» открывают детальную страницу Маркета через `frame.slider.openPath`
  (`marketDetailPath` в `app/config/b24.ts`, код по умолчанию — `LANDING_MARKET_CODE`
  `shef.bankimport`; override — `NUXT_PUBLIC_B24_MARKET_CODE`).
- Триггер показа — успешная запись в CRM в `StatementUpload.vue` (`ratingTrigger`).
- Карточка «Оценки приложения» на `/queues` (`app/composables/useAppRatingOps.ts`) — владелец
  ведёт жизненный цикл кнопками, а не SQL.
- Подсказка-гифка `public/app-rating-demo.gif` (ленивая загрузка, generic-UI оценки в Маркете).

## Очистка

Удаление приложения (`ONAPPUNINSTALL`) чистит `portal_app_rating`
(`deleteRatingForPortal`, в `deletePortal` воркера рядом с остальными сторами).
