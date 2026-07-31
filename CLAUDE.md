# CLAUDE.md

> Last reviewed: 2026-07-31

Приложение Bitrix24 для импорта выписки из клиент-банка: онлайн из Альфа-Банка
Беларусь (портал может быть в любой стране) или ручной загрузкой любой стандартной
выписки. Публичная страница — лендинг (SSG). Появилась серверная часть (Nitro):
эндпоинт вебхуков Bitrix24 (`/api/b24/events`) + хранилище токенов портала.

> **Статус:** рефакторинг legacy-приложения (план — [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md)).
> Репозиторий: **frontend** (публичный лендинг SSG + B24-iframe-UI) **и backend** (Nitro-сервис:
> приём событий установки/удаления Б24, учёт авторизации портала; дальше — OAuth Альфы, опрос,
> запись дел/чата). Заложено доменное ядро (типы выписки, абстракция банк-провайдеров, чистые
> утилиты, билдер дела, разбор/маршрутизация событий Б24) и демо-страница на mock-данных; backend
> событий Б24 реализован (этап 3, слайс), реальная интеграция Альфы — далее. **Целевая спецификация
> обработки платежей** (подбор компании/инвойса/сделки, распределение, оповещения, ошибки) —
> [`docs/PROCESSING.md`](docs/PROCESSING.md); **указатель всех документов** —
> [`docs/README.md`](docs/README.md). Деплой: статика лендинга за nginx + отдельный
> backend-сервис с Postgres (как `bx-synapse`). Эталон стека — `currency-converter`.

## Стек

