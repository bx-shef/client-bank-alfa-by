<script setup lang="ts">
import { computed } from 'vue'
import {
  bankSideIncomplete, matrixIsClean, matrixProblems, matrixStateLabel, uncheckedNumbers,
  type MatrixRow
} from '~/utils/bankAccountMatrix'
import type { MatrixProviderStatus } from '~/composables/useBankMatrix'
import { BANK_LABELS } from '~/utils/bankLabels'
import { pluralRu } from '~/utils/importStatus'

// «Наш счёт ↔ счёт в банке» (#494) — the screen that answers «почему платежи не приземляются».
//
// The first live run produced «117 обработано, 0 создано» with a perfectly healthy transport: the
// account number typed at connect time did not match the requisite in CRM. Nothing anywhere said
// so. This block puts both sides next to each other, so a mismatch is visible before the first
// statement arrives instead of being inferred from a counter afterwards.
//
// ⚠ WHY WORKING ROWS ARE COLLAPSED, NOT HIDDEN. A screen that lists everything buries the one line
// that matters; a screen that shows only problems makes the admin doubt it ran at all. So problems
// render as full rows with an instruction, and matches collapse into one quiet line of counting.
//
// PRESENTATIONAL ON PURPOSE: the data comes from the parent card, which shares ONE `/api/bank/matrix`
// call with the connected-accounts list above (that list turns the bank side into pickable chips).
// Fetching here as well would ask the bank twice per render and could show the two blocks
// disagreeing with each other.

const props = defineProps<{
  rows: MatrixRow[]
  providers: MatrixProviderStatus[]
  loading: boolean
  loaded: boolean
  error: string
}>()

const clean = computed(() => matrixIsClean(props.rows))
// ⚠ НЕ `state !== 'matched'`: строка `unchecked` означает «банк не ответил, мы не спрашивали», и в
// списке проблем она предлагала бы чинить исправный реквизит — ровно то, от чего этот экран лечит.
const problems = computed(() => matrixProblems(props.rows))
const unchecked = computed(() => props.rows.filter(r => r.state === 'unchecked'))

// ⚠ Непроверенные СВОРАЧИВАЕМ в абзац, а не рисуем карточками: инструкции у них нет — чинить
// нечего, — а полный список карточек на исправном портале читался бы как авария. При этом в счётчик
// «сходятся» они тоже не попадают: за них мы не ручаемся.
//
// ⚠ НО НОМЕРА НАЗЫВАЕМ. Первая редакция сворачивала их в голое число, и это был тот же дефект,
// вывернутый наизнанку: отказ банка бывает ПОСТОЯННЫМ (мёртвый грант, банк не настроен на этом
// сервере), и тогда счёт исчезал с экрана НАВСЕГДА. Ровно так спрятался бы реквизит с опечаткой,
// ради которого экран и написан («117 обработано, 0 создано»): второй банк молчит вечно, первый
// счёт не назвал, а экран сообщает «проверить не удалось» и не показывает, ЧТО именно.
//
// ⚠ Пояснение берётся из подписи состояния, а не пишется здесь вторым текстом: иначе юнит-тест
// сторожил бы строку, которой админ не видит, а видел бы админ строку, которую не сторожит никто
// (находка ревью).
const uncheckedNote = computed(() => {
  const n = unchecked.value.length
  const { shown, more } = uncheckedNumbers(props.rows)
  const tail = more ? `${shown.join(', ')} и ещё ${more}` : shown.join(', ')
  const which = tail ? ` (${tail})` : ''
  return `${n} ${pluralRu(n, ['счёт', 'счёта', 'счетов'])} проверить не удалось${which}. `
    + matrixStateLabel('unchecked').hint
})

// ⚠ Было «Остальные 1 — сходятся»: при одной строке фраза читается как обрывок и выглядит
// ошибкой склонения (замечание владельца). Считаем словами и склоняем общим `pluralRu` — тем же,
// что и везде, а не ручным `=== 1` в шаблоне: ручной суррогат уже давал «5 портала(ов)».
const matchedCount = computed(() => props.rows.filter(r => r.state === 'matched').length)
const matchedNote = computed(() => {
  // ⚠ Считаем `matched`, а НЕ «всё, что не проблема»: прежняя арифметика (`длина минус проблемы`)
  // засчитала бы `unchecked` в «сходятся», то есть поручилась бы за строки, которых никто не
  // проверял, — тем же способом, каким `crm-only` уверенно врал про молчащий банк.
  const n = matchedCount.value
  return n === 1
    ? 'Ещё один счёт сходится.'
    : `Ещё ${n} ${pluralRu(n, ['счёт сходится', 'счёта сходятся', 'счетов сходятся'])}.`
})
const providerErrors = computed(() => props.providers.filter(p => p.error))
/** Хотя бы один подключённый банк в этот прогон не ответил — сторона банка НЕПОЛНА.
 *  ⚠ ТЕМ ЖЕ предикатом, что и на сервере (`bankIncomplete` в `bankMatrix.ts`): написанные порознь,
 *  строки и надпись над ними однажды описали бы разные миры. */
const bankSilent = computed(() => bankSideIncomplete(props.providers))

// ⚠ Те же два over-claim'а, что и в строках, только в сводках. Молчащий банк мог держать счёт,
// которого нет в реквизитах (`bank-only` — самая дорогая строка экрана), а мы бы уже написали
// «всё сходится» / «ни один банк не сообщил о своих». Утверждение о ПОЛНОТЕ мы вправе делать
// только когда ответили все, поэтому обе сводки в этом случае говорят про неполноту вслух.
const cleanNote = computed(() => bankSilent.value
  ? `Расхождений не найдено: ${props.rows.length}. Но один из банков сейчас не ответил — его `
  + 'счета в сверку не вошли. Повторите через несколько секунд.'
  : `Всё сходится: ${props.rows.length} — счета в реквизитах совпадают с тем, что отдаёт банк.`)
