# Third-party notices — сторонние компоненты и их лицензии

> Last reviewed: 2026-07-03

Это приложение (лендинг SSG + B24-iframe-UI + backend Nitro) распространяется вместе
со сторонними компонентами с открытым исходным кодом. Ниже — обязательные уведомления
об авторских правах и лицензиях. Само приложение — под MIT (см. [`LICENSE`](LICENSE),
© 2026 Igor Shevchik).

Полные тексты лицензий каждого пакета лежат в его каталоге `node_modules/<пакет>/LICENSE`;
полный список зависимостей с лицензиями воспроизводится командой
`pnpm licenses list --prod`. Ниже перечислены значимые компоненты, попадающие в
распространяемые артефакты (браузерный бандл лендинга/UI и backend-образ), сгруппированные
по лицензии.

---

## Apache License 2.0

Полный текст: <https://www.apache.org/licenses/LICENSE-2.0>. Копия — в
`node_modules/echarts/LICENSE`.

**Apache ECharts** несёт файл NOTICE — Apache-2.0 §4(d) обязывает воспроизвести его.
Воспроизводим дословно:

```
Apache ECharts
Copyright 2017-2026 The Apache Software Foundation

This product includes software developed at
The Apache Software Foundation (https://www.apache.org/).
```

Другие компоненты под Apache-2.0 (без собственного NOTICE), попадающие в бандл:

- **zrender** — движок отрисовки ECharts (© Baidu / Apache ECharts contributors).
- **@internationalized/date**, **@internationalized/number** — © Adobe (через Bitrix24 UI).
- **fuse.js** — © Kiro Risk (через Bitrix24 UI).
- **colortranslator** — © Sergio Marín (через Bitrix24 UI).
- **@swc/helpers** — © 강동윤 (kdy1) / SWC contributors.

---

## SIL Open Font License 1.1 (OFL-1.1)

Полный текст: <https://openfontlicense.org>. Копии — в
`node_modules/@fontsource/rubik/LICENSE` и `.../roboto-mono/LICENSE`. Лендинг
использует **self-hosted шрифты**, поэтому файлы шрифтов распространяются вместе с сайтом.

- **Rubik** — Copyright 2015 The Rubik Project Authors
  (<https://github.com/googlefonts/rubik>).
- **Roboto Mono** — Copyright 2015 The Roboto Mono Project Authors
  (<https://github.com/googlefonts/robotomono>).

Оба поставляются через пакеты `@fontsource/*`. Шрифты используются без изменений; по OFL
их нельзя продавать отдельно и нельзя использовать зарезервированные имена шрифтов для
модифицированных версий.

---

## MIT License

Требуется сохранить копирайт и текст разрешения (каждый — в своём
`node_modules/<пакет>/LICENSE`). Значимые компоненты в бандле/образе:

- **Vue** — © Yuxi (Evan) You и контрибьюторы Vue.
- **Nuxt** — © Nuxt contributors.
- **Tailwind CSS** — © Tailwind Labs, Inc.
- **@vueuse/core** — © VueUse contributors (Anthony Fu и др.).
- **Bitrix24 UI** (`@bitrix24/b24ui-nuxt`), **b24icons-vue**, **@bitrix24/b24jssdk(-nuxt)** —
  © 2024 Bitrix24.
- **qrcode** — © Ryan Day (визитка на лендинге).
- **BullMQ** — © Taskforce.sh Inc. (очереди backend).
- **node-postgres** (`pg`), **ioredis** — © соответствующие авторы (backend).

---

## Прочие пермиссивные лицензии

Часть транзитивных зависимостей — под другими пермиссивными лицензиями (BSD-2/3-Clause,
ISC, 0BSD, BlueOak-1.0.0, CC0-1.0, а также двойные `MIT OR CC0-1.0`,
`BSD-3-Clause OR GPL-2.0` — для двойных выбираем пермиссивную сторону). Все — с
сохранением копирайта; тексты — в `node_modules/<пакет>/LICENSE`. Копилефт-лицензий
(GPL/LGPL/AGPL/MPL) в распространяемых артефактах нет.

---

**Как поддерживать этот файл.** При добавлении/смене рантайм-зависимости — свериться с
`pnpm licenses list --prod` и обновить раздел; для новых Apache-2.0-компонентов проверить
наличие `NOTICE` (его нужно воспроизвести) и для шрифтов — OFL-атрибуцию.