- **Nuxt 4** (статическая генерация, `nuxt generate`)
- **Vue 3** — `<script setup lang="ts">`
- **TypeScript** (строгий), **Tailwind CSS v4**, **Bitrix24 UI** (`b24ui`) —
  первоисточник по «как правильно» на b24ui: официальные AI-ресурсы
  [`bitrix24/b24ui/AGENTS.md`](https://github.com/bitrix24/b24ui/blob/main/AGENTS.md)
  (семантические цвет-токены, `useComponentProps()`, чек-лист компонента),
  [`bitrix24/b24ui/skills/`](https://github.com/bitrix24/b24ui/tree/main/skills) и
  [`llms.txt`](https://bitrix24.github.io/b24ui/llms.txt) (LLM-индекс компонентов/composables/тем);
  наш [`docs/PAGE_GUIDE.md`](docs/PAGE_GUIDE.md) — как это ложится на приложение.
- **Bitrix24 JS SDK** (`@bitrix24/b24jssdk` + `-nuxt`) — встройка в портал (dual-mode, `/install`);
  первоисточник по SDK — [`llms.txt`](https://bitrix24.github.io/b24jssdk/llms.txt) (LLM-индекс:
  `B24Frame`, `callV2/callBatch`, `fetchList`, вебхуки/OAuth, примеры). Точные REST-сигнатуры — MCP `b24-dev-mcp`.
- **Vitest** — два проекта: `unit` (node, чистые функции) и `nuxt`
  (`@nuxt/test-utils` + happy-dom, composables и компоненты)

## Команды

```bash
pnpm dev          # дев-сервер
pnpm lint         # ESLint
pnpm typecheck    # vue-tsc --noEmit (app) + vue-tsc -p .nuxt/tsconfig.server.json (server/**)
pnpm test         # Vitest (оба проекта; быстрый прогон node: pnpm test --project unit)
pnpm generate     # сборка статики (nuxt generate, SSG) — то же гоняет CI
```

Перед пушем прогоняй `pnpm check` (= `lint` + `typecheck` + `test`) или запусти
готовый скрипт `bash scripts/check-app.sh` — он сразу отдаёт итог. Те же проверки
гоняет CI (порядок шагов не важен — они независимы).

## Архитектура

- `app/app.vue` — **корень Nuxt** (не страница): `useHead`/SEO (вкл. `og:image`/`twitter:card` →
  `public/og.png`, абсолютный URL из `siteUrl` в проде)/`theme-init`, рендерит `<NuxtLayout>`/`<NuxtPage>`.
- `app/app.config.ts` — нативный colorMode b24ui (`colorMode: true`, `colorModeInitialValue: 'auto'`);
  без этих top-level ключей `useColorMode()` = no-op stub.
- `app/assets/css/main.css` — Tailwind v4 + импорт темы b24ui.
- **Как создавать новые страницы в нужном виде** (лендинг vs in-portal, темы, анимация, форма, a11y,
  процесс) — [`docs/PAGE_GUIDE.md`](docs/PAGE_GUIDE.md). Родственный дизайн-гайд основного сайта — в репо
  `bx-shef/Lp` (`docs/LANDING_GUIDE.md`).
- `app/pages/index.vue` — публичный лендинг (маркетинговый, по issue #110): hero+CTA (фото+граф+
  `PartnerBadge`), боль→результат, «Как это работает» (3 шага), **демо `#demo` (`LandingDemo`)**,
  «Почему мы» (6 карточек, glow), блок интеграторам, форма заявки (`BriefForm`), `MobileBriefCta`.
  Тексты — из `app/utils/landing.ts`. CTA скроллит к `#brief`, вторичная кнопка hero — к `#demo`; цели
  Метрики через `useMetrikaGoal`; glow за курсором — `useCardGlow`.
- `app/pages/partners.vue` — **публичная страница «Интеграторам»** (layout `landing`, в
  `nitro.prerender.routes`): условия субподряда для интеграторов Bitrix24 — модель работы, лестница
  вознаграждения, деление зон ответственности. Тексты и данные — в чистом `app/utils/partners.ts`
  (`PARTNERS_TITLE`/`PARTNERS_MODEL`/`PARTNERS_LADDER`/`PARTNERS_SPLIT`), развёрнутая версия для
  переговоров — [`docs/PARTNERS.md`](docs/PARTNERS.md). ⚠ Публичных страниц ДВЕ (`/` и `/partners`) —
  новая страница обязана попасть в `nitro.prerender.routes`, иначе на статике отдаст 404.
- `app/components/LandingDemo.vue` + чистое ядро `app/utils/demoExtract.ts` (карта — [`docs/DEMO_LANDING.md`](docs/DEMO_LANDING.md))
  — **демо на лендинге «Попробуйте на своей выписке»**: прикрепить файл выписки → **разбор в браузере**
  (windows-1251, через готовое `importUpload.ts`: `processUploadBatch`/`dedupItems`/`deferToEventLoop`) →
  панель извлечения (операции, контрагенты, суммы **по валютам** — округление в чистом слое, распознанные
  **по матрицам** номера счетов/заказов через реальный `recognizeByMatrices`). **Онлайн-подключение**
  к Альфе/Приору показано **яркими инфо-карточками** (`LANDING_BANK_CONNECT` в `landing.ts`, рендер в
  `index.vue` над `LandingDemo`) — интерактивные кнопки-«песочницы» пока не подключены к UI (sample-функции
  `demoAlfaExtraction`/`demoPriorExtraction` в `demoExtract.ts` под юнит-тестами как доказательство
  нормализаторов; переподключение демо-песочницы — в плане, геоблок-ограничения нет — лендинг банк-креды
  не держит, живой OAuth предусмотрен на backend/из портала (транспорт `bankFetch.ts` собран + юнит-тесты,
  A5 — Альфа GET; **подключён к воркеру (A9)**; **реестр счетов (A6) + крон-таймер (A10) + connect-поток с
  UI (A7) + глобальный rate-limiter (A8) готовы** — вся машинерия опроса собрана, таймер default-OFF
  (`CRON_REAL_POLL`, инертен пока нет банк-кредов владельца); **Приор (A5b) — движок опроса, connect-поток и АВТООПРОС
  готовы**: `prior-by` в `POLLABLE_PROVIDERS`, у него своя очередь `bank-fetch-prior` с бюджетом в
  ЗАПРОСАХ (задача Приора = до 10 HTTP, `REQUESTS_PER_ACCOUNT`) и своими слотами, поэтому он не
  блокирует Альфу и не тратит её лимит; прод дополнительно требует BY-СКЗИ (issue #41), sandbox `:9344` — нет).
  В демо — **скачиваемые примеры выписок** (`LANDING_DEMO_SAMPLES`, файлы `public/samples/*.txt`,
  синтетика): чип загружает пример в один клик (`loadSample`: fetch→File→`runFiles`) + ссылка «скачать».
  Интерактивные контролы — **b24ui** (`B24Button`: «Выбрать файл»/«Сбросить»/чипы примеров, air-цвета
  под тёмную оболочку, как в hero и `StatementUpload`); скрытый нативный `<input type=file>` триггерится
  кнопкой (тот же паттерн, что на `/import`). Результаты (список операций/сводка) — свой тёмный рендер
  (не тащим b24ui-`OperationList`, чтобы не смешивать light/dark-токены с брендовой оболочкой). Подводка/
  тексты ошибок — `LANDING_DEMO` в
  `landing.ts`, интерактивные подписи (кнопки, метки сводки, `KIND_LABEL`) пока в компоненте (черновик,
  дошлифуется). Гонку источников снимает токен `runSeq` (медленный разбор не затирает позже выбранный
  источник), рендер операций и распознанных строк капнут (`MAX_RENDERED_OPS`). Тесты —
  `tests/demoExtract.test.ts` (ядро на реальных нормализаторах) +
  `tests/nuxt/landingDemo.nuxt.test.ts` (рендер/проводка). **Follow-up:** маскировка блока результатов в
  вебвизоре Метрики (приватность реальных выписок) — см. `DEMO_LANDING.md`.
- **Визуальная оболочка лендинга портирована с `offer.bx-shef.by` (репо `bx-shef/Lp`)** —
  тёмная брендовая тема (vibecode-палитра, #030022 + радиальное сияние, self-hosted шрифты Rubik/
  Roboto Mono). Живёт в отдельном **layout `landing`** (`app/layouts/landing.vue`: `B24Header` с
  `AppLogo`+навигацией, `B24Footer` с `SiteFooter`+GitHub, `BusinessCardModal`), который вешается
  только на `/` (`definePageMeta({ layout: 'landing' })`) — **in-portal страницы (`/app`,`/import`,
  `/install`,`/login`,`/queues`) не трогает**, у них своя light/dark-auto тема. Dark форсится только для лендинга
  через `htmlAttrs data-force-dark` (учитывает `theme-init` в `app.vue`) + класс `.landing-shell` в
  `main.css` (фон/токены скоуплены на этот класс). `HeroGraph.vue` — canvas-анимация фона hero:
  внешние узлы (банки/выписка/CRM-сущности) шлют **импульсы в центральный хаб Bitrix24** (спицы +
  бегущие точки с хвостом + кольца-волны на приходе); хаб пришпилен к центру тяжести, внешние узлы —
  лёгкая физика (гравитация к хабу, взаимное отталкивание, репеллер зоны фото). Уважает
  `prefers-reduced-motion` (статичный кадр), пауза вне видимости/при скрытой вкладке, троттлинг 30fps.
- `app/components/BusinessCardModal.vue` — визитка (тёмная, vibecode): фото, **QR (десктоп + мобильный
  hold-to-reveal «отпечаток»)**, контакты, «Назначить созвон» (`booking.ts`) + копия ссылки
  (`clipboard.ts`), vCard (`buildVCard` из `app/utils/vcard.ts`), «Реквизиты» — внешней ссылкой.
  `app/composables/useMetrikaGoal.ts` — обёртка `ym reachGoal` (no-op без Метрики).
- `app/components/BriefForm.vue` — встроенная CRM-форма Bitrix24. Форма живёт в отдельном
  same-origin документе `public/b24-form.html` (iframe), который nginx отдаёт со **своим**
  form-scoped CSP (`location = /b24-form.html`) — официальный B24-загрузчик (inline + cdn-скрипт)
  работает, а строгий CSP страницы не ослабляется. URL iframe строит чистый `app/utils/b24Form.ts`
  (`buildB24FormSrc` — allowlist хостов Б24 + валидация id/secret, тесты); пустой конфиг ⇒ слот-плейсхолдер.
  Событие `b24:form:submit` iframe ретранслирует через `postMessage` → цель Метрики `brief_submit`.
  Контейнер тёмный (под брендовую оболочку лендинга); `app/utils/booking.ts` — общая ссылка онлайн-записи Б24.
- `app/pages/app.vue` — in-portal просмотр выписки на **b24ui** (по образцу B24-списка «Последние
  операции»): полоса статуса (`ImportStatusBanner`), над списком — `ImportStatsChart` (результат импорта,
  заголовок «Сводка по операциям», #62), карточка «Последние операции» с чип-фильтром
  Все/Приходы/Расходы (счётчики в подписи), шапкой колонок «Операция/Сумма», `OperationList` и
  `B24Pagination` (при переполнении страницы). Шестерёнка открывает **слайдовер настроек снизу**
  (`B24Slideover` `side="bottom"` с `SettingsForm` — удобно в узком iframe/на мобильном; форма отдаёт
  `@close` по Save/Cancel → слайдовер закрывается, `#219`) — основной вход. **`SettingsForm` несёт
  «Подключение банка» первой секцией** (`BankConnectCard` + `PollNowButton`), поэтому админ включает
  онлайн-импорт прямо из портала (раньше карточка жила только на отдельной странице, до которой из
  UI не было ссылки). Отдельной страницы настроек больше нет — слайдовер единственный вход.
  **Без демо-данных** — список операций реальный (пока пуст, до backend-фида #5). **Баннер «не
  настроено»** (критерий — выбран **чат уведомлений**, `chatSettings.settings.chat.dialogId` непустой):
  внутри портала при отсутствии настройки админу (`useIsAdmin`) — предупреждение + кнопка «Открыть
  настройки», не-админу — инфо-баннер «администратор настраивает»; операции/сводка скрыты, пока не
  настроено. Тестовая настройка `app.option` (skeleton) **удалена**. Layout `clear`, `useB24().init()`,
  в портале — `setTitle`/`fitWindow` (try/catch). Итоги приходов/расходов несёт карточка `ImportStatsChart`
  над списком (показывается только при наличии операций). Интерактив (раскрытие строки, слайдер настроек,
  баннер в портале) автотестами частично покрыт (рендер пустого вида через preview-обход гейта, `?preview=1`) — портал проверяется вручную.
- `app/components/SettingsForm.vue` — форма настроек чата (#16 PR-C): два пикера чатов на
  **`AsyncSearchSelect`** (чат уведомлений `chat.dialogId` + **чат ошибок** `errorChat.dialogId`,
  поиск через `/api/chat-search`), `B24Switch` приходы/расходы (**фильтр только чат-оповещения**, не записи),
  блок «Исключения» `B24Textarea` (счёт/подстрока назначения — **исключают операцию из CRM целиком**:
  `isExcludedOperation` в `statement.ts`, гейт первым в цикле `handleCrmSyncJob`, счётчик `excluded`, PROCESSING §2 A2)
  + живой предпросмотр («что попадёт в чат», `B24Badge`) + **`B24Switch` «Авто-проведение оплат»** (`autoDistribute`,
  §2 мутационный гейт: при ON — предупреждение `B24Alert`, что приложение будет писать в CRM, + поле `B24Input`
  «стадия оплаченного счёта» → `allocation.invoicePaidStageId` (пусто ⇒ стадию не трогаем) + поле `B24Input`
  **«код триггера автоматизации»** → `allocation.triggerCode` (#79; подсказка показывает канонический
  `B24_PAYMENT_TRIGGER.code`/`name` — что зарегистрировано на установке и как повесить на правило; пусто ⇒ триггер
  не фаерим); default OFF)
  + **`RecognitionMap` «карта сопоставления»** (#109 §4: матрицы распознавания + алфавит + `configFields`
  — форма вместо ручной правки `app.option` JSON; см. компонент ниже).
  Первый блок формы — **`SetupReadinessCard`** (экран готовности), под ним **`B24Accordion` из шести
  секций** (Подключение банка / Уведомления в чат / Смарт-процессы и распределение / Исключения /
  Авто-проведение / Карта распознавания; открыты **первые две** — свежей установке нужна первая,
  в ежедневной работе вторая), под ним — **явные Save/Cancel** (`#219`, порт из `ai-price-import`, паттерн
  `bitrix24/b24-ai-starter`; автосейв убран). Один компонент для двух точек входа: слайдовер на
  `/app` (проп `asSlider` → Save/Cancel эмитят `close`, панель закрывается; Cancel сперва перечитывает
  серверную копию — слайдовер делит тот же singleton `settings`, иначе несохранённые правки всплыли бы
  при повторном открытии); Cancel = откат к серверной копии. **Хранение —
  backend** (`app.option` через `useChatSettings`), сейв по кнопке (индикатор «Сохранено ✓» гаснет при
  первой же правке) + `notifyReload` соседним инстансам. ⚠ SDK-слайдер (`frame.slider.openPath`) для
  своей страницы приложения **не годится** (openPath открывает только портальные пути) — потому «слайдер»
  реализован нашим `B24Slideover`.
  **Гейт админа** (`useIsAdmin` → `$b24.auth.isAdmin`, default-closed до проверки): в портале не-админу —
  предупреждение вместо формы; вне фрейма — предпросмотр (persistence инертна).
- **«Цель не найдена» больше не молчит (#421):** номер в назначении распознан, компания найдена, а
  подходящей сущности в CRM нет (счёт удалён, опечатка в номере, документ в отменённой стадии) —
  раньше это проходило совершенно незаметно (сообщения в чат ошибок строились **только** внутри
  ветки «кандидаты есть»), дело записывалось без привязки, и расхождение всплывало лишь при сверке.
  Теперь случай считается (`unresolved` в сводке `crm-sync` **и** в пожизненных метриках) и уходит в
  чат ошибок: чистый билдер `buildUnresolvedMessage` (`allocationErrorMessage.ts`, BB-нейтрализация —
  номер это фрагмент назначения, то есть текст плательщика) + транспорт `notifyUnresolvedViaRest`.
  Отправка идёт **после** записи маркера, как и остальные сообщения в чат ошибок (у чата дедупа нет,
  иначе повторная доставка джобы переслала бы сообщение). ⚠ Считается **только** `status:'resolved'`:
  `unsupported` значит «вид не настроен», там в CRM никто ничего не искал — сообщать «подходящих
  счетов нет» было бы ложью. Счётчик растёт **всегда**, а сообщения ограничены
  `MAX_UNRESOLVED_NOTICES` на прогон: это состояние НАСТРОЙКИ, а не платежа (кривая маска даёт его на
  100% операций), и выписка на сотни строк залила бы чат, который заведён ради редких случаев.
  **Маска получила квантификатор `d+`** (`purposeMatch.ts`, #421): фиксированная длина описывает
  нумерацию, которой не бывает — нумерация Б24 растёт от `СЧ-1`, а голая `dddd` цепляет год и сумму.
- `app/components/RecognitionMap.vue` + чистый `app/utils/recognitionKinds.ts` — **UI «карты сопоставления»**
  (#109 §4): редактор распознавания платежей внутри `SettingsForm` (`B24Card`/`B24Select`/`B24Input`/`B24Button`/
  `B24Badge`). Привязан к `settings.recognition` через `defineModel` (вложенные мутации lint-чисты, автосейв — deep-watch
  родителя): **алфавит** (кир/лат гомоглифы), **динамический список матриц** (маска `d`=цифра+литералы → **вид сущности**
  `IdentifierKind` + note; добавить/удалить), **`configFields`** (`smart-entity` entityTypeId + `deal-field`/`smart-field`
  имена полей, delete-on-blank), **живой предпросмотр** «тестовое назначение → распознано» на реальном `recognizeByMatrices`.
  Заменяет ручную правку `app.option` JSON; сервер по-прежнему коэрсит/клампит (`parsePortalSettings`, DoS-капы) — форма
  это удобство, не источник доверия. `recognitionKinds.ts` — RU-лейблы **всех** `IdentifierKind` (exhaustive
  `Record<IdentifierKind,…>` + тест), `IDENTIFIER_KIND_ITEMS`/`ALPHABET_ITEMS`/`CONFIG_FIELD_ROWS`/`blankMatrix` +
  **`MATRIX_PRESETS`/`missingPresets`** (#421 — кнопка «Добавить типовые»: маски на квантификаторе
  `d+` (`СЧ-d+`/`d+/d+`/`ДОК-d+`), дедуп по маске, чтобы повторный клик не задваивал распознавание;
  номер БЕЗ префикса в пресеты не входит намеренно — такая маска цепляет год и сумму из назначения). Тесты —
  `recognitionKinds.test.ts` (exhaustive) + `nuxt/recognitionMap.nuxt.test.ts` (рендер/add-remove/предпросмотр); визуально
  проверен (свет/тёмная, в слайдовере настроек).
- `app/components/StatementUpload.vue` + `app/pages/import.vue` (роут `/import`, layout `clear`,
  в `nitro.prerender.routes`) — **UI ручной загрузки выписки (P4, слайс 1)**: drag-drop/`<input>`
  мульти-файл, парсинг **в браузере** (детерминированный, без backend/AI) через `importUpload` →
  статус по каждому файлу (разобрано N / ошибка) + объединённый предпросмотр через `OperationList`.
  Ссылка «Загрузить выписку» — в шапке `/app`. **Слайс 2 (запись в CRM) — сделан:** кнопка «Записать в
  CRM» шлёт **сам файл** на `POST /api/import` (`useImport`, фрейм-токен) → очередь `file-parse`→`crm-sync`;
  сервер — единственный авторитет разбора (парсит в воркере), браузерный разбор = только предпросмотр.
  Ответ — `202` («принято, N операций» из предпросмотра), дальше UI **опрашивает итог этой загрузки** (`GET /api/import/batch` по `batchId`=sha256 файла, `useImportBatches`) и показывает блок «Результат обработки» (#417); фон пишет дело по операции.
  Клиент не найден → **каскад «в мою компанию»** (#91): пишем дело в мою компанию (`findMyCompanyByAccount`)
  с блоком-причиной + чат ошибок; моя компания тоже не найдена → не пишем, чат ошибок. Элемент смарт-процесса — #109. Разбор
  покрыт тестами на реальных `tests/fixtures/*`; UI — render-тест + визуальная проверка (свет/тёмная).
- **Страницы `/settings` больше нет** (по требованию владельца): она дублировала ту же
  `SettingsForm`, а из портала на неё вела одна невнятная ссылка — админ не находил ни провижининг
  СП, ни распределение. Всё живёт в **слайдовере настроек на `/app`**: `ProvisionSpCard` +
  `DistributionTab` — секция «Смарт-процессы и распределение». Роут убран из `nitro.prerender.routes`,
  кнопка «Проверить настройки» в `ImportStatusBanner` теперь эмитит `openSettings` (страница
  открывает слайдовер), а не ведёт на удалённый маршрут.
- **UI-контур распределения (#109 §9.3 #4, admin-only, за feature-gate `DISTRIBUTION_PROVISION_ENABLED`):**
  `ProvisionSpCard` (кнопка «Настроить смарт-процессы» → `POST /api/distribution/provision`) +
  **`DistributionTab`** (`useDistributionLedger` → `GET /api/distribution/ledger`: карточки платежей
  `DistributionLedgerCard` на **b24ui** с суммой/«осталось»/badge overLimit+requiresRedistribution +
  строки распределения с `targetLabel`; денежная математика — чистый `presentPaymentLedger`
  (`app/utils/distributionView.ts`) над `distributionSummary`) + кнопка **«Пересчитать»**
  (`POST /api/distribution/recompute` — пересчёт «осталось» всех payment-элементов, single-flight;
  страховка §3/§9.2). Чтение/пересчёт — на сторедном OAuth-токене портала; чистые gate-хендлеры
  (`ledgerRequest`/`recomputeRequest`, DI+тесты) зеркалят `provisionRequest`. Визуально проверено.
- `app/pages/import.vue` — страница `/import` **ручной загрузки выписки** (P4, слайс 1): когда нет
  онлайн-подключения к банку — перетащить файл(ы), приложение разбирает их **в браузере**
  (детерминированно, без backend/AI) и показывает предпросмотр операций. Layout `clear` +
  `useB24().init()` (в портале `setTitle`/`fitWindow`). Вход — кнопка «Загрузить выписку» в шапке
  `/app`. Роут `/import` — в `nitro.prerender.routes`. UI — `StatementUpload.vue`; чистое ядро —
  `app/utils/importUpload.ts` (`validateUploadFile` — расширение+размер `MAX_UPLOAD_BYTES` 2 МБ,
  `decodeAndParse` — windows-1251 декод → `normalizeManualStatement`, `processUploadBatch` — усечение
  по `MAX_UPLOAD_FILES` + изоляция разбора каждого файла + `defer`-yield, `dedupItems` по `account|docId`).
  Компонент: дропзона, список результатов по файлам (успех — бейдж «разобрано: N», ошибка — переносимый
  текст), сводка, предпросмотр `OperationList`, `role=status aria-live`, кнопка **«Записать в CRM»**
  (`useImport` → `POST /api/import`, слайс 2 выше). Тесты — `tests/importUpload.test.ts` (реальные
  фикстуры) + `tests/nuxt/statementUpload.nuxt.test.ts` (рендер/проводка).
- `app/pages/install.vue` — обработчик установки B24 (layout `clear`): `init` → `event.bind`
  (`ONAPPINSTALL`/`ONAPPUNINSTALL` → `${siteUrl}/api/b24/events`, до `installFinish` — так текущая
  установка доставляет `application_token`) → **`crm.automation.trigger.add`** (регистрация канонического
  триггера приложения `B24_PAYMENT_TRIGGER`, #79 — best-effort, standalone не-батч) → `installFinish`
  (+ диагностика портала, блоки «События»/«Триггер автоматизации»); вне фрейма установка не запускается: `InPortalGate` показывает объяснение (#414), редиректа на лендинг больше нет.
  **Вердикт установки (#410, чистое ядро `app/utils/installVerdict.ts` + тесты):** «Готово» больше не
  равно «работает» — три исхода вместо двух: `failed` (не дошли до `installFinish`), `degraded`
  (установлено, но портал не выдал часть прав / не зарегистрировался триггер) и `ok`. Раньше
  недовыданные права рисовались бейджами внутри **свёрнутой** «Диагностики», то есть их никто не
  читал, и портал жил с молча выключенными функциями — именно так вскрылся #408 (нет `userfieldconfig`
  ⇒ провижининг СП отказывает). Теперь вердикт — алерт верхнего уровня с действием на каждую проблему,
  диагностика раскрывается сама. ⚠ Init-батч проверяется на `isSuccess`: если `scope` не прочитан,
  судить о правах нельзя (пустой список выглядел бы как «не выдано НИ ОДНОГО права» → громкий ложный
  вердикт на успешной установке). Вне фрейма вердикт не показывается — это демо-режим, а не провал.
  **Проверка серверной части (#413):** `ONAPPINSTALL` идёт **мимо iframe** — исходящим вебхуком
  портала на backend, и именно оно приносит токены. Не дошло ⇒ портал «установлен», а серверная
  часть о нём не знает: ни опроса, ни записи в CRM, и снаружи это выглядит полностью успешной
  установкой. После `installFinish` страница прощупывает `GET /api/setup-status`
  (`useBackendInstallCheck.ts`): 200/403 ⇒ портал известен, **409** ⇒ событие не дошло, 0/5xx ⇒
  backend недоступен. Чужой маршрут взят намеренно — он уже даёт нужный симптом, отдельный
  эндпоинт не нужен. ⚠ 409 **не равен строго** «событие не дошло»: тот же код бывает при
  несовпадении домена (алиас/self-hosted/смена адреса) и при подавленном тумбстоуном stale-register
  (#77) — поэтому вердикт по нему **мягкий** («пока не подтвердила», «обновите страницу через
  минуту»), а не приказ переустановить. Окно ожидания ~16с нарастающими паузами: токен пишет **не
  роут вебхука, а фоновый воркер** (событие → сетевой `verifyInstallMember` → очередь → воркер →
  INSERT), и на занятой очереди пара секунд легко истекает — короткое окно оболгало бы здоровую
  установку. Счастливый путь бесплатен (первый же 200 выходит сразу); `retry: 0`, иначе ofetch сам
  ретраит 409/5xx и удваивает запросы. Пока идёт проверка, вердикт **не показывается** (иначе
  мелькнул бы зелёный, схлопывающийся в жёлтый). Чистое отображение кода в состояние —
  `mapProbeStatus` (в `installVerdict.ts`, под тестами); не удалось определить ⇒ `unknown` ⇒ молчим. Билдер батча
  привязок — чистый `app/utils/b24EventBind.ts` (идемпотентен: пропуск верных, перепривязка устаревших); билдер
  регистрации триггера — чистый `app/utils/b24TriggerRegister.ts` (`buildTriggerRegisterCall`, маска CODE +
  непустое имя → `null` fail-safe; метод идемпотентен и требует контекста приложения, iframe его даёт; сбой
  установку не блокирует). Требует `NUXT_PUBLIC_SITE_URL` в проде (иначе откажется биндить относительный URL —
  ошибка с retry). `placement.bind` **пока не делаем** — плейсменты добиваем на тестовом портале (см. план).
- `app/layouts/clear.vue` — минимальный layout (`<B24App>` для тем/тостов, light/dark) под in-portal-страницы
  (`/install`, `/app`, `/import` в iframe) **и** standalone-страницы оператора (`/login`, `/queues`).
- `app/config/b24.ts` — чистые константы встройки: `B24_REQUIRED_SCOPES` (`crm`, `sale`, `im`,
  `documentgenerator`, **`userfieldconfig`** (#408 — провижининг СП зовёт `userfieldconfig.add`, а scope
  не запрашивался ⇒ на любом портале, где право не выдали руками, провижининг падал с опаковым
  «provisioning failed»; ⚠ ре-consent), `user_brief`, `placement`), `B24_EVENT_HANDLER_PATH` (`/api/b24/events`), `B24_BOUND_EVENTS` (события для `event.bind`),
  `B24_PAYMENT_TRIGGER` (`code`/`name` канонического триггера автоматизации «платёж получен», #79 — регистрируется
  на установке, его же указывают в `allocation.triggerCode`).
- `app/composables/useB24.ts` — обёртка над `B24Frame`: `init()` (идемпотентен; no-op вне фрейма —
  когда нет `window.name`), `isInit()`, `get()`/`getOrThrow()`, `targetOrigin()`, `getRequiredRights()`.
- `app/composables/useChatSettings.ts` — **синглтон** настроек чата (слайдовер настроек на `/app`; форма монтируется один раз, но переживает
  закрытие панели): `load()`/`save()` `PortalSettings` через `/api/chat-settings` по
  фрейм-токену + `chatFetcher` (транспорт для `AsyncSearchSelect`, ходит в `/api/chat-search`) +
  сид-метки выбранных чатов (кэш-`title` из настроек → недавние → id-фолбэк). Вне фрейма инертна
  (defaults, persistence — no-op). `AsyncSearchSelect` эмитит `update:selected-option` (выбранная
  строка) → форма кладёт имя в `ChatSettings.title`/`ChatTarget.title` (UI-подсказка, воркеру не нужна;
  переживает reload без лишнего REST). **Кросс-инстанс sync (порт #219 из `ai-price-import`, паттерн
  `bitrix24/b24-ai-starter`):** после успешного `save()` зовёт `useSettingsSync().notifyReload()`.
- `app/utils/settingsSync.ts` (чистое ядро, тесты) + `app/composables/useSettingsSync.ts` — **живая
  синхронизация настроек между открытыми инстансами**: `buildSettingsReloadEvent(moduleId)` собирает payload
  `pull.application.event.add` с COMMAND `reload.options`; `notifyReload()` шлёт его через фрейм после сейва,
  `subscribeReload(onReload)` подписывается на канал приложения (`B24PullClientManager`) и зовёт `onReload` при
  сейве в другом инстансе (`/app` подписан → `chatSettings.load()`). Обе стороны **best-effort,
  никогда не бросают**: pull-сервер портала может быть недоступен → тихий no-op (наши настройки всё равно
  автосейвятся, это лишь освежает **другие** открытые формы). `moduleId` = `b24MarketCode || LANDING_MARKET_CODE`.
  ⚠ Семантика pull-канала портало-специфична — проверить на живом портале.
- `app/composables/useIsAdmin.ts` — `check()` → `$b24.auth.isAdmin` (синхронно, из `IS_ADMIN`
  init-handshake); `inPortal`/`isAdmin` для гейта формы (в портале не-админ → предупреждение).
- `app/components/ImportStatusBanner.vue` — полоса статуса импорта (`B24Alert`, цвет = состояние:
  ok/running/error); «Обновлено N минут назад», «+N операций», «Записано в CRM · N в чат», при ошибке —
  действие «Проверить настройки». `app/components/OperationList.vue` — список операций строками
  (группировка по дню, плитка-направление ↑приход/↓расход, контрагент+назначение, сумма со знаком
  и цветом; строка раскрывается в `B24Collapsible` → `B24DescriptionList` с реквизитами; пустое состояние).
- `app/types/importStatus.ts` + `app/utils/importStatus.ts` (relative-time RU `formatRelativeTime`,
  `pluralRu`, `importStateMeta`) + `app/composables/useImportStatus.ts` — модель и презентация статуса
  импорта; читает реальный прогон из `GET /api/import/status` по фрейм-токену, без токена —
  честное пустое состояние (демо-мок удалён, #415).
- `app/components/BuildFooter.vue` (+ `app/utils/build.ts`, покрыт тестами) — подвал лендинга и
  `/app`: автор + ссылка на **коммит сборки** (`сборка <sha>` → GitHub commit); sha из
  `NUXT_PUBLIC_COMMIT_SHA` (CI передаёт `github.sha`, в dev — «dev»).
- **Промо-компоненты (cross-sell), общие по экосистеме** — переносимы 1:1 из `currency-converter`
  (правим в одном месте, копируем без правок; каталог в `docs/PAGE_GUIDE.md` §6):
  - `app/components/HoldRevealQr.vue` — мобильная кнопка-«отпечаток» с QR (hold-to-reveal): кладётся
    внутрь карточки `relative overflow-hidden`, удержание накрывает её QR-оверлеем. Десктоп не видит
    (`sm:hidden`) и не грузит `qrcode` (динамический импорт только на удержании). Пропсы `url`/`goal`/
    `caption`/`hint`/`dark`/`orientation` (`row` — промо-карточки / `stack` — визитка). Акцент —
    бренд-токен `--color-accent-primary-ch`.
  - `app/components/CustomDevCard.vue` — премиальная copilot-карточка «Нужна доработка под ваш
    процесс?» (ИП Шевчик, партнёр): `B24Card variant="filled-copilot"`, CTA `air-boost` → бриф
    `offer.bx-shef.by/#brief`, внутри `HoldRevealQr` (QR на сайт). Самодостаточна — тексты/ссылки
    вшиты (одинаковы по экосистеме), пропсами наружу только имена целей Метрики. Показывается **на
    in-portal-странице приложения** (`app/pages/app.vue`, над `BuildFooter`, `max-w-[520px]`) —
    предложение доработки актуально и внутри портала; на лендинге не дублируем (там своя `BriefForm`).
  - `app/components/AppInBitrixCard.vue` — карточка «Приложение для Bitrix24» (cyan, light/dark-auto):
    ссылка на листинг Маркета + мобильный `HoldRevealQr` (QR листинга). Контент — **через пропсы**
    (`eyebrow`/`title`/`text`/`ctaLabel`/`url` + опц. цели/подписи QR; `clickGoal` по умолчанию
    `market_click`). На лендинге (`app/pages/index.vue`, после «Почему мы») тексты — из
    `LANDING_MARKET_PROMO`, url — `LANDING_MARKET_URL` (`shef.bankimport`), своя цель клика
    `market_card_click` (чтобы не сливаться с целью кнопки hero). Лендинг standalone → карточку в
    iframe не прячем (в отличие от `currency-converter`, где `/` dual-mode).
- **Авторизация оператора** (вход для сотрудников в служебную зону — `/queues`, дальше страницы импорта;
  лендинг и B24-встройку не закрывает) — [`docs/AUTH.md`](docs/AUTH.md). Чистое ядро `server/utils/session.ts`
  (`resolveAuthConfig`/`checkCredentials` constant-time, `signSession`/`verifySession` — HMAC-подпись cookie;
  статус-матрикс роутов `decideLogin`/`decideLogout`/`sessionStatus` — тонкие `server/api/auth/*` только I/O,
  тестируются без сервера; тесты). Роуты `server/api/auth/login|logout|session`. Клиент — `app/composables/useAuth.ts`,
  форма `app/pages/login.vue` на **b24ui** (`B24Card`/`B24Input`/`B24Button`/`B24Alert`, layout `clear` → light/dark),
  публичная `noindex` (маппинг ошибок → сообщение в чистом `app/utils/loginError.ts`, покрыт тестом). Гвард
  `app/middleware/auth.ts` (клиентский редирект; реальная защита — на API), а
  `app/components/AuthGate.vue` прячет контент служебных страниц за «Проверка доступа…» до подтверждения сессии
  (SSG-статику красит колор-мод, поэтому иначе защищённый контент мелькал бы до редиректа). Cookie `cba_sess`
  HttpOnly/SameSite=Lax/Secure, CSRF-заголовок `X-CBA-Auth`. Пароль пуст ⇒ вход выключен. Модель портирована
  из `postroyka/purchase-ai-chat`. B24 silent-сессия — далее.
- `app/utils/landing.ts` — тексты и чистая логика лендинга (`LANDING_TITLE/DESCRIPTION`,
  `LANDING_PAIN_RESULT`, `LANDING_STEPS`, `LANDING_FEATURES`, `LANDING_INTEGRATORS`, `copyrightYears`),
  покрыта тестами. Единый источник контента (issue #110) — из него же берёт SEO `app.vue`.
- **Доменное ядро (чистое, переносимо в backend, покрыто тестами):**
  - `app/types/statement.ts` — модель выписки (`Statement`/`StatementItem`/`StatementParty`,
    `OperationDirection`, `BankProviderId`) + **единый интерфейс**: `StatementFetchQuery` (вход:
    банк/счёт/диапазон; батч-`StatementQuery` для `BankProvider` — в `banks.ts`),
    `StatementNormalizer` (`raw,ctx → StatementItem[]`) — один выход на все банки (см. REFACTOR_PLAN
    «Единый интерфейс выписки»).
  - `app/config/banks.ts` — абстракция `BankProvider` + реестр банков (Альфа/Приор/ручной импорт).
  - `app/utils/statement.ts` — классификация приход/расход, дедуп (`account|docId`), фильтр чата,
    `parseRuleLines` (textarea → массив правил).
  - `app/utils/activity.ts` — **общие хелперы дела**: заголовок (`buildActivityTitle`), деньги/дата
    (`formatMoney`/`formatIsoDate`), TZ-штамп дедлайна (`toPortalDeadline`, UTC+3), тип-владелец
    (`CRM_OWNER_TYPE_COMPANY`), app-namespace `ACTIVITY_ORIGIN`, `CrmCompanyRef`. Сам билдер носителя —
    `configurableActivity.ts` (настраиваемое дело). **Безопасность:** внешние поля (назначение/контрагент/
    номер документа — контролирует плательщик) прогоняются через `neutralizeBb` (BB-скобки → полноширинные)
    — иначе `[url=…]`/упоминания попали бы в карточку. `neutralizeBb` живёт здесь (шарится в
    `chatMessage.ts` и `configurableActivity.ts`, чтобы не было цикла импорта).
  - `app/utils/allocation.ts` — **чистое ядро разнесения оплат** (#109, спека — `docs/PROCESSING.md` §2):
    `resolveAllocation` над кандидатами, уже отфильтрованными по компаниям **и по стадии** (инвойсы/сделки
    с отрицательной стадией исключены; Этап C/D), решает по критерию владельца (совпали **сумма** — точно,
    в минорных единицах — **и валюта**): нет точного совпадения → `manual` (очередь ручного разбора); одно →
    `allocate`; несколько → `allocate` на **минимальный ID** с флагом `ambiguous` (вызывающий шлёт
    оповещение в чат). `collapseSameTarget` схлопывает только заведомо одну цель (инвойс поверх оплаты той
    же сделки по `dealId` — invoice-кандидат несёт `dealId` из `parentId2`, live-confirmed #229; буквальный
    повтор `kind`+`id`) — разные сущности одной суммы остаются
    раздельными (→ `ambiguous`). `allocationFactKey` — идемпотентный ключ факта «платёж→сущность».
    `ALLOCATION_TARGET_ROLE` (`Record<AllocationTargetKind,'amount'|'trigger'>`) — **единый
    компиляторно-проверяемый источник** разбиения целей: amount (инвойс/оплата — через `resolveAllocation`)
    vs trigger (сделка/смарт-процесс — безусловно, минуя сумму); новый вид не скомпилируется без
    классификации (ретайрит дублирующий `AMOUNT_GATED_KINDS` в `itemByIdLookup`). `summarizeAllocation(payment)` —
    чистая свёртка кандидатов в исход (`allocatable`/`ambiguous`/`manual`/`none` + decision + число trigger-целей);
    её зовёт `crm-sync` (лог/счётчики) и переиспользует будущий слайс записи.
    `filterByAccountNumber(candidates, number)` — точный отбор кандидата по `accountNumber` (для распознанного
    `payment-number` в company-пуле оплат, собранном по компании, а не по номеру; пустой номер → `[]`, не сметает
    пул). `filterByOrderNumber(candidates, orderNumber)` — отбор по **order-части** `accountNumber` оплаты
    (форма `<заказ>/<seq>`, seq — последний сегмент → сравнение по `lastIndexOf('/')`; для `order-number`, #172):
    композит `123/45` матчит `123/45/1`, короткий `123`/«10» — нет (подтверждено вживую — order «1» → оплата «1/1»);
    пустой номер → `[]`. `filterByPaymentId(candidates, paymentId)` — отбор по **собственному id оплаты** в company-пуле
    (для `payment-id`, #172; IDOR-safe — чужая оплата не в пуле). `filterByPaymentIds(candidates, ids)` — отбор по
    **множеству** id оплат (для `order-id`, #172: id оплат заказа из `sale.payment.list` **∩** company-пул держит IDOR;
    пустое множество → `[]`). **`stripMaskLiteralPrefix(value)`** (#242) — снимает литеральный префикс маски
    (`ЗАК-6001`→`6001`, `BOPC-123/45`→`123/45`): `recognizeByMatrices` отдаёт префикс целиком (верно для инвойса, чей
    `accountNumber` = `СЧ-1`), но оплата сделки несёт **голый** `<заказ>/<seq>`/целый id — `intentResolver` стрипит
    значение перед пуловым матчем (payment-number/order-number/payment-id/order-id), сообщая исходное `value`; на
    invoice-путь **не** применяется. Без I/O; проводка в `crm-sync` — следующий слайс.
  - `app/utils/purposeMatch.ts` — **чистое распознавание идентификатора из назначения платежа по МАТРИЦАМ**
    (#109, спека — `docs/PROCESSING.md` §4): `recognizeByMatrices(purpose, matrices, alphabet)` — матрица
    (`MatchMatrix { mask, kind }`) описывает формат номера маской (`d`=цифра, остальное — литерал: буквы/
    `-`/`/`), напр. `dddd`, `СЧ-dddd`, `BOPC-ddd/dd`. Извлекает совпавшую подстроку (граница по алфанум —
    не хватает фрагмент длинного токена; составные `123/45`; регистронезависимо; дедуп). `foldHomoglyphs`
    приводит визуально-одинаковые кир↔лат (`ВОРС`↔`BOPC`) к выбранному алфавиту (`Alphabet`) — и назначение,
    и маску перед сравнением. `IdentifierKind` — таксономия §4. Матрицы/алфавит — из настроек портала, без
    хардкода; без I/O; сам lookup id→сущность — REST-слайс. DoS-гард `MAX_PURPOSE_CHARS`/`MAX_ID_CHARS`.
  - `app/utils/identifierDispatch.ts` — **чистый роутинг `IdentifierKind → цель+стратегия поиска`** (#109,
    между распознаванием §4 и REST-lookup): исчерпывающая таблица `IDENTIFIER_ROUTES`
    (`Record<IdentifierKind, IdentifierRoute>` — новый вид не скомпилируется без маршрута) → `targetKind`
    (`AllocationTargetKind` или `null` для моста-документа) + `LookupStrategy` (`by-id`/`by-number`/
    `by-account-number` (payment-number, #189)/`by-order-number` (order-number, #172)/`by-payment-id`
    (payment-id, #172)/`by-config-field`/`via-order`/`via-document`) +
    `needsConfiguredField` (нужен параметр из карты
    сопоставления — `deal-field`/`smart-field` (поле) и `smart-id` (entityTypeId СП)). Без I/O и без хардкода имён полей;
    сам REST-поиск и поле из настроек — REST-слайс. `AllocationTargetKind` расширен до `invoice|deal-payment|deal|smart-process`.
  - `app/utils/priorOauth.ts` — Open Banking (СПР) Приора: чистое OAuth/DCR/consent-ядро (префиксы API,
    `buildPriorAuthorizeUrl`/claims/тела токенов/`buildConsentRequest`/`buildResourceRequestBody` + парсеры
    `parsePriorTokenResponse`/`extractIntentId`/`extractResourceId`/`extractAccounts`). Без `node:crypto` —
    подпись `request`-JWT и транспорт у вызывающего (браузеро-безопасно, аналог `alfaOauth.ts`). Три имени,
    совпадающие с Альфой, несут префикс `Prior` (Nuxt авто-импортит `app/utils/**` в один неймспейс).
  - `app/utils/alfaStatement.ts` — нормализация выписки Альфы (`partner.accounts 1.2.0`) в `StatementItem`
    (`normalizeAlfa` — контракт `StatementNormalizer`).
  - `app/utils/priorStatement.ts` — нормализация операции Приорбанка (Open Banking СПР) в `StatementItem`
    (`normalizePrior`); подтверждено на живом sandbox — см. [`docs/PRIOR_API.md`](docs/PRIOR_API.md).
  - `app/utils/clientBankText.ts` — парсер **формата** текстовой выписки client-bank (CP1251,
    `***** ^Type=`) → секции/строки; для провайдеров `prior-by`/`manual`. Портированный пример,
    вход ограничен по размеру (`MAX_CLIENT_BANK_CHARS`, DoS-гард #19); остаточный рефактор
    (словари ключей) — issue #19.
  - `app/utils/clientBankStatement.ts` — нормализация разобранной текстовой выписки в `StatementItem`
    (`normalizeClientBank` — контракт `StatementNormalizer`; приход/расход, валюта нац/инвалюта,
    контрагент, `account|docId`-дедуп). Провайдер `manual` (и файловый путь `prior-by`) — issue #19.
    Проверено на образцах `tests/fixtures/client-bank/` (BYN `Type=400`, CNY `Type=600`) и на реальных
    выгрузках трёх форматов: `Type=3` «за день» (`demo-type3-vpsk`), `Type=4` «за период»
    (`demo-type4-alfa`) и валютный `Type=5` «за день» (`demo-type5-vpsk`). Ключ дедупа (`rowDocId`):
    `DocID` → `OperationID` (уникальный id в `Type=4`, где `Num` повторяется — иначе коллизия/потеря
    операции, #73) → фолбэк `Num|DocDate`. **Валюта** (`detectStatementCurrency`): альфа-маркер `I3`/`I1`
    → `ctx.currency` → числовой ISO `CurrCode`/`I3`/`I1` (`643`=RUB, `933`=BYN — единственный маркер на
    валютных «за день» выписках, #169) → BYN-дефолт для BY-счёта. Для инвалютной операции сумма берётся
    из `…Q`-поля (`CreQ`/`DebQ`, в валюте счёта), а не из BYN-эквивалента `Cre`/`Deb` (подтверждено на
    реальной RUB-выписке `Type=5`, #169). BIC контрагента из `Cod`/`Code` — только BIC-образный токен
    (`Code` бывает и числовым кодом валюты).
  - `app/utils/oneCExchange.ts` + `app/utils/oneCStatement.ts` — формат обмена 1С «Клиент-банк»
    (`1CClientBankExchange`, версии 1.01–1.03): парсер секций (`parseOneCExchange`) + нормализатор
    (`normalizeOneC` — контракт `StatementNormalizer`; направление по «наш счёт = плательщик/получатель»,
    валюта из кода счёта RU/BY, дедуп `Номер|Дата`). Второй `manual`-формат — issue #21.
  - `app/utils/manualImport.ts` — точка входа ручной загрузки: детект формата (`detectManualFormat`)
    → парсер+нормализатор (`normalizeManualStatement`: `1CClientBankExchange` или `***** ^Type=`).
  - `app/utils/importUpload.ts` — чистое ядро UI ручной загрузки (P4): `validateUploadFile`
    (расширение/размер), `decodeAndParse` (windows-1251 `TextDecoder` → `normalizeManualStatement`;
    работает в браузере и node — тесты на реальных фикстурах), `dedupItems` (`account|docId` по
    нескольким файлам), `uploadErrorMessage`. Без DOM.
  - `app/utils/mockStatement.ts` — демо-данные для UI до реальной интеграции.
  - `app/utils/money.ts` — общий `round2` (округление денег до 2 знаков после суммирования, без float-дрейфа;
    нефинитное → 0) — единый для дисплей-агрегаторов (`demoExtract` «суммы по валютам», `importStats`), чтобы копия
    не жила в трёх местах. Тест — `tests/money.test.ts`.
  - `app/utils/importStats.ts` — **чистое ядро агрегации результата импорта (#62, слайс 1)**: `StatementItem[]` →
    `computeImportStats` (итог: число операций, приходы/расходы **по валютам**, доминирующая валюта, разбивка
    приход/расход **по дням** для доминирующей валюты); `dayBucketsForCurrency`/`operationDay`/`currencyTotal`
    (итог по выбранной/доминирующей валюте с пустым дефолтом) — хелперы для рендера. `round2` из `money.ts`,
    нефинитная/отрицательная сумма → 0. Без DOM/ECharts — под тесты (`tests/importStats.test.ts`).
  - `app/utils/importStatsChart.ts` — **чистое построение опций столбчатого графика** (#419): расходы
    идут в ряд со ЗНАКОМ МИНУС (ось двусторонняя, «пришло вверх / ушло вниз» читается без легенды),
    подписи оси вынесены НАРУЖУ (`inside` убран; ширину под них резервирует `containLabel`, поэтому
    `BAR_GRID_LEFT` мал — большой отступ складывался бы с ней и съедал график), **ось со знаком, а
    подсказка по модулю** (в подсказке ряд уже назван «Расходы» — минус дал бы двойное отрицание; на
    оси без знака шкала читалась бы как «2000 / 0 / 2000»), **нулевая линия явной `markLine`**
    (`axisLine.onZero` у оси значений рисует вертикальную линию, а нужна горизонтальная). ⚠ Знак — **только отображение**: в `importStats`
    суммы остаются положительными, иначе поехали бы итоги плиток над графиком. Вынесено из компонента
    именно потому, что скриншотом это не проверить — график рисуется только при наличии операций
    (тесты — `tests/importStatsChart.test.ts`).
  - `app/components/ImportStatsChart.vue` — **анимированный результат импорта для сотрудников (#62, слайс 2)**:
    count-up плитки (операции/приходы/расходы по выбранной валюте) + ECharts **бары приход/расход по дням** +
    **пончик** доли, на чистом `importStats`. ECharts динамически импортится и tree-shaken (Bar+Pie+Grid/Tooltip/
    Legend+Canvas, client-only, как `QueueMonitor`); оси/пончик перекрашиваются под light/dark по классу `.dark`;
    `prefers-reduced-motion` глушит count-up и анимацию ECharts. Приход/расход **всегда подписаны** (↑/↓ + текст) —
    зелёный/красный в CVD-floor-band, легально только с этой вторичной кодировкой (dataviz). Селектор валют при
    мультивалютности. Переиспользуемый (пропс `items: StatementItem[]`): встроен и в `StatementUpload.vue`
    (ручной импорт `/import`, над предпросмотром), и на `/app` (in-portal, над «Последними операциями») — оба пути
    #62. Визуально проверен (свет/тёмная).
  - `app/types/b24Events.ts` + `app/utils/b24Events.ts` — события Б24 (`ONAPPINSTALL`/
    `ONAPPUNINSTALL`): разбор wire-формата (`parseBracketForm`, PHP-скобки), вердикт
    подлинности `application_token` (`appTokenVerdict`, fail-closed, constant-time),
    SSRF-гуард `isSafeClientEndpoint`, маппинг кредов портала `extractPortalCredentials`.
    Верификация+решение для реального события — в backend (`processB24Event`). Учёт авторизации/
    события/брокер — карточка [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md) (модель по backend `bx-synapse`).
- **Backend (Nitro, `server/`):** серверная часть в том же приложении (как `bx-synapse`).
  - `server/api/b24/events.post.ts` — эндпоинт вебхуков Б24: `readRawBody` → `parseBracketForm`
    → `handleEventRequest` (верификация без записи в БД) → кладёт пакет в очередь `b24-events`
    (register/unregister; refresh шифруется перед Redis). **Консьюмер — единственный писатель.**
    Онлайн-события Б24 **не ретраятся** — поэтому если очередь недоступна (Redis нет/упал), роут пишет
    в БД **синхронным фолбэком** (тот же токен-стор), чтобы установка/удаление не потерялись.
  - `server/api/health.get.ts` — публичный **liveness**-эндпоинт `GET /api/health` →
    `{ status, time, commit, commitUrl }` (коммит = `NUXT_PUBLIC_COMMIT_SHA`, как в подвале).
    Без секретов; на нём же построен docker `healthcheck` backend'а. Чистый билдер —
    `healthInfo` в `app/utils/build.ts` (покрыт тестами). ⚠ Только liveness процесса — зелёный
    даже при мёртвых Postgres/Redis.
  - `server/api/ready.get.ts` (+ чистое ядро `server/utils/readiness.ts`, DI, тесты; #301) —
    **readiness**-проба `GET /api/ready`: реально прощупывает зависимости — Postgres `SELECT 1` +
    (если очереди включены) Redis `PING` (`pingRedis` в `connection.ts`, с таймаутом — недоступный Redis
    не подвешивает пробу). `200 {ready:true, status:"ok", checks:{db,redis}}` либо `503` с
    `status:"down"` (Postgres недоступен) / `status:"degraded"` (db жив, Redis недоступен — API+события
    B24 идут через синхронный фолбэк, импорт/опрос стоят). Булевы, без секретов и глубины очередей
    (`redis:null` = очереди выключены). Кандидат для аптайм-мониторинга/`healthcheck` (не переключён —
    иначе restart-loop на блипе Redis).
  - `server/api/import.post.ts` (+ чистое ядро `server/utils/importIngest.ts`, DI, тесты) — **приём
    ручной загрузки выписки (P4, слайс 2)**: multipart `file` + фрейм-токен (`Bearer` + `X-B24-Domain`).
    `handleImportUpload`: гейт файла (расширение+размер) → **проверка ключа портала** (`getMemberIdByDomain`
    по домену; нет токена ⇒ приложение не установлено ⇒ 409, как брак пакета в воркере) → **валидация
    фрейм-токена** (`profile` — успех доказывает принадлежность порталу, блок спуфинга `X-B24-Domain`,
    даёт id инициатора) → кладёт файл (base64) в очередь `file-parse`; `202` fire-and-forget. Воркер
    (`parseFile` → `parseManualFileBase64`) декодирует windows-1251 и парсит → `crm-sync`. Файл едет в
    пакете (≤2 МБ; nginx `client_max_body_size 3m` в `snippets/proxy-backend.conf`).
  - `server/api/poll-now.post.ts` (+ чистое ядро `server/utils/pollNow.ts`, DI, тесты; #54/#302) —
    **ручной «Опросить сейчас»**: `POST /api/poll-now` ставит fetch-джоб на каждый подключённый
    pollable-счёт **своего** портала. Частота регулируется **app-side**, не порталом: 4 слоя — feature-gate
    `MANUAL_POLL_ENABLED` (default OFF) + `queueEnabled`, admin-гейт (`profile.ADMIN`, блок спуфинга домена),
    пер-портальный Redis-кулдаун `SET NX EX` (`claimCooldownSlot`, дефолт 60с, `MANUAL_POLL_COOLDOWN_SEC`;
    claim только при наличии работы), глобальный A8-лимитер ниже по потоку. Инертно (`enqueued:0`) без счетов;
    фильтр `POLLABLE_PROVIDERS` — тот же, что у крона (Альфа **и Приор**, у каждого своя очередь и свой бюджет).
    UI — `PollNowButton.vue` (admin-гейт, b24ui) + `useManualPoll`; живут в `SettingsForm` (слайдовер на `/app`).
    nginx `limit_req` на роут. `listBankAccountsForPortal` (без расшифровки refresh).
  - `server/utils/b24EventsHandler.ts` — чистый `processB24Event(payload, deps)` — **только чтение**
    (вердикт `application_token`, fail-closed → 200/400/403/503) и решение `action` (`register`/
    `unregister`); ничего не пишет. Роут кладёт `action` в очередь, консьюмер применяет. **Удаление
    приложения всегда стирает всё** для портала (флаг `CLEAN` не смотрим). Покрыт тестами.
    **Привязка `member_id` к OAuth-гранту на установке (#162, порт из `ai-price-import`):** `member_id`
    в событии — клиентский, верифицируется лишь `application_token`'ом (app-level секрет: получает **каждая**
    установка приложения), поэтому владелец чужого портала может подделать установку с `member_id` жертвы +
    своим OAuth-грантом → отравить `member_id` жертвы. `handleEventRequest` перед записью `register`-действия
    зовёт `bindInstallMember` (`server/utils/verifyInstallMember.ts`): **рефрешит присланный `refresh_token`**
    — токен-эндпоинт отдаёт **authoritative** `member_id` гранта, он обязан совпасть с заявленным (иначе
    поддельный грант чужого портала → **403**; `invalid_grant`/`invalid_token`/`expired_token` → 403;
    сеть/`wrong_client`/нет `member_id` → **503**, fail-closed — установка **не** пишется). Рефреш **ротирует**
    токен ⇒ на успехе храним **возвращённый** грант (accessToken/refreshToken/expiresIn), а не присланный
    (он уже spent). Гейт на `B24_CLIENT_ID/SECRET` в роуте (`events.post.ts`): без них рефреш невозможен в
    принципе (crm-sync/keep-alive тоже мертвы) ⇒ `bindInstallMember` не прокидывается, установка деградирует к
    прежней (application_token-only). Транспорт — **осознанное исключение из «всё через jssdk»**: один сырой
    POST на фиксированный `oauth.bitrix.info/oauth/token/` (SDK-рефреш **выбрасывает** `member_id` из ответа,
    привязка его требует; хост фиксирован → нет SSRF, секреты в теле POST, AbortSignal-таймаут, `withDependencySpan`).
    Работает и на sync-fallback-пути (Redis down) — bind до обеих веток. Чистое ядро (`verifyInstallMember`,
    DI) + тесты (`tests/verifyInstallMember.test.ts` + проводка в `tests/b24EventsHandler.test.ts`).
  - `server/utils/tokenStore.ts` — хранилище токенов портала над инъектируемым `QueryFn`
    (`save`/`get`/`getApplicationToken`/`delete`, write-once `application_token`). **Гард порядка событий
    (#77):** `saveToken`/`deleteToken` берут `eventTs` (метка времени события B24, монотонна — install
    раньше uninstall) и таблицу-тумбстоун `portal_tombstone`: `deleteToken` пишет тумбстоун `(member_id,
    deleted_ts)`, а `saveToken` **отказывается** писать поверх равного-или-новее тумбстоуна (возвращает
    `false`) — так «зависший» register (ретрай install после более свежего uninstall) не воскрешает портал
    со старыми кредами; настоящий reinstall (ts новее) проходит и чистит устаревший тумбстоун. Тесты на fake-query.
    **TTL тумбстоунов (#77):** тумбстоун нужен лишь пережить late/retried install той же деинсталляции (часы), а не
    месяцы — иначе копилась бы строка на каждый навсегда-удалённый портал. Суточный свип (`server/utils/tombstoneSweep.ts`
    — `resolveTombstoneDays` кламп [1,365] дефолт 30 + `sweepExpiredTombstones`, DI+тесты) сносит `portal_tombstone`
    старше `TOMBSTONE_TTL_DAYS`; висит на том же крон-тике, что statement-свип (#245, под `cron.sweep`-спаном).
    `deleted_ts` — в **секундах** (B24 `ts`), сверка с `EXTRACT(EPOCH FROM now())` unit-safe (мс-значение не подметётся рано).
  - **Дедуп дел — в B24, без стора (#259).** crm-sync пишет **настраиваемое дело** с маркером
    `originatorId`+`originId` и перед записью ищет его (`crm.activity.list`), поэтому Postgres-стора
    `{dedupKey→activityId}` больше нет (таблица `activity_dedup`, модуль `activityDedupStore.ts` и
    `rememberActivity` удалены). Модули носителя/поиска — ниже (`configurableActivity.ts`/
    `configurableActivityWrite.ts`/`activityMarkerLookup.ts`). In-batch `Set` в `handleCrmSyncJob`
    снимает дубли внутри пакета; кросс-джобовую идемпотентность держит маркер в B24.
  - `server/utils/secretCrypto.ts` — AES-256-GCM шифрование `refresh_token` (ключ `B24_TOKEN_ENC_KEY`).
  - `server/utils/envCheck.ts` (+ плагин `server/plugins/envCheck.ts`) — валидация env на старте
    (чистая `checkBackendEnv`, тесты): `B24_TOKEN_ENC_KEY` есть и декодируется в 32 байта; `DATABASE_URL`
    задан; `B24_APPLICATION_TOKEN` не плейсхолдер (`CHANGE_ME` и т.п. → реальный токен не совпадёт → 403);
    отсутствие `B24_CLIENT_ID/SECRET` — warning (приём событий работает, refresh/`app.option` — нет).
    Логирует, **не роняет** процесс (конвенция как `authGuard.ts`); no-op при prerender.
  - `server/db/client.ts` — ленивый pg-Pool (`DATABASE_URL`) + схема (`portal_tokens`, `portal_tombstone`,
    `import_result`, `import_batch` (итог конкретной ручной загрузки, #417; свип 3 дня), `metrics_counter`, `bank_tokens`, `portal_app_rating`; дедуп дел — маркер в B24, таблицы нет — #259;
    разнесение — строка dist-СП, таблицы нет — §9.3 #6, `allocation_fact` снят + идемпотентный `DROP TABLE IF EXISTS` на старте);
    `server/plugins/migrate.ts` — идемпотентная миграция на старте. **Выписки у себя не храним** — только
    токены/факты/агрегаты; сама выписка транзитна (payload'ы очередей с ограниченным по возрасту удержанием,
    `STATEMENT_JOB_RETENTION`, #245). Модель хранения/чистки финансовых ПДн — [`docs/PRIVACY.md`](docs/PRIVACY.md).
  - `server/utils/bankTokenStore.ts` — **стор банк-OAuth токенов** (Альфа/Приор online-fetch, стадия 5; A3) над
    инъектируемым `QueryFn`: `saveBankToken`/`getBankToken`/`listBankTokensForPortal`/`deleteBankTokensForPortal`.
    refresh шифрован `secretCrypto` (тот же `B24_TOKEN_ENC_KEY`), access — в открытом. Ключ `(member_id, provider,
    account_key)` — **много на портал** (счета/«моя компания»; **Альфа, Приор и ручная загрузка
    работают одновременно** — подключения накапливаются, каждый connect добавляет ещё один счёт, а не
    заменяет предыдущий; ручной импорт `/import` — независимый путь и от онлайн-подключений не зависит),
    полностью UPDATE-able (банк ротирует refresh — нет
    write-once/тумбстоуна). `list` резилиентен (битую строку пропускает+логирует, `get` — fail-loud). Банк-apiKey
    **никогда** в `app.option`. Чистка на ONAPPUNINSTALL (`deletePortal`). Тесты — на фейк-`QueryFn` + in-memory-модель.
  - `server/utils/ensureBankToken.ts` — **конкуренто-безопасный рефреш банк-токена** (стадия 5; A4), по образцу
    `ensureAccessToken`: near-expiry рефреш под **per-account advisory-lock** + перечит внутри лока (при N воркерах опроса
    ровно один рефрешит — банк ротирует refresh, гонка ломает креды); `{force}` реактивный ретрай (рефреш только если
    stored всё ещё отвергнутый). Провайдер-специфика через готовые ядра: **Альфа** — `client_id/secret` в теле; **Приор**
    — `Authorization: Basic` (client_secret_basic), тело `grant_type+refresh_token` (`bankRefreshRequest`/`parseBankRefresh`,
    чистые). `bankCredsFromEnv` — `ALFA_OAUTH_*`/`PRIOR_OAUTH_*` (`_CLIENT_ID`/`_CLIENT_SECRET`/`_TOKEN_URL`); неполные ⇒
    `null` ⇒ токен как есть + warn (envCheck сигналит half-config на старте). Живой рефреш — за банк-кредами владельца.
  - `server/utils/bankConnectState.ts` — **CSRF-safe OAuth `state` для connect-потока** (стадия 5; A7a):
    `signConnectState`/`verifyConnectState` (HMAC-SHA256 над `SESSION_SECRET`, привязка callback к порталу+
    провайдеру+счёту, короткий `exp`, constant-time, fail-closed; зеркало `session.ts`, разделяемый
    `safeEqual`). **Доменная сепарация** (`DOMAIN_TAG` в подписи) — connect-state НЕ верифицируется как
    сессионная кука `cba_sess` и наоборот (иначе не-секретный state из authorize-URL/логов банка переигрался
    бы в сессию оператора → эскалация). Тесты (вкл. кросс-протокол).
  - `server/utils/bankConnectStart.ts` + `server/api/bank/connect.post.ts` (стадия 5; A7b-1) — **старт
    OAuth-подключения банка**: `POST /api/bank/connect` (фрейм-токен как `/api/import` → `memberIdByDomain`+
    `validateFrame` (`profile`: блок спуфинга + **гейт админа** `profile.ADMIN` — креды привязываются ко
    всему порталу) → подписанный state с **нашим** `memberId`, не клиентским, + **номер счёта** (`accountKey`,
    `isValidAccountKey`) → `buildAuthorizeUrl`) отдаёт `{authorizeUrl}` (фронт A7c откроет top-level).
    **Callback A7b-2** — `server/utils/bankConnectCallback.ts` + `server/api/bank/callback.get.ts`:
    `GET /api/bank/callback` (top-level редирект банка, авторизация = подписанный state) → **verify state ДО
    REST** → `parseOAuthCallback`→`buildTokenExchangeBody`→обмен на `/token` (`client_secret` в теле, не
    логируется)→`parseTokenResponse`→`saveBankToken` под `state.accountKey`. Ошибки банка не рендерятся, лог
    через `sanitizeForLog` (CRLF/длина). 200/400/502; nginx-троттл. **UI A7c** — `app/components/
    BankConnectCard.vue` (b24ui `B24Card`/`B24RadioGroup`/`B24FormField`/`B24Input`/`B24Button`/`B24Alert`,
    admin-гейт `useIsAdmin`, в `SettingsForm`) + composable `app/composables/useBankConnect.ts` (POST `/api/bank/connect`
    фрейм-токеном → `authorizeUrl` → `window.open` top-level; номер счёта — как есть (только trim крайних пробелов), без переформатирования/case-folding).
    **Список подключённых счетов + отключение (#404, UX по живому прогону):** после успешного connect
    UI не показывал ничего — ни банк, ни счёт, ни способ убрать ошибочный. Добавлены
    `GET /api/bank/accounts` и `POST /api/bank/disconnect` (чистые хендлеры `server/utils/bankAccounts.ts`,
    DI+тесты) — **гейт тот же, что у connect**: портал установлен → фрейм-токен доказан для ЭТОГО домена
    (блок спуфинга `X-B24-Domain`) → `profile.ADMIN` (банк-креды портало-широкие). Стор: `listBankAccountInfoForPortal`
    (идентификация+свежесть, **без расшифровки** — токены не покидают сервер, а битая строка всё равно
    листается, иначе её нельзя было бы отключить) и `deleteBankToken` (member-scoped в WHERE — чужую строку
    не удалить даже подделав provider/account; идемпотентно). UI — `ConnectedBankAccounts.vue` (внутри
    `BankConnectCard`, над формой) + `useBankAccounts.ts`; подтверждение удаления — вторым кликом в строке
    (не `confirm()` — тот блокируется в части iframe'ов). Лейблы банков — общий `app/utils/bankLabels.ts`.
    **Подключение без ввода счёта (#407):** порядок «сначала банк, потом счёт» — до авторизации админ
    не обязан помнить IBAN, а после неё номер виден. Счёт на старте необязателен; такое подключение
    приземляется под **временный ключ** (`app/utils/bankAccountKey.ts` — `~pending:<nonce>`; префикс
    `~` невозможен в номере счёта, поэтому спутать нельзя, а nonce из подписанного state даёт
    уникальность: два параллельных connect'а одного админа иначе затёрли бы друг друга). Список
    показывает такую строку как «счёт не выбран» с полем ввода, `POST /api/bank/set-account`
    (`handleSetBankAccount` + `renameBankTokenAccount`, DI+тесты) заменяет ключ настоящим номером.
    ⚠ Переименовать можно **только** временный ключ — иначе это способ подменить счёт у живого
    подключения и увести операции на другой номер; занятый номер → **409**, а не тихое затирание
    живого токена (гонка двух привязок ловится по нарушению первичного ключа `23505` → тот же 409,
    а не 500). ⚠ **Ожидающее подключение НЕ опрашивается** (`accountsForPolling` фильтрует
    `isPendingAccountKey`) — у банка нет такого «номера», и задача падала бы на каждом тике вечно,
    сжигая общий лимит запросов (задача Приора ~10 HTTP); по той же причине оно **не считается
    подключённым счётом** на экране готовности (#409), иначе там горела бы ложная зелёная строка.
    При этом **молчать о нём тоже нельзя** (админ авторизовался и закрыл вкладку — раньше такое
    подключение было видно только в списке внутри карточки банка, то есть фактически нигде):
    `setup-status` отдаёт `pendingAccounts` отдельным счётчиком, и строка «Банк подключён» на экране
    готовности остаётся красной с подсказкой «укажите номер», пока незавершённые есть.
    **Connect-поток A7 завершён**; живой прогон — **Альфа подтверждена вживую** (authorize → callback →
    счёт сохранён). Config из env
    (`bankConnectConfigFromEnv`: authorize-host = `ALFA_OAUTH_TOKEN_URL` минус `/token`, `ALFA_OAUTH_REDIRECT_URI`/
    `_SCOPE`); провайдер не настроен → 400 (до REST), нет секрета → 503 (fail-closed);
    `Referrer-Policy: no-referrer` (нет секрета → **503 на старте**, на callback → 400). Чистые ядра (DI,
    тесты) + тонкие роуты.
    **Приор в connect-потоке (A5b, слайсы 2b-2d):** у Приора authorize требует **живой преамбулы**, которой
    у Альфы нет — `server/utils/priorConnectStart.ts` (`buildPriorConnectUrl`: токен Б `client_credentials`
    `scope=accounts` → `POST /accountConsents` → `openbanking_intent_id` → **RS256-подписанный `request`-JWT**
    → authorize-URL; конфиг `priorConnectConfigFromEnv` fail-closed — нет любой части env ⇒ `null` ⇒ 400) +
    подписчик `server/utils/priorJwt.ts` (`signPriorJwt`, `node:crypto`, зеркалит `signJwt` recon-скрипта).
    `handleBankConnectStart` **диспатчит по провайдеру**: у Альфы — чистая сборка URL, у Приора — инъектируемая
    преамбула (сбой банка → **502**, не 400); **гейты идентичны** (портал установлен, фрейм-токен, ADMIN,
    подписанный state с **нашим** memberId) и идут **до** любого обращения к банку. Callback тоже диспатчит:
    Альфа — `client_secret` в теле, Приор — **`client_secret_basic`** (креды в заголовке `Authorization`,
    никогда в теле/URL) + свой парсер; Приор может **не вернуть** `refresh_token` → храним пустой (рефреш до
    переподключения невозможен), а не 502. Оба банка приземляются на **один** callback и различаются по
    `provider` из **проверенного** state. UI — пикер банка `B24RadioGroup` (тип сужен до подключаемых, `manual`
    выбрать нельзя); подписи/плейсхолдер/кнопка следуют выбору. Env — `PRIOR_OAUTH_*`
    (`_CLIENT_ID`/`_CLIENT_SECRET`/`_REDIRECT_URI`/`_AUDIENCE`/`_PRIVATE_KEY`/`_KID`/`_API_BASE`).
    **Автоопрос включён**: `prior-by` в `POLLABLE_PROVIDERS`, отдельная очередь `bank-fetch-prior`
    (`fetchQueueFor`) с бюджетом в ЗАПРОСАХ (`providerJobRate` делит лимит на стоимость задачи) и
    собственными слотами (`QUEUE_PRIOR_CONCURRENCY`) — длинная задача Приора не держит воркер Альфы.
    **Осталось:** прод-СКЗИ (issue #41) — без BY-крипто TLS прод-хост `:9345` недостижим; sandbox `:9344` работает.
  - `server/utils/setupStatus.ts` + `server/api/setup-status.get.ts` (+ чистое ядро
    `app/utils/setupReadiness.ts`, composable `useSetupStatus.ts`, UI `SetupReadinessCard.vue`;
    DI+тесты, вкл. nuxt-тест проводки) — **экран готовности «что настроено, а что нет» (#409/#405)**:
    первый блок в `SettingsForm`, шесть строк (банк / чат / **чат ошибок** / **карта распознавания** / смарт-процессы / автоопрос; последние
    две добавлены в #421 — без чата ошибок сообщения о неопознанных платежах не приходят никуда, без матриц
    разнесение не работает вовсе) с конкретным
    действием на каждой красной. Гейт как у `/api/bank/*` (портал установлен → фрейм-токен доказан для
    ЭТОГО домена → `profile.ADMIN`), nginx-троттл зоны `import`. Роут отдаёт **только то, чего браузер
    знать не может** (число подключённых счетов, гейт+период опроса, метка последнего прогона); настройки
    портала **не дублируются** — клиент уже держит их в синглтоне, композиция в компоненте (серверная
    копия расходилась бы с открытой формой). ⚠ Два места, где легко соврать и потому сделано иначе:
    `pollEnabled` = `CRON_REAL_POLL` **И** `queueEnabled()` (без Redis крон молча не работает — ложная
    зелёная галочка была бы худшим исходом для экрана, который существует ровно ради таких дыр); **времени
    следующего опроса нет вовсе** — крон это `setInterval` от старта процесса, а `lastSyncAt` ставится
    только когда прогон дал операции, поэтому «последний прогон + интервал» врал бы дважды; показываем
    период и честную метку «последний импорт» (её ставит и ручная загрузка, отсюда именно «импорт»).
  - `server/utils/importBatchStore.ts` + `server/api/import/batch.get.ts` (+ чистый
    `server/utils/importBatchHandler.ts`, DI, тесты) — **итог КОНКРЕТНОЙ ручной загрузки (#417)**:
    раньше `/import` отвечал «принято в обработку» и замолкал навсегда — запись в CRM идёт в фоне, и
    её исход сотруднику было негде увидеть (`import_result` не годится: он один на портал и
    перезаписывается любым прогоном, в том числе автоопросом). Таблица `import_batch`, ключ
    `(member_id, batch_id)`, где `batch_id` = sha256 файла (его же отдаёт `POST /api/import`):
    роут ставит `queued` после постановки в очередь (best-effort — учёт не отменяет принятый файл),
    воркер `crm-sync` пишет итог для `source:'parse'`, воркер `file-parse` пишет провал. **Два
    тупика закрыты явно:** разобрано НОЛЬ операций (`crm-sync` тогда не ставится вовсе — строка
    иначе висела бы в «принято» вечно) и нераспознанный формат (помечаем провалом **только на
    последней попытке** BullMQ — «не разобралось», а через минуту передумать, хуже, чем подождать).
    `GET /api/import/batch?ids=…` — фрейм-токен (как у `/api/import`), **скоуп по порталу в самом
    WHERE**: ключ это хеш ФАЙЛА, то есть не секрет — его знает всякий, у кого есть такой же файл.
    Ключи валидируются маской sha256-hex и капятся (`MAX_BATCH_IDS`), nginx-зона `import`. UI —
    чистое ядро `app/utils/importBatchView.ts` (когда прекращать опрос, свод, подписи) +
    `useImportBatches` (опрос, ключи в `sessionStorage` — перезагрузка вкладки не должна стирать
    исход) + блок «Результат обработки» в `StatementUpload`. Строка **не хранит операций/назначений**
    — только счётчики и имя файла; свип каждые 6 часов чистит старше 3 дней (`docs/PRIVACY.md`), удаление
    приложения — сразу.
  - `server/utils/importResultStore.ts` + `server/api/import/status.get.ts` (+ чистый
    `server/utils/importStatusHandler.ts`, DI, тесты) — **статус импорта для UI (#5)**: `crm-sync`-джоба
    **апсертит** сводку последнего прогона портала (`import_result`, один ряд на `member_id`: state/
    операции/дела/в-чат/ошибки) через воркер (демо-счета не пишут; best-effort — сбой статуса не роняет
    джобу). `GET /api/import/status` по **фрейм-токену** (`Bearer`+`X-B24-Domain`, `profile`-валидация,
    блок спуфинга домена; нет прогона → `neverSummary`) отдаёт `ImportRunSummary`. UI `useImportStatus`:
    в портале — реальный fetch, вне фрейма — пустая сводка `never` (демо-мок удалён, #415). Счётчик `notified` в `handleCrmSyncJob` (⊆ created).
    Удаление приложения чистит `import_result`.
  - `server/utils/metricsStore.ts` + `server/api/import/metrics.get.ts` / `metrics-reset.post.ts` (+ чистый
    `server/utils/metricsHandler.ts`, DI, тесты) — **долговременные счётчики портала (#78)**: воркер
    best-effort **накапливает** пожизненные счётчики (`metrics_counter`, ключ `member_id|name`:
    processed/created/notified/unmatched/unresolved/recognized/resolved/allocated/distributed/ambiguous/manual) из сводки
    `crm-sync` рядом с `import_result` (демо-счета не пишут; сбой метрик не роняет джобу). В отличие от
    `import_result` (только **последний** прогон) — это **тотал за всё время**, переживает рестарт. `GET
    /api/import/metrics` (счётчики) и `POST /api/import/metrics-reset` («сбросить») по **фрейм-токену**
    (`profile`-валидация, member-scoped — портал видит/сбрасывает только свои; **сброс — admin-only**,
    `profile.ADMIN`, #182 паритет). Удаление приложения чистит
    `metrics_counter`. Форма портирована из соседнего `ai-price-import` (адаптирована под наш `QueryFn` и
    платёжный словарь метрик).
  - **Очереди (BullMQ + Redis)** — шина под нагрузку и масштабирование. Полное описание (поток,
    payload'ы, лимитеры, роли контейнеров, наблюдаемость, переменные) — [`docs/QUEUES.md`](docs/QUEUES.md).
    Здесь только карта файлов `server/queue/`:
    - `topology.ts` — имена очередей, payload'ы, идемпотентные `jobId`. Чистый, без Redis.
    - `connection.ts` — ленивый `getQueue()`, гуард `queueEnabled()`.
    - `producers.ts` — постановка задач (no-op без Redis) + удержание payload'ов (ПДн, `PRIVACY.md`).
    - `handlers.ts` — **чистые обработчики с DI**, включая `handleCrmSyncJob` — главный конвейер
      обработки операции (спека — [`docs/PROCESSING.md`](docs/PROCESSING.md) §2/§4).
    - `worker.ts` — сшивка чистых ядер с живыми транспортами (B24 REST, банк, чат, БД).
    - `cron.ts` — план опроса, демо-нагрузка; `pollCapacity.ts` — сколько счетов влезает в тик.
    - `statementSweep.ts` — удаление payload'ов выписок по стенным часам; `saturation.ts` — лог
      упора в лимитер; `workerObservability.ts` — greppable-логи падений; `stats.ts` — счётчики;
      `runtime.ts` — разбор ролевых env (`QUEUE_WORKERS`/`QUEUE_CRON`/concurrency).
    ⚠ Правило: значения дефолтов и лимитов **не дублируем здесь** — они в `QUEUES.md` §Переменные
    окружения. Разошедшийся дубль опаснее отсутствующего описания.
  - `server/utils/companyLookup.ts` — **чистое ядро поиска компании CRM по счёту** (DI над `RestCall`,
    тесты): `crm.requisite.bankdetail.list` по `RQ_ACC_NUM`→фолбэк `RQ_IIK` (ИИК Беларуси) → id реквизитов →
    `crm.requisite.list` (`ENTITY_TYPE_ID=4`) → id компании (шаги 1-2 вынесены в `resolveCompanyIdsByAccount`).
    `findCompanyByAccount` — компания контрагента (первая; `RQ_ACC_NUM` не уникален). `findMyCompanyByAccount`
    — **моя компания по нашему счёту** (§2 Этап C): те же шаги + фильтр `crm.item.list` `isMyCompany='Y'`
    (подтверждён вживую). **Оба проведены в `crm-sync`** (#91): `findCompany` — клиент; `findMyCompany` —
    UNMATCHED-фолбэк. Клиент `null` → пишем в мою компанию (с причиной) + чат ошибок; и моя `null` → не
    пишем, чат ошибок (§5).
  - `server/utils/b24Sdk.ts` + `server/utils/portalSdkResolver.ts` — **SDK-транспорт `crm-sync` (#191, единственный,
    дефолт):** per-portal `B24OAuth` → наш `RestCall`. У SDK встроенный RestrictionManager (leaky-bucket 2 req/s,
    retry-backoff на `QUERY_LIMIT_EXCEEDED/429/5xx`) **по умолчанию** и **per-instance** — это и есть lever-1
    (пер-портальный лимитер). **In-client РЕТРАЙ отключён** (`disableSdkRetry` → `setRestrictionManagerParams`
    `{...ParamsFactory.getDefault(), maxRetries:1, retryOnNetworkError:false}`, #123, паритет с `ai-price-import`):
    троттл (leaky-bucket) остаётся — он **проактивно** не даёт словить `QUERY_LIMIT_EXCEEDED`, — но ретрай на сетевом
    сбое/5xx выключен, т.к. crm-sync шлёт **неидемпотентные** записи (`crm.activity.configurable.add`, мутации разнесения):
    ретрай после закоммитившегося-но-таймутнувшего запроса **задвоил бы** сущность (Bitrix не enforce-ит уникальность
    маркера в пределах одного вызова). Падаем всей джобой → BullMQ-ретрай **идемпотентен** (read-before-write по маркеру +
    applied-детект мутаций). `setRestrictionManagerParams` async, но конфиг присваивается синхронно (до первого await) →
    fire-and-forget безопасен. `oauthParamsFromToken`/`tokenFromOAuthParams` (наш `PortalToken`↔`B24OAuthParams`, сверено
    `typecheck:server`), `makeSdkRestCall` (полный конверт: `getData()` отдаёт `{result,time}`, поэтому ре-аттачит
    верхнеуровневые `total`/`next` из `getTotal()`/`isMore()` — иначе списковая пагинация `paymentLookup`/
    `negativeStages` молча теряла бы страницы; throw → джоба падает, чистый retry), `buildRefreshPersist`+
    `setCallbackRefreshAuth` (SDK рефрешит → сохраняем свежий), `makePortalSdkCall` (`null` без токена),
    `sdkPortalDeps` (проводка на живой токен-стор, persist `eventTs=0`). `createPortalSdkResolver(deps, now?, ttlMs?)`
    **мемоизирует клиента на портал на короткий TTL** (`SDK_CLIENT_TTL_MS` 60с — **пер-JOB**: вся джоба делит один клиент
    = одно rate-limiter-ведро + одна загрузка токена; от stale-token wedge — два клапана: **evict-on-error** (основной —
    упавший вызов дропает свой клиент, следующая резолюция пересобирает из свежего DB-токена сразу, не дожидаясь TTL) +
    **TTL** (бэкстоп — даже не падавший клиент пересобирается через `SDK_CLIENT_TTL_MS` 60с), `evict` дропает кэш-клиента (cutover на uninstall).
    `crm-sync`-воркер строит один резолвер и переиспользует его во **всех** пер-операционных вызовах (`findCompany`/
    `resolveIntents`/`writeActivity`/`notifyChat`/`applyAllocation`/`notifyError`) **и в гейт-чтении настроек на джобу**
    (`getPortalSettings`→`readAppSettingVia`, `appSettings.ts`). Типизация `new B24OAuth` как `OAuthCallClient` —
    compile-time drift-guard. **Компромисс (осознанный, выбор пользователя):** SDK-рефреш идёт **мимо** advisory-lock
    (`ensureAccessToken`, #35) — проигранная гонка ротации = **транзиентный ретрай BullMQ**, не порча кредов (persist —
    UPDATE-only-эквивалент через tombstone-guarded `saveToken`); advisory-lock остаётся на keep-alive (#175). Прежний
    ручной `callRest`-резолвер (`portalRestResolver.ts`/`portalRest.ts`, bind-once + лок + reactive-retry) **удалён** —
    SDK стал единственным транспортом. Реактивный ретрай `expired_token` теперь у самого SDK — **и для crm-sync, и для
    UI-фрейм-роутов** (`makeFrameRestCall`, `liveDeps.frameRestCall`): сырой `callRest`/`isExpiredTokenError` из
    `b24Rest.ts` **удалены**, от модуля остался только SSRF-гейт (`assertPortalHost`). **Батчинг (`callBatch`):** резолвер отдаёт `batch(memberId)` (`RestBatch`)
    на том же мемоизированном клиенте; `makeSdkBatchCall` — массив команд → `actions.v2.batch.make`
    (`isHaltOnError`+`returnAjaxResult`), конверты per-команда в порядке (с ре-аттачем `total`/`next`), чанкинг по
    `SDK_BATCH_MAX`=50, halt-on-error (падение батча/любой команды → throw, без тихого пропуска). Проведён в
    `negativeStages` (пер-воронковые `crm.status.list` — одним батчем на тип сущности). Детали — `docs/QUEUES.md` §REST-бюджет.
  - **Настраиваемое дело — единственный носитель операции (#259):** `app/utils/configurableActivity.ts` (чистый
    билдер `crm.activity.configurable.add` — `layout` (**required** top-level `icon`=`{code}` + `header` +
    `body.logo` + `text`/`withTitle`-блоки `ContentBlockDto`, сверено с офдокой) + маркер
    `originatorId`=app-namespace/`originId`=ключ операции; внешние поля
    BB-нейтрализованы) → `server/utils/configurableActivityWrite.ts`
    (`writeConfigurableActivityViaRest`, конверт `{result:{activity:{id}}}`). Дедуп — **поиск маркера в B24**
    `server/utils/activityMarkerLookup.ts` (`findActivityByMarker` по паре `ORIGINATOR_ID`+`ORIGIN_ID`; пустой
    маркер → без REST); стора нет, `rememberActivity` убран (маркер пишется атомарно с делом). Прежний
    `crm.activity.todo.add`-путь (`crmActivityWrite.ts`) и билдер `buildTodoActivity` **удалены**.
    **Подтверждено вживую end-to-end** (OAuth-портал `bel.bitrix24.by`, `pnpm activity:test --company 1 --apply`):
    OAuth-транспорт (#191) → `configurable.add` создаёт дело → `findActivityByMarker` находит ровно его
    (дедуп-round-trip). Системные коды: `body.logo='document'`, `icon.code='sum'` (`crm.timeline.logo.list` /
    `crm.timeline.icon.list`). ⚠ **Live-находка (исправлена):** `LayoutDto.icon` — **обязательное** поле (без него
    портал отвергает вызов: «Поле icon в LayoutDto должно быть заполнено»); добавлен `LAYOUT_ICON_CODE='sum'`.
    Пустые внешние поля (физлицо без УНП, комиссия без назначения) билдер **дропает** из `blocks` (портал
    `value:''` терпит — live-probed, но рендерит битую строку; `amount`+`document` всегда есть → layout не пуст).
    Сама запись `configurable.add` — **только OAuth-контекст** (класс #79; `ERROR_WRONG_CONTEXT` вебхуком) →
    смоук `pnpm activity:test` OAuth-кредами.
  - `app/utils/allocationMutation.ts` — **чистый билдер мутации разнесения** (§2 мутационный слайс, #109):
    `buildAllocationMutation(target, opts)` — для `deal-payment` возвращает `{method:'crm.item.payment.pay',params:{id}}`;
    для `invoice` — `{method:'crm.item.update',params:{entityTypeId:31,id,fields:{stageId}}}` **при заданной** стадии
    `opts.invoicePaidStageId` (нет стадии ⇒ `null` — «не указана → не трогаем»). Оба требуют положительный целочисленный
    id (пустой/нечисловой → `null`, не шлём кривой вызов). `deal`/`smart-process` — триггер-цели, у `buildAllocationMutation`
    → `null` (их путь — отдельный триггер-билдер ниже). Без I/O; тесты. **Триггер-билдер (deal/smart-process) — добавлен:**
    `buildTriggerExecution(target, {triggerCode})` → `{method:'crm.automation.trigger.execute',params:{CODE,OWNER_TYPE_ID,OWNER_ID}}`
    (единственные параметры метода — сверено с офдок; доп. сумму/валюту метод НЕ принимает, триггер — просто сигнал «деньги
    пришли»). `OWNER_TYPE_ID`: сделка=2, смарт-процесс=его `entityTypeId` (нет валидного → `null`). CODE по маске
    `[a-z0-9.\-_]` (нет/битый → `null`, «не настроен → не трогаем»); id — положит. целое. amount-цели (invoice/deal-payment)
    → `null`. Без I/O; тесты. +
    `server/utils/allocationMutationWrite.ts` — транспорт `payAllocationViaRest(target, call, opts)`: строит мутацию,
    зовёт метод, **конверт-aware applied-детект** (`callRest` отдаёт полный envelope: `crm.item.payment.pay` →
    `{result:true}`, `crm.item.update` → `{result:{item}}` — оба = `applied`, подтверждено вживую); unsupported-цель →
    без REST-вызова; REST-ошибка **пробрасывается** (джоба ретраится). Тесты. **Транспорт триггера — добавлен:**
    `executeTriggerViaRest(target, call, {triggerCode})` → `crm.automation.trigger.execute` → `{result:true}` (тем же
    билдером; unsupported/нет CODE → без REST-вызова, ошибка пробрасывается). **В hot-path подключён — best-effort (#79):**
    в `crm-sync` за гейтом `autoDistribute`+`triggerCode` вызывается через OAuth-резолвер воркера (контекст приложения
    есть); сбой (в т.ч. незарегистрированный CODE) глотается — триггер сигналит, факт пишется только на firing.
    **Долговременный ретрай — СДЕЛАН (#79):** `applyTrigger` отдаёт `TriggerOutcome` (`fired`/`skip`/`retry`; demo/битый
    CODE/unsupported→`skip`, нет-токена/транзиент/незарег-CODE→`retry`), и на `retry` хендлер кладёт задачу в durable-очередь
    `trigger-fire` (`enqueueTriggerRetry`→`enqueueTriggerFire`), воркер `handleTriggerFireJob` пере-фаерит с backoff — сигнал
    само-заживает (напр. когда админ регистрирует CODE). Проводка `applyTrigger` в воркере вынесена в чистую фабрику
    `server/utils/applyTriggerDep.ts` (`makeApplyTrigger` — demo→skip / нет-токена→retry / best-effort swallow→retry + инвариант
    «полный `target` c `entityTypeId` доезжает до транспорта»); чистый воркер — `server/utils/triggerFireJob.ts`
    (`handleTriggerFireJob`: fired→ack, skipped→drop, иначе throw→BullMQ-ретрай). Покрыты юнит-тестами
    (`tests/applyTriggerDep.test.ts` + `tests/triggerFireJob.test.ts` + проводка `queuePhase2`).
    Регистрация CODE на установке (`crm.automation.trigger.add`, best-effort) — сделана; **регистрация И firing
    подтверждены вживую** (`pnpm trigger:test --apply --fire`, `bel.bitrix24.by`: `trigger.add`→`trigger.list`
    round-trip, затем `executeTriggerViaRest`→`trigger.execute` `{result:true}` на **сделке** (OWNER_TYPE_ID=2) **и
    смарт-процессе** (OWNER_TYPE_ID=его `entityTypeId`=1044); незарегистрированный CODE → `not registered` — валидирует
    best-effort-глоток). Реакция правила автоматизации на CODE — за админом портала (наш код доставляет сигнал).
    CODE хранится в настройках — `allocation.triggerCode` (маска, fail-safe).
  - **Разнесение оплат: серверные модули** (#109) — реестр вынесен в
    [`docs/BACKEND_MAP.md`](docs/BACKEND_MAP.md) (какой файл за что отвечает + живые находки по
    полям и конвертам REST Bitrix24). Нормативная логика — [`docs/PROCESSING.md`](docs/PROCESSING.md)
    §2 (разнесение) и §4 (распознавание). Коротко о слоях:
    - **распознавание** — `app/utils/purposeMatch.ts` (маски) → `identifierDispatch.ts` (вид → куда
      идти) → `recognitionIntent.ts` (композит);
    - **поиск цели** — `server/utils/intentResolver.ts` (диспетчер) над `invoiceLookup`/
      `paymentLookup`/`itemByIdLookup`/`saleLookup`/`documentLookup`, всё скоуплено по компании
      плательщика (IDOR) и отфильтровано по стадиям (`negativeStages.ts`);
    - **решение** — чистый `app/utils/allocation.ts` (`resolveAllocation`/`summarizeAllocation`);
    - **проведение** — `allocationMutation.ts` (билдер) + `allocationMutationWrite.ts` (транспорт),
      за опт-ин гейтом `autoDistribute`; идемпотентность — чтение состояния цели в B24
      (`allocationApplied.ts`), а не собственный факт.
  - `app/utils/chatMessage.ts` — чистый `buildChatMessage(item)` (BB-текст операции для чата) +
    `server/utils/chatNotifyWrite.ts` — `notifyChatViaRest(item, dialogId, call)` (`im.message.add`,
    `URL_PREVIEW=N` → `extractMessageId`, id — целое >0). **Ядро стадии 6** (чат-уведомления), тесты.
    **Безопасность:** назначение/контрагент из выписки контролирует плательщик, поэтому внешние поля
    прогоняются через `neutralizeBb` (BB-скобки → полноширинные; общий с `activity.ts`, где он и определён) —
    иначе `[url=…]`/упоминания/кнопки попали бы в чат. Фильтр «что в чат» — `shouldNotifyChat` (в `statement.ts`). Проводка `notifyChat`
    ждёт хранения настроек (#16: dialog id + правила из `app.option`; see worker TODO про 3 нюанса) —
    до этого заглушка.
  - **Настройка уровня приложения (`app.option`) — серверным REST по токену портала:**
    `server/utils/b24Oauth.ts` (refresh access-токена, `B24_CLIENT_ID/SECRET`, чистые URL/parse),
    `server/utils/b24Rest.ts` (**только SSRF-гейт #149** после jssdk-миграции: `isAllowedPortalHost` —
    fail-closed allowlist хоста портала, облачные `*.bitrix24.<tld>` + self-hosted из env
    `B24_SELFHOSTED_HOSTS`; `assertPortalHost` — единая точка проверки, извлекает хост через `URL` (нет
    parser-differential обхода `x.bitrix24.by@evil.com`) и возвращает **чистый** хост либо бросает.
    Прежний сырой `$fetch`-`callRest`/`restUrl`/таймаут/`[rest-timing]`/`B24RestError`/`isExpiredTokenError`
    **удалены** — весь исходящий B24 REST идёт через jssdk-транспорт `b24Sdk.ts` (crm-sync — stored-token
    `B24OAuth`; UI-фрейм-роуты — `makeFrameRestCall`, тот же SDK за `assertPortalHost`); реактивный ретрай
    `expired_token` и лимитер — у самого SDK. Фрейм-клиент **hard-reject**-ит рефреш (`setCustomRefreshAuth` →
    `FRAME_TOKEN_REJECTED` `invalid_token`), а не шлёт пустой `refresh_token` на OAuth-сервер (нет refresh у
    фрейм-токена → лишний заведомо-провальный round-trip); in-client ретрай на обоих клиентах отключён (#123, выше),
    `server/utils/ensureAccessToken.ts`
    (refresh при истечении, **конкуренто-безопасно (#35)**: рефреш сериализован per-portal через
    pg advisory-lock `server/utils/dbLock.ts` + double-checked re-read внутри лока — при scale-out
    N воркеров рефрешат портал ровно один раз, не гоняясь на ротации refresh-токена; **`{force:true}`** —
    рефреш и при clock-fresh токене (реактивный ретрай после раннего отказа сервера), тем же локом, refresh
    только если stored-токен всё ещё отвергнутый (иначе берём чужой свежий — без лишней ротации); DI + тесты.
    **Сам POST рефреша теперь через jssdk** — `postRefresh` = `sdkRefreshTransport` (`B24OAuth.auth.refreshAuth`,
    `b24Sdk.ts`, bounded `withTimeout` 15с чтобы хунг-OAuth не держал лок); сырого `$fetch` к Bitrix в коде больше
    нет. Advisory-lock (#35) остаётся ровно здесь, т.к. реактивный рефреш SDK его обходит),
    `server/utils/tokenKeepAlive.ts` (**проактивный keep-alive рефреш, #175**: `refresh_token` живёт ~180 д,
    установленный, но **простаивающий** портал не делает REST-вызовов → ленивый рефреш не срабатывает → токен
    молча умирает на 180-й день. Раз в сутки крон `runTokenKeepAlive` рефрешит **только** порталы у истечения:
    `selectTokensNearExpiry` (чистый селектор по `updated_at` — его штампует `saveToken` на install/refresh, это и
    есть «когда получена последняя пара»; порог ~3 д, кап `MAX_KEEP_ALIVE_BATCH`) → на каждый `ensureAccessToken`
    (у простаивавшего портала access давно истёк → рефреш всегда срабатывает, и заодно ленивый лок/идемпотентность).
    Пер-портальные ошибки (dead grant/`PAYMENT_REQUIRED`/удалён) изолированы — логируются, крон не падает. Намеренно
    консервативно (Б24 предупреждает про авто-блок при частом рефреше): раз в сутки, батч-кап, только near-expiry.
    Гейт на `B24_CLIENT_ID/SECRET` (без них рефреш невозможен). DI, тесты `tests/tokenKeepAlive.test.ts`),
    `server/utils/appSettings.ts` (чистые хелперы чтения `app.option`: `pickAppOption` +
    **`readAppSettingVia(call, key)`** — чтение через **уже связанный** jssdk-`RestCall`, ключ передаётся явно
    (`SETTINGS_KEY`), чтобы и гейт-чтение настроек в `crm-sync`, и диагностика делили реактивный ретрай
    `expired_token` SDK, а не грузили/рефрешили токен сами. Прежние `readAppSetting`/`writeAppSetting`/
    `AppSettingsDeps` (свой token-load+`callRest`) **удалены** — запись `app.option` теперь через тот же
    jssdk-транспорт), `server/utils/settingsHandler.ts`
    (чистый `{status,body}` для UI-роутов по фрейм-токену; `SettingsIO.callRest` — DI-порт транспорта,
    в проде связан `frameRestCall`), `server/utils/liveDeps.ts` (проводка: `frameRestCall` — drop-in замена
    сырого `callRest` на jssdk по фрейм-токену; `livePortalSdkCall` — stored-token SDK для серверной работы —
    провижининг/леджер распределения, воркер).
    `settingsHandler` параметризован ключом `app.option` (`key` обязателен; чат-настройки — `SETTINGS_KEY`).
    **Admin-гейт записи (#182, порт из `ai-price-import`):** `handleWriteSetting` — **единственный choke point**
    записи `app.option` — перед `app.option.set` делает `verifyFrameAdmin` (один `profile`-вызов: доказывает
    контроль портала фрейм-токеном **и** читает `profile.ADMIN` строго `=== true`); не-админ → **403**, сбой/
    отвергнутый токен → 502 (fail-closed, запись не идёт). Гейтит роут записи `chat-settings.post`
    (арм `autoDistribute`/карта распознавания/чат-цели). Клиентский `useIsAdmin`
    (прячет форму) — **косметика**; авторитет — здесь (иначе любой пользователь портала или реплей фрейм-токена
    взвёл бы мутации CRM). Token-only, без `member_id`/install-зависимости — install-гонка/purge не отвергают
    валидного админа (`app.option` скоуплен фрейм-токеном). Зеркалит `profile.ADMIN`-гейт `/api/bank/connect`.
    **`metrics-reset.post` тоже admin-only (#182 паритет):** `handleMetricsReset` гейтит обнуление счётчиков на
    `profile.ADMIN` (`validateFrame` отдаёт `{userId,isAdmin}` за один `profile`-вызов, `requireAdmin` в
    `authMember`); не-админ → **403, без reset**. `GET /api/import/metrics` (чтение) — **не** гейтится (member-scoped
    инфо, любой пользователь портала).
  - **Настройки чата (#16 PR-C) — фрейм-токеном под `SETTINGS_KEY`:** `server/api/chat-settings.get.ts`/
    `.post.ts` читают/пишут весь `PortalSettings`-JSON (чат уведомлений + правила + **чат ошибок** +
    **`recognition`** — матрицы/алфавит/карта полей §4 + **`autoDistribute`** — гейт мутации §2), нормализуя через
    `parsePortalSettings` (никогда не пишем мусор); воркер читает тот же ключ/форму. Чистое ядро схемы —
    `app/utils/settings.ts` (`PortalSettings`/`RecognitionSettings`, `parsePortalSettings` — защитный коэрс любого
    поля к дефолту, не бросает; `recognition` растёт без миграции ключа `app.option`; матрицы/карта клампятся по
    DoS-капам `purposeMatch`; **`autoDistribute` — только литерал `true` включает** (любое иное → OFF, fail-safe:
    битый блоб не вооружит мутацию портала)). `recognition` предназначен для `recognizeByMatrices` (§4) — сама проводка (матрицы/
    алфавит из настроек → распознавание) описана в [`docs/BACKEND_MAP.md`](docs/BACKEND_MAP.md).
    Поиск чатов для пикера — `server/utils/chatSearch.ts` (чистое ядро над `RestCall`: `im.search.chat.list`
    для запроса ≥3 симв., `im.recent.list` для дефолтного списка недавних групп; только куда можно писать;
    `nextOffset`-курсор) + роут `server/api/chat-search.get.ts` (фрейм-токен). UI-пикер — `AsyncSearchSelect`
    (+ `useRemoteSearch`/`app/utils/remoteSearch.ts`: дебаунс, гонка, курсор-пагинация, «Показать ещё»).
  - **Оценка приложения в Маркете («оцените приложение»)** — [`docs/APP_RATING.md`](docs/APP_RATING.md)
    (порт `ai-price-import` #199/#204, домен свой). Ненавязчивый попап `AppRatingModal.vue` (на `B24Modal`,
    `useAppRating`) на `/import`: всплывает **после успешной записи в CRM** (`ratingTrigger` в
    `StatementUpload`), по «Оценить» открывает листинг Маркета через `frame.slider.openPath`
    (`marketDetailPath` в `config/b24.ts`, код — `LANDING_MARKET_CODE` `shef.bankimport`, override
    `NUXT_PUBLIC_B24_MARKET_CODE`). **Решение показа — на сервере, рядом с авторизацией** (таблица
    `portal_app_rating`, ключ `member_id`; чистая `shouldPrompt` в `appRatingPolicy.ts` — троттл
    `RATING_REPROMPT_DAYS`=4д по `prompted_at`, глушение до ручной проверки по `opened_at`, `reviewed`
    терминально). Роуты `GET/POST /api/app-rating` по **фрейм-токену** (`Bearer`+`X-B24-Domain`, чистое
    ядро `appRatingHandler.ts`, DI+тесты; `member_id` из проверенного домена). Факт отзыва Маркет по REST
    не отдаёт → владелец подтверждает **из UI оператора** (`/queues`, карточка «Оценки приложения»,
    `useAppRatingOps`): `GET/POST /api/ops/app-rating` (сессия оператора + CSRF `X-CBA-Auth`, чистые
    `appRatingStatus.ts`/`appRatingOpsHandler.ts` → `markReviewed`/`clearOpened`). Стор
    `appRatingStore.ts` (наш array-`QueryFn`); удаление приложения чистит (`deleteRatingForPortal` в
    `deletePortal` воркера). Гифка-подсказка `public/app-rating-demo.gif` (ленивая загрузка).
  - Backend — отдельный docker-сервис (`Dockerfile` target `backend`, `nuxt build`), Postgres рядом.
    В проде — **один домен**: nginx `app` проксирует `/api/*` в `backend:3000` (вебхук B24 на
    `https://<DOMAIN>/api/b24/events`, без CORS); CI пушит два образа (matrix `runner`+`backend`),
    `docker-compose.prod.yml` поднимает `app`+`backend`+`db`. Деплой/контракт —
    [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md), [`docs/DEPLOY.md`](docs/DEPLOY.md).

  Ссылки на доку Альфы — [`docs/ALFA_API.md`](docs/ALFA_API.md); по Приорбанку/текстовой выписке —
  [`docs/PRIOR_API.md`](docs/PRIOR_API.md).
- **Дев-скрипты** (разведка банков, посев тестового портала, живые прогоны записи) — вынесены в
  [`docs/DEV_SCRIPTS.md`](docs/DEV_SCRIPTS.md): таблица всех команд с пометкой, какая **пишет** в
  портал, и подробности по каждой. Креды живут в git-ignored `.env.*`, в репозиторий не попадают.
- `tests/*.test.ts` — Vitest (node) на чистые утилиты.
- `tests/nuxt/**/*.test.ts` — Vitest (проект `nuxt`) на компоненты/страницы (`mountSuspended`).

Чистую логику выносим в `app/utils/*` и покрываем тестами; реактивную — в `app/composables/*`,
UI — в компонентах. Это та же раскладка, что в `currency-converter` — держим её при развитии.

## Встройка в Bitrix24 (этап 2)

Приложение работает в двух режимах: standalone (публичный лендинг `/`) и как iframe-приложение
внутри портала (`/app`, `/import`, `/install`). SDK — `@bitrix24/b24jssdk` (+ `-nuxt`).

- `useB24().init()` молча no-op вне фрейма (нет `window.name`), но сами in-portal-страницы (`/app`,
  `/import`, `/install`) закрыты общим **`InPortalGate`** (#414): снаружи портала показывается
  объяснение вместо неработающего интерфейса (там нет фрейм-токена — ни настроек, ни статуса, ни
  записи в CRM). Штатный обход для разработки, скриншотов и тестов — **`?preview=1`**; флаг читается
  ИЗ РОУТЕРА, а не из `window.location` (на гидратации пререндеренной страницы строка запроса пуста).
  Чистое ядро решения — `app/utils/inPortalGate.ts` (`portalGateState` checking/ok/outside +
  `isPreviewQuery`, тесты `tests/inPortalGate.test.ts` и `tests/nuxt/inPortalGate.nuxt.test.ts`).
  ⚠ Это UX-заглушка, **не** авторизация: настоящая граница — фрейм-токен на сервере.
- `/install` делает `init → event.bind (ONAPPINSTALL/ONAPPUNINSTALL) → installFinish` + диагностику.
  Привязка событий — до `installFinish`, чтобы текущая установка доставила `application_token`
  на backend `/api/b24/events`. **`placement.bind` не вызываем** — как именно приложение встроено
  (плейсменты) зависит от регистрации; финализируем на тестовом портале. `NUXT_PUBLIC_SITE_URL`
  (build-arg) в проде **обязателен** — из него строится абсолютный URL хендлера событий (без него
  `/install` откажется биндить относительный URL и покажет ошибку с retry).
- **Вызовы B24 для данных/настроек — server-side REST по OAuth-токену (backend), не через фрейм** (см.
  «Хранение настроек» в [`docs/REFACTOR_PLAN.md`](docs/REFACTOR_PLAN.md)). Фрейм-SDK тут — только установка
  и UI-хром (`setTitle`/`fitWindow`). **Учёт всех REST-вызовов** (метод, поколение/версия, scope,
  транспорт фрейм/сервер, файл-владелец, батч) — [`docs/REST_METHODS.md`](docs/REST_METHODS.md); правим
  при добавлении/замене метода (для точечной миграции при депрекейте).
- **Серверные события — отдельный механизм** (не фрейм-`/install`): исходящие вебхуки Б24
  `ONAPPINSTALL`/`ONAPPUNINSTALL` на backend (`server/api/b24/events.post.ts`) дают `application_token`
  (подпись событий) и OAuth-креды портала; токены пишутся в Postgres (`server/utils/tokenStore.ts`).
  Доменное ядро (разбор, вердикт токена, маршрутизация) — `app/utils/b24Events.ts`; контракт и
  модель учёта авторизации — [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md).
- Тесты: чистый `tests/b24.test.ts` (скоупы) + `tests/b24EventBind.test.ts` (билдер привязок —
  свежая установка/идемпотентность/перепривязка/чужие события/регистр); `tests/nuxt/install.nuxt.test.ts`
  (standalone-редирект + `event.bind` двух событий на `…/api/b24/events` до `installFinish`) через
  типизированный мок `tests/nuxt/helpers/mockB24.ts` (`makeMockB24`, `ReturnType<typeof useB24>`
  ловит дрейф). Реальный install-flow в портале автотестами не покрыть — проверяется вручную.
- CSP в `nginx.conf` уже разрешает облачные домены Б24 (`frame-ancestors`/`connect-src`).

## Настройка репозитория

- **В main не пушим — только через PR.** Защита `main` (ruleset `protect-main`) и CI как
  required-check настраиваются владельцем репо по [`docs/REPO_SETUP_CHECKLIST.md`](docs/REPO_SETUP_CHECKLIST.md).
- `.github/workflows/ci.yml` — пайплайн `CI/CD`: job `ci` (lint → test → typecheck → generate),
  `docker-build` (валидирует сборку образа на каждом PR, без push) и `deploy` (push в GHCR на
  `main`, gate по зелёному `ci`). Имя `ci` — то, что включается в required status checks ruleset'а.
  Сторонние actions запинены на commit SHA (issue #2; SHA обновляет Dependabot по комментарию `# vX.Y.Z`).
- `.github/dependabot.yml` — обновления `npm`, `github-actions` и `docker` (база `node` / `nginx-unprivileged`;
  major `node` игнорируется — 25+ убрал corepack).
- `.claude/` — SessionStart-хук (`hooks/session-start.sh`): в веб-сессиях Claude Code ставит
  зависимости и гоняет `nuxt prepare`, чтобы lint/typecheck/test/build работали с первого хода.

## Визуальная верификация (Definition of Done)

> **ВАЖНО:** после любой правки UI/CSS/вёрстки снять скриншот результата и
> посмотреть на пиксели **до** того, как считать задачу выполненной — не доверять
> «собралось без ошибок». `pnpm generate && pnpm screenshot` → смотреть
> `screenshots/` (mobile/desktop × light/dark). Детали и чек-лист —
> [`docs/VISUAL_VERIFICATION.md`](docs/VISUAL_VERIFICATION.md).

OG-картинка (`public/og.png`, 1200×630) генерируется из HTML-шаблона через
пред-установленный Chromium — `pnpm og` (`scripts/make-og.mjs`); коммитим как
статику. Перегенерировать при смене заголовка/брендинга.

## Деплой

Фронтенд (лендинг + B24-iframe-UI) деплоится как статика за nginx — по той же схеме, что
`currency-converter`: **GHCR + Watchtower за общим nginx-proxy**. Подробности — [`docs/DEPLOY.md`](docs/DEPLOY.md)
(как деплоить) + [`docs/OPERATIONS.md`](docs/OPERATIONS.md) (пост-запускной runbook: health, диагностика
очередей, откат, эскалация — #246).

- Прод-образ — `nginxinc/nginx-unprivileged` (non-root, слушает `:8080`), статика из `nuxt generate`.
- CSP отдаётся **без** `script-src 'unsafe-inline'`: два inline-скрипта Nuxt (`theme-init` в `app.vue`
  и `window.__NUXT__.config` с меняющимся `buildId`) разрешаются по sha256-хэшам, которые
  `scripts/csp-hashes.mjs` считает из собранного HTML и подставляет в `nginx.conf` (плейсхолдер
  `__CSP_SCRIPT_HASHES__`) на этапе сборки. `frame-ancestors`/`connect-src` разрешают облачные
  домены Б24 (iframe-встройка `/app`,`/import`,`/install`); backend — **тот же origin** (`/api/*`, покрыт `'self'`).
  Лендинг несёт **Яндекс.Метрику** (инлайн-счётчик из `nuxt.config.ts`, `NUXT_PUBLIC_METRIKA_ID`;
  его sha256 подхватывает `csp-hashes.mjs`, CSP разрешает `mc.yandex.ru` в script/img/connect/frame-src)
  и **встроенную CRM-форму Б24** (iframe на `public/b24-form.html` со своим form-scoped CSP —
  `location = /b24-form.html`; `NUXT_PUBLIC_B24_FORM_*`, пустые → слот).
  Метрика-сниппет **самозаглушается в iframe** (`window.self !== window.top`): in-portal-страницы
  (`/app`,`/import`,`/install`) внутри портала Б24 Метрику **не** инициализируют — иначе webvisor
  писал бы session-replay CRM клиента, а цели пачкали бы аналитику лендинга портальным трафиком
  (`ym` тогда не определён → `useMetrikaGoal` no-op). Тот же приём, что в `currency-converter`
  (там — в `public/metrika.js`).
  `POST /api/auth/login` дросселируется `limit_req` (зона `login`, ~10r/m по IP клиента через
  `real_ip` из `X-Forwarded-For`, `burst=5 nodelay` → 429) — антибрутфорс общего пароля оператора (#64, см. `docs/AUTH.md`).
- `docker-compose.yml` — локальная сборка: `app` (статика лендинга, nginx), `backend` (node-сервер,
  эндпоинт вебхуков Б24) и `db` (Postgres). `docker-compose.prod.yml` — прод `app`+`backend`+`db`
  (GHCR-образы + Watchtower за nginx-proxy); один домен — nginx `app` проксирует `/api/*` в backend.
  Общий reverse-proxy (`nginx-proxy` + `acme-companion`, сеть `proxy-net`) ставится на сервере один
  раз — см. `currency-converter/docker-compose.nginxproxy.yml`, не дублируем здесь.
- **Backend** — `Dockerfile` target `backend` (`nuxt build`, node-сервер). Приём событий Б24 и хранилище
  токенов **реализованы** (этап 3, слайс; #35); OAuth Альфы/опрос/дела/чат — далее (этапы 4–6). Env и
  запуск — `.env.example`, [`docs/DEPLOY.md`](docs/DEPLOY.md), [`docs/B24_EVENTS.md`](docs/B24_EVENTS.md).
- **Альтернативный таргет — Битрикс24 Вайбкод Black Hole** (закрытый Bitrix-Cloud VM по REST, без SSH,
  приложение **одним Nitro-процессом на :3000**): [`docs/DEPLOY_VIBECODE.md`](docs/DEPLOY_VIBECODE.md).
  `deploy/vibecode-deploy.sh` (идемпотентный: найти сервер по имени / создать / ждать `CONNECTED` /
  `access-policy=PUBLIC` / deploy) + `.github/workflows/deploy-vibecode.yml` (**opt-in**: джоба идёт
  только при repo-переменной `VIBECODE_DEPLOY==true`, основной GHCR/Watchtower-путь не трогает).
  Один Nitro отдаёт **и лендинг, и `/api/*`** (проверено: `nuxt build`→`node .output/server/index.mjs`
  → `/`,`/api/health`,`/import` = 200); pg/redis провижнятся на VM в `preStart`, миграции в процессе на
  старте. **Паритет безопасности без nginx — закрыт (гейт `SECURITY_HEADERS_ENABLED=1`, ставит только
  Black Hole):** Nitro-плагин `server/plugins/securityHeaders.ts` (хук `beforeResponse` → заголовки на
  **всех** ответах, включая пререндеренные статические страницы, куда `server/middleware/` не достаёт) +
  мидлвар `server/middleware/loginRateLimit.ts` (троттл POST `/api/auth/login`, ~10/мин на IP). Чистые ядра
  `securityHeaders.ts`/`loginRateLimit.ts` (юнит-тесты); за флагом OFF (nginx-путь) — полный no-op, проверено
  рантайм-смоуком (заголовки на `/`+`/import`+`/api`, 429 на 11-й попытке; OFF → 0 заголовков, без 429).
  ⚠ CSP **слабее** nginx-овой (без хеш-пайплайна `script-src` с `'unsafe-inline'`; остальные директивы те же).

## Отчётность (reporting-kit)

Вендорный бандл для работы с AI-агентом и отчётов в Telegram — в
[`reporting-kit/`](reporting-kit/) (карточка интеграции —
[`docs/REPORTING_KIT.md`](docs/REPORTING_KIT.md)). Держим как есть для синхронизации
с источником; у него **свои конвенции и свой CI**, поэтому он **не линтуется**
нашими проверками: исключён из ESLint и `tests/mdReviewStamp.test.ts`, добавлен в
`.dockerignore` (чтобы не попадал в Docker-образ). Навыки `/report-status`,
`/report-digest`, `/report-questions` и `tg-send.sh` — внутри бандла. Telegram
пока не заведён (нужен `.env` с токеном, локально, см. README кита).

Канонический **срез состояния проекта** (цель/шаги/сделано/дальше/блокеры) — [`docs/project-map.md`](docs/project-map.md);
на него опираются `/report-status` и `/report-questions`. Держим синхронно с `REFACTOR_PLAN.md`.

## Обратная связь (feedback-triage)

Сбор отзывов и их разбор в бэклог — портированный «feedback-triage kit», адаптированный
под наш домен. **Статус:** **базовый канал «сотрудник» реализован** (порт из `ai-price-import`)
**+ телеметрия 👍/👎** (#195: счётчики `feedback_up`/`feedback_down` в `metrics_counter`, видны в
`GET /api/import/metrics`) **+ вложение файла выписки по согласию** (#198: тумблер `B24Checkbox` в
👎-панели на `/import` → сырой текст выписки в приватный issue `<details>`-блоком, инертен, кап
`MAX_FILE_EMBED`); ссылка на сущность (#197) **сознательно пропущена** (импорт fire-and-forget,
`jobId→сущность` нет) **+ программа-канал (MVP)** — воркер `crm-sync` заводит `agent-feedback` issue,
когда «запутался» (`unmatched`/`ambiguous`/`manual`): чистый билдер `app/utils/programFeedback.ts`
(non-PII: только счётчики + `member_id` + sha) + гейт дедуп-по-корню + кап 10/час
`server/utils/programFeedbackCap.ts` (Redis `SET NX`/`INCR`, DI+тесты). **Три сигнала — union
`ProgramSignal`** (`confusion` счётчики / `fail-open` сущности / `format` провайдер), общий хелпер
`fileProgramSignal` в `worker.ts` в трёх точках (crm-sync хвост / `loadNegativeStagePredicate` /
`file-parse` catch), дедуп-сигнатура с неймспейсом по типу. **`confusion` несёт редактированный сэмпл
операции** (`makeProgramSample`, первый запутавшийся op → `signal.sample`, инертный рендер) — это ПДн,
только в приватный репо; `fail-open` — non-PII. **`format` несёт сам файл, который не разобрался**
(file-parse-воркер декодирует `contentBase64` из джобы в `catch` → `signal.fileText`, общий рендер
`fileEmbedLines` — инертный `<details>`-блок, кап `MAX_FILE_EMBED`) — тоже ПДн, только в приватный репо.
Футер issue честно помечает «содержит данные клиента» (`confusion`+sample / `format`+file) vs non-PII. Два дока:
- **Базовый канал «сотрудник» (реализовано):** виджет `app/components/FeedbackWidget.vue` (+
  `useFeedback.ts`) на `/app` под полосой статуса **и на `/import`** (под разбором, с файл-вложением) —
  👍 шлёт сразу, 👎 сперва открывает поле комментария. **Файл-вложение (#198):** проп `fileText`
  (декод выписки, `decodeUploadText` из `importUpload.ts`) включает в 👎-панели тумблер согласия
  (`B24Checkbox`, default OFF); при галке сырой текст выписки едет в `context.fileContent` (клиент
  ставит `attachFile:true`, сервер гейтит именно по нему). Рендерится только когда канал включён на
  сервере (`GET /api/feedback {enabled}`), инертен вне портала. Приём — `POST /api/feedback`
  (фрейм-токен `Bearer`+`X-B24-Domain`, `member_id` из проверенного домена, `profile`-валидация; чистый
  `server/utils/feedbackHandler.ts`, DI+тесты) → `buildFeedbackIssue` (`app/utils/feedback.ts` —
  **security-critical санитизация**: Trojan-Source strip по код-поинтам, HTML-escape комментария в
  `<pre><code>`, контекст в inline-code-span против markdown-инъекции; **файл выписки** — strip
  контролов с сохранением переносов + `escapeHtml` (нельзя закрыть `</code></pre>`) + кап
  `MAX_FILE_EMBED`, в `<details>`-блоке) → `postFeedbackIssue` (`server/utils/feedbackGithub.ts`, GitHub REST, не логирует
  токен/URL/тело) в **приватный** репо `GITHUB_FEEDBACK_REPO`. **Durable outbox (#61):** happy-path не тронут
  (201 GitHub → синхронный 200 с номером issue); при **транзиентном** сбое (5xx/429/сеть — раньше тупиковый 502)
  роут кладёт **уже собранный** issue в очередь `feedback-post` (`enqueueFeedbackPost`, `FEEDBACK_RETRY_OPTS` —
  8 попыток, экспон. backoff 30с) и отдаёт **202** (отзыв переживёт блип GitHub / закрытие вкладки); воркер
  `handleFeedbackPostJob` ретраит (throw → BullMQ-ретрай), на успехе бампит #195-метрику, перманентный 4xx —
  дроп; без Redis — фолбэк на прежний 502. `contentHash` (sha256 payload) дедупит двойной сабмит. Санитайзер и
  auth — по-прежнему **синхронно** в роуте (в очередь едет только обезличенный/санитизованный payload).
  **Телеметрия (#195):** на успешно
  заведённом issue `feedbackHandler` best-effort бампит `FEEDBACK_METRICS.up`/`.down`
  (`feedback_up`/`feedback_down` в `metrics_counter` — **отдельно** от summary-bound `METRICS`, т.к.
  считаются из роута, а не из crm-sync summary; оба 👍/👎, видны в `GET /api/import/metrics`). Конфиг
  `server/utils/feedbackConfig.ts` — **fail-closed**: без `GITHUB_FEEDBACK_TOKEN`+`GITHUB_FEEDBACK_REPO`
  канал OFF (виджет скрыт, POST → 503), репо никогда не дефолтится на публичный. Роут дросселируется
  nginx `limit_req` (зона import). Тесты — `feedback`/`feedbackConfig`/`feedbackGithub`/`feedbackHandler`
  (+ метрика + outbox 202/502/500-пути) + `feedbackPostJob` (воркер outbox) + `queueTopology` (`feedbackPostJobId`)
  + `nuxt/feedbackWidget` + `metricsStore` (feedback-счётчики).
- [`docs/FEEDBACK.md`](docs/FEEDBACK.md) — **дизайн канала**: два источника отзывов —
  **сотрудник** (👍/👎 на `/app`, ✅ реализован) и **программа** (воркер `crm-sync`, когда «запуталась»:
  `unmatched`/`ambiguous`/`manual`/не-распознан-формат — в бэклоге). Каждый отзыв → issue в **приватном**
  репо-приёмнике (ENV `GITHUB_FEEDBACK_REPO` — отдельный приватный репо, в код не вшит) **с приложенным
  файлом выписки** (для воспроизведения; приватность позволяет — сделано: сотрудник по согласию #198,
  программа-`format` берёт файл из упавшей джобы).
- [`docs/FEEDBACK_TRIAGE_AGENT.md`](docs/FEEDBACK_TRIAGE_AGENT.md) — **роль ИИ-агента триажа**:
  группирует отзывы по корню, заводит обезличенные инженерные issue в `bx-shef/client-bank-alfa-by`,
  закрывает разобранное со связкой. **Privacy-guard:** клиентские данные/файл из приватного
  отзыва **не** переносятся в (потенциально публичный) репо задач — только ссылка.

Запись issue (создание/комментирование/закрытие) делает сам ИИ-агент **GitHub-инструментами
своей среды** (Claude Code / Claude-in-GitHub; MCP в проекте не настроен и не требуется,
отдельный PAT не нужен). Прежний REST-fallback (`scripts/feedback-triage.sh` + офлайн-валидатор
`validate-docs.sh`/`.ps1`) удалён за ненадобностью.
Репо-координаты — через ENV (`PROJECT_REPO`/`FEEDBACK_REPO`/`GITHUB_FEEDBACK_REPO`), не
хардкодятся.

## Маркетинг и продажи

Документы привлечения клиентов (не часть SSG/кода, опора для лендинга и оффера):
[`docs/POSITIONING.md`](docs/POSITIONING.md) — позиционирование, ICP, отстройка от
конкурентов; [`docs/MARKETPLACE_LISTING.md`](docs/MARKETPLACE_LISTING.md) — текстовки
карточки Маркета Bitrix24; [`docs/MARKETPLACE_SUBMISSION_CHECKLIST.md`](docs/MARKETPLACE_SUBMISSION_CHECKLIST.md) —
пошаговый чек-лист сабмита (гейты, owner-блоки, объём v1.0); [`docs/PARTNERS.md`](docs/PARTNERS.md) — данные для
интеграторов (субподряд); [`docs/PRICING.md`](docs/PRICING.md) — калькулятор цены
внедрения и сопровождения (ставки, фикс-пакеты, примеры). Бэклог — issue #222.

## Конвенции

- Комментарии и JSDoc — на английском; пользовательский текст и README — на русском.
- Чистые функции — в `app/utils/*`, данные/константы — в `app/config/*` (уже есть:
  `banks.ts`), типы — в `app/types/*`; всё покрываем тестами. Реактивную логику — в
  `app/composables/*` (появится по мере роста), UI — в компонентах/страницах.
- Данные из API рендерим только через `{{ }}` (auto-escape) — никакого `v-html` с внешними данными.
- **Телеметрия (#78) — обязательное покрытие новых путей:** любой новый **job-воркер** очереди
  оборачивается в `withSpan('<job>', {безопасные атрибуты}, …)` (как `crm-sync`); любая новая **обёртка-транспорт
  зависимости, которую пишем мы** (B24 REST/батч, банк-API-клиент, OAuth-refresh) — в
  `withDependencySpan({system, operation,…})` (сырой `$fetch`/`axios` **уже** ловит авто-undici/http — его **не**
  оборачиваем повторно, иначе задвоение); новый **крон-тик** — в `withSpan('cron.<name>', …)`; новый **фрейм-токен
  HTTP-роут** — в `withFrameRouteSpan({name:'http.<route>.<verb>', method, op, domain}, …)` (`server/utils/frameRouteSpan.ts`;
  `span.outcome` = `httpOutcomeForStatus(status)`, тело запроса/ответа в спан не кладём). Атрибуты спанов ставим **только** ключами из allowlist
  `SAFE_MANUAL_ATTR_KEYS` (`telemetryAttributes.ts`) — форма/счётчики/`portal.hash`, **никогда** назначение/сумма/
  счёт/контрагент/УНП (финансовые ПДн, `docs/PRIVACY.md`); новый безопасный ключ добавляем в allowlist явно. Ошибки
  метим `error_kind` (класс, не текст). Всё — no-op когда телеметрия выключена (спаны `@opentelemetry/api`), так что
  оверхеда без коллектора нет. Карта покрытия/детали — [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md).
- Штамп ревью: каждый `.md`-документ в корне и `docs/` несёт строку `> Last reviewed: YYYY-MM-DD`
  блок-цитатой сразу под заголовком H1. Ключ `Last reviewed` всегда на английском (технический
  маркер). Дату бампим только при содержательном изменении. Наличие штампа во всех отслеживаемых
  `.md` (кроме вендорного `reporting-kit/`) проверяет `tests/mdReviewStamp.test.ts`.