const emptyNote = computed(() => bankSilent.value
  ? 'В реквизитах «моих компаний» нет расчётных счетов, а банк сейчас не ответил, какие счета '
  + 'покрывает согласие. Добавьте счёт в реквизиты своей компании и повторите сверку.'
  : 'Сверять пока нечего: в реквизитах «моих компаний» нет расчётных счетов, и ни один банк не '
    + 'сообщил о своих. Добавьте счёт в реквизиты своей компании и подключите банк.')

function providerLabel(id: string): string {
  return BANK_LABELS[id as keyof typeof BANK_LABELS] ?? id
}

/** Colour follows severity, not decoration: `bank-only` money lands nowhere, `looks-same` looks
 *  correct and is not, `crm-only` is often perfectly fine (another bank, not connected yet). */
function stateColor(state: MatrixRow['state']) {
  if (state === 'bank-only') return 'air-primary-alert' as const
  if (state === 'looks-same') return 'air-primary-warning' as const
  return 'air-secondary-accent' as const
}
</script>

<template>
  <section
    class="space-y-3"
    data-testid="account-matrix"
  >
    <div class="flex items-baseline gap-3 flex-wrap">
      <h3 class="text-sm font-semibold">
        Сверка счетов: CRM ↔ банк
      </h3>
      <!-- ⚠ Самый частый вопрос («почему дела в моей компании») отвечается именно этим экраном, и
           ссылка обязана быть ЗДЕСЬ: в общем оглавлении справки её ищет тот, кто уже догадался,
           что смотреть надо сюда. -->
      <HelpLink
        anchor="my-company"
        label="Почему дела попадают в «мою компанию»?"
      />
    </div>

    <p
      v-if="loading && !loaded"
      class="text-sm text-(--ui-color-base-3)"
      role="status"
      aria-live="polite"
    >
      Сверяем…
    </p>

    <div
      role="alert"
      aria-live="assertive"
    >
      <B24Alert
        v-if="error"
        color="air-primary-alert"
        :description="error"
        data-testid="matrix-error"
      />
    </div>

    <!-- Отказ конкретного банка показываем ОТДЕЛЬНО от строк: пустой ответ из-за сбоя нельзя
         рисовать как «банк не отдаёт ни одного счёта» — админ пойдёт править исправные реквизиты. -->
    <B24Alert
      v-for="p in providerErrors"
      :key="p.provider"
      color="air-primary-warning"
      :description="`${providerLabel(p.provider)}: ${p.error}. Список счетов этого банка сейчас неизвестен — строки ниже показывают только сторону CRM.`"
      :data-testid="`matrix-provider-error-${p.provider}`"
    />

    <p
      v-if="loaded && !rows.length && !error"
      class="text-sm text-(--ui-color-base-3)"
      data-testid="matrix-empty"
    >
      {{ emptyNote }}
    </p>

    <!-- ⚠ Зелёный — только когда ответили ВСЕ банки: цвет здесь читается как «можно не смотреть». -->
    <p
      v-else-if="loaded && clean && rows.length"
      :class="bankSilent ? 'text-(--ui-color-base-3)' : 'text-(--ui-color-accent-main-success)'"
      class="text-sm"
      data-testid="matrix-clean"
    >
      {{ cleanNote }}
    </p>

    <ul
      v-if="problems.length"
      class="space-y-2"
      data-testid="matrix-problems"
    >
      <li
        v-for="(r, i) in problems"
        :key="`${r.state}-${r.crm?.number ?? ''}-${r.bank?.number ?? ''}-${i}`"
        class="rounded-md border border-(--ui-color-design-tinted-na-stroke) p-3"
        :data-testid="`matrix-row-${r.state}`"
      >
        <div class="flex flex-wrap items-center gap-2">
          <B24Badge
            :color="stateColor(r.state)"
            size="xs"
            :label="matrixStateLabel(r.state).title"
          />
          <B24Badge
            v-if="r.connected"
            color="air-secondary-accent"
            size="xs"
            label="подключён"
          />
        </div>

        <dl class="mt-2 grid gap-1 text-xs sm:grid-cols-2">
          <div>
            <dt class="text-(--ui-color-base-3)">
              В реквизитах CRM
            </dt>
            <dd class="truncate font-mono">
              {{ r.crm?.number || '—' }}
            </dd>
          </div>
          <div>
            <dt class="text-(--ui-color-base-3)">
              Отдаёт банк
            </dt>
            <dd class="truncate font-mono">
              {{ r.bank?.number || '—' }}
            </dd>
          </div>
        </dl>

        <p class="mt-2 text-xs text-(--ui-color-base-3)">
          {{ matrixStateLabel(r.state).hint }}
        </p>
      </li>
    </ul>

    <!-- «Проверить не удалось» — отдельной тихой строкой, ОТДЕЛЬНО от «сходятся»: ручаться за
         строку, которую никто не проверял, значит повторить исходную ошибку с другой стороны. -->
    <p
      v-if="loaded && unchecked.length"
      class="text-xs text-(--ui-color-base-3)"
      data-testid="matrix-unchecked-count"
    >
      {{ uncheckedNote }}
    </p>

    <p
      v-if="loaded && matchedCount && (problems.length || unchecked.length)"
      class="text-xs text-(--ui-color-base-3)"
      data-testid="matrix-matched-count"
    >
      {{ matchedNote }}
    </p>
  </section>
</template>
