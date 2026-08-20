<script setup lang="ts">
import { computed } from 'vue'
import ArrowTopSIcon from '@bitrix24/b24icons-vue/outline/ArrowTopSIcon'
import ArrowDownSIcon from '@bitrix24/b24icons-vue/outline/ArrowDownSIcon'
import EmptyMessageIcon from '@bitrix24/b24icons-vue/outline/EmptyMessageIcon'
import type { StatementItem } from '~/types/statement'
import { makeProgramSample } from '~/utils/programFeedback'

// Statement operations as a compact, scannable list (modelled on the Bitrix24 /
// Alfa "Последние операции" view): rows grouped by day, a direction tile
// (↑ приход / ↓ расход), counterparty + purpose, the amount as the coloured
// accent, and a row that expands to the operation's requisites.
const props = defineProps<{
  items: StatementItem[]
  /** Сколько строк держать по высоте, даже если их пришло меньше (страница пагинации).
   *  Ноль/не задано — не резервировать. */
  reserveRows?: number
}>()

const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const groupFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' })
const dateTimeFmt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
// Day key in the SAME (local) timezone as the group label, so the key and the
// rendered date can't drift across a UTC midnight (`en-CA` → `YYYY-MM-DD`).
const dayKeyFmt = new Intl.DateTimeFormat('en-CA')

function fmt(iso: string, f: Intl.DateTimeFormat): string {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : f.format(t)
}

/** Requisites shown when a row is expanded (empty fields dropped). */
function requisites(item: StatementItem) {
  return [
    { label: 'Корреспондент', description: item.counterparty.name, orientation: 'horizontal' as const },
    { label: 'Счёт корреспондента', description: item.counterparty.account, orientation: 'horizontal' as const },
    { label: 'УНП', description: item.counterparty.unp, orientation: 'horizontal' as const },
    { label: 'Банк корреспондента', description: item.counterparty.bank, orientation: 'horizontal' as const },
    { label: 'Наш счёт', description: item.account, orientation: 'horizontal' as const },
    { label: 'Дата операции', description: fmt(item.acceptDate, dateTimeFmt), orientation: 'horizontal' as const },
    { label: '№ документа', description: item.docNum || item.docId, orientation: 'horizontal' as const },
    { label: 'Код операции', description: item.operCodeName, orientation: 'horizontal' as const },
    { label: 'Назначение', description: item.purpose, orientation: 'horizontal' as const }
  ].filter(r => r.description)
}

/** One display row — direction presentation computed once (not per template use). */
function toRow(item: StatementItem) {
  const credit = item.direction === 'credit'
  return {
    key: `${item.account}|${item.docId}`, // dedup convention: docId unique per account
    icon: credit ? ArrowTopSIcon : ArrowDownSIcon,
    // ⚠ Токен на тему: `accent-main-*` в b24ui — цвет ЗАЛИВКИ, а не текста, и на белом даёт
    // 2.07:1 (приход) и 3.12:1 (расход) при пороге 4.5:1 — то есть самый важный элемент строки,
    // сумма, читался бы хуже всего. Для светлой берём тёмные концы палитры (4.77 / 6.07), для
    // тёмной — те же `accent-main-*` (5.27 / 4.14), они там как раз text-grade.
    tint: credit
      ? 'text-(--ui-color-green-90) dark:text-(--ui-color-accent-main-success)'
      : 'text-(--ui-color-red-80) dark:text-(--ui-color-accent-main-alert)',
    // Плитка направления КРАСИТСЯ, а не остаётся нейтральной. Раньше она брала общий серый токен, и
    // приход от расхода отличался только мелкой стрелкой внутри — при том что сумма справа уже была
    // цветной. Получалось, что один и тот же признак на одной строке заявлен дважды и по-разному:
    // справа явно, слева никак. Цвет — не единственный носитель: стрелка ↑/↓ и знак у суммы
    // остаются, поэтому строка читается и без различения цветов.
    tile: credit
    // Семантические токены темы, а не сырая палитра Tailwind: портал вправе переопределить
    // токены под свою air-тему, и захардкоженный emerald/rose за ней не поедет. Фон — парный
    // tinted-токен (сам меняется с темой), глиф — тот же text-grade цвет, что у суммы: штатный
    // `tinted-*-content` на светлом фоне плитки даёт 2.44:1 при пороге 3:1 для иконки-носителя.
      ? 'bg-(--ui-color-design-tinted-success-bg) text-(--ui-color-green-90) dark:text-(--ui-color-accent-main-success)'
      : 'bg-(--ui-color-design-tinted-alert-bg) text-(--ui-color-red-80) dark:text-(--ui-color-accent-main-alert)',
    amount: `${credit ? '+' : '−'}${money.format(item.amount)} ${item.currency}`,
    name: item.counterparty.name,
    purpose: item.purpose,
    requisites: requisites(item),
    // Отзыв о КОНКРЕТНОМ платеже (#499). Форму строит ТОТ ЖЕ `makeProgramSample`, что и программный
    // канал, — не копия «такой же формы», а буквально она: правило приватности записано одно на два
    // канала, и держать его на двух ручных литералах значит ждать, пока они разойдутся. `kind`
    // описывает, на чём запуталась программа; у отзыва человека такого нет, поэтому оно снимается.
    sample: (({ kind: _kind, ...rest }) => rest as Record<string, unknown>)(
      makeProgramSample(item, 'unmatched')
    )
  }
}

/** Сколько строк-заглушек добить, чтобы страница не меняла высоту.
 *
 *  ⚠ Заглушки настоящей разметкой, а не `min-height` числом: высота строки складывается из шрифтов
 *  и отступов темы, и любая константа разъехалась бы с ней при первой же правке — молча, потому что
 *  выглядело бы «почти правильно». Строки одинаковой высоты по построению (оба текста `truncate`,
 *  то есть всегда одна линия), поэтому добивка совпадает с реальной точно. */
const filler = computed(() => Math.max(0, (props.reserveRows ?? 0) - props.items.length))

/** Items grouped by day (local tz), newest first; each row precomputed. */
const groups = computed(() => {
  const byDay = new Map<string, StatementItem[]>()
  for (const item of [...props.items].sort((a, b) => b.acceptDate.localeCompare(a.acceptDate))) {
    const key = fmt(item.acceptDate, dayKeyFmt)
    ;(byDay.get(key) ?? byDay.set(key, []).get(key)!).push(item)
  }
  return [...byDay.entries()].map(([key, items]) => ({
    key,
    label: fmt(items[0]!.acceptDate, groupFmt),
    rows: items.map(toRow)
  }))
})

const hasItems = computed(() => props.items.length > 0)
</script>

<template>
  <!-- Empty: calm, not alarming. -->
  <div
    v-if="!hasItems"
    class="flex flex-col items-center gap-2 py-10 text-center"
  >
    <EmptyMessageIcon class="size-8 text-(--ui-color-base-4)" />
    <p class="font-medium">
      Пока пусто
    </p>
    <p class="text-sm text-(--ui-color-base-3)">
      Операции появятся после первой синхронизации.
    </p>
  </div>

  <div v-else>
    <div
      v-for="group in groups"
      :key="group.key"
    >
      <!-- Заголовок дня — ПОДПИСЬ, а не плашка во всю ширину. Плашка брала тот же фон, что и
           строки, весила визуально больше самих операций и читалась как ещё одна строка таблицы. -->
      <p class="px-1 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-(--ui-color-base-3) first:pt-1">
        {{ group.label }}
      </p>

      <B24Collapsible
        v-for="row in group.rows"
        :key="row.key"
        class="border-b border-(--ui-color-design-tinted-na-stroke) last:border-b-0"
      >
        <!-- Row (trigger) -->
        <!-- Подсветка строки — СКРУГЛЁННАЯ ВСТАВКА (-mx-2 + px-2 + rounded), а не подложка во всю
             ширину: раньше она брала тот же токен, что и плашка даты с плиткой направления, и при
             наведении строки «слипались» с соседями и с заголовком дня в одно пятно.
             ⚠ Светлая тема требует ОТДЕЛЬНОГО значения: базовый `bg-content-secondary` — это
             #fbfbfb на белой карточке (#fff), то есть контраст ~1.02:1, наведение фактически не
             видно. Сам b24ui по этой же причине переопределяет hover строк таблицы на #f6f8f9
             (см. `.nuxt/b24ui/table.ts`) — берём то же значение, чтобы не расходиться с ним. -->
        <!-- ⚠ Именно <button>, не <div>: CollapsibleTrigger рендерится as-child, то есть кликер —
             сам этот элемент. Div не фокусируется — строка не раскрывалась с клавиатуры (U2, #430). -->
        <!-- ⚠ РАСКЛАДКА МЕНЯЕТСЯ НА `sm`, и это не украшение. Один ряд «плитка + текст + сумма» на
             375 px не помещался: сумма не переносится и не сжимается, поэтому колонку с текстом
             дожимало до `ЗАО "АЛЬФ…` и `Вознагражд-е за …` — по названию контрагента нельзя было
             понять, кто платил. Ниже `sm` сумма уходит ПОД текст и получает всю ширину. -->
        <button
          type="button"
          class="-mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-start gap-3 rounded-md px-2 py-3 text-left transition-colors hover:bg-(--ui-color-bg-content-secondary) light:hover:bg-[#f6f8f9] sm:items-center"
        >
          <span
            class="flex size-10 shrink-0 items-center justify-center rounded-lg"
            :class="row.tile"
          >
            <!-- Иконка крупнее (`size-5` в плитке `size-10`): прежние `size-4` в `size-9` терялись
                 в собственной подложке, а это единственный глиф, несущий направление. -->
            <component
              :is="row.icon"
              class="size-5"
              aria-hidden="true"
            />
          </span>
          <div class="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <div class="min-w-0 flex-1">
              <p class="truncate font-semibold">
                {{ row.name }}
              </p>
              <p class="truncate text-xs text-(--ui-color-base-3)">
                {{ row.purpose }}
              </p>
            </div>
            <span
              class="shrink-0 font-semibold tabular-nums"
              :class="row.tint"
            >
              {{ row.amount }}
            </span>
          </div>
        </button>

        <template #content>
          <B24DescriptionList
            :items="row.requisites"
            size="sm"
            class="pb-3 pl-12"
          />
          <!-- Отзыв живёт ВНУТРИ раскрытой строки, а не рядом с каждой (#499): сто виджетов в
               списке — это сто раз «не нажимайте меня», а раскрытая строка означает, что человек
               уже смотрит именно на этот платёж. Виджет сам себя не рисует, пока канал выключен на
               сервере, поэтому на непод-ключённом портале ничего не появится. -->
          <div class="pb-3 pl-12">
            <FeedbackWidget
              :operation="row.sample"
              :subject-key="row.key"
              place="операция"
            />
          </div>
        </template>
      </B24Collapsible>
    </div>

    <!-- Резерв высоты под недостающие строки последней страницы. Без него карточка сжималась, и
         кнопки пагинации уезжали вверх ПОД КУРСОРОМ — следующий клик попадал мимо. -->
    <div
      v-for="n in filler"
      :key="`filler-${n}`"
      class="flex items-start gap-3 px-2 py-3 sm:items-center"
      aria-hidden="true"
    >
      <span class="size-10 shrink-0" />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <p class="invisible truncate font-semibold">
          &nbsp;
        </p>
        <p class="invisible truncate text-xs">
          &nbsp;
        </p>
      </div>
    </div>
  </div>
</template>
