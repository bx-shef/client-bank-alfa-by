<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useBankAccounts, PREVIEW_BANK_ACCOUNTS } from '~/composables/useBankAccounts'
import { useEraseActivities } from '~/composables/useEraseActivities'
import { useSetupStatus } from '~/composables/useSetupStatus'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { isPendingAccountKey } from '~/utils/bankAccountKey'
import { isPreviewQuery } from '~/utils/inPortalGate'
import { useRoute } from 'vue-router'
import { BANK_LABELS } from '~/utils/bankLabels'
import { parsePeriod, periodLabel } from '~/utils/eraseActivities'
import type { BankProviderId } from '~/types/statement'

// Раздел «Очистка» (#576 п.4): стереть дела, созданные приложением.
//
// ⚠ ЗАЧЕМ. На неподготовленном портале приложение штатно пишет дела в «мою компанию» — клиент по
// счёту не опознан (#91). За несколько суток их сотни, и убрать их было нечем: руками это столько
// же кликов, сколько дел.
//
// ⚠ ДЕЙСТВИЕ НЕОБРАТИМО, поэтому интерфейс устроен в ДВА ШАГА и первый не умеет удалять: сперва
// «Посчитать» (отдельный маршрут, который структурно не знает метода удаления), и только потом
// появляется кнопка стирания с названным числом. Так требовал владелец, и это же защищает от
// самого частого промаха — стереть больше, чем собирался.

const { isAdmin, inPortal } = useIsAdmin()
const { accounts, load: loadAccounts } = useBankAccounts()
const route = useRoute()
const { status: setup, loadedOk: setupKnown, load: loadSetup } = useSetupStatus()
const { counting, erasing, error, pending, result, count, erase } = useEraseActivities()

const from = ref('')
const to = ref('')
/** Выбранные НАШИ счета; пусто ⇒ по всем. */
const picked = ref<string[]>([])
const confirming = ref(false)

// ⚠ Превью-ветка — по той же причине, что у списка подключений: вне портала счетов нет, и чипы
// выбора не попадали бы ни в один скриншот и ни в один визуальный эталон. Флаг читается РЕАКТИВНО:
// на пререндеренной странице настоящий адрес восстанавливается ПОЗЖЕ монтирования (#555), и чтение
// в `onMounted` молча не сработало бы.
const preview = computed(() => isPreviewQuery(route.query.preview))
watch(preview, (isPreview) => {
  if (isPreview) accounts.value = PREVIEW_BANK_ACCOUNTS
}, { immediate: true })

onMounted(async () => {
  if (preview.value) return
  void loadSetup()
  await loadAccounts()
  // Адрес мог восстановиться, пока шёл запрос — тогда побеждает превью.
  if (preview.value) accounts.value = PREVIEW_BANK_ACCOUNTS
})

/** Счета, по которым вообще есть что стирать: у незавершённого подключения операций не было. */
const pickable = computed(() => accounts.value.filter(a => !isPendingAccountKey(a.accountKey)))

/**
 * Идёт ли опрос ПРЯМО СЕЙЧАС (#576, находка ревью).
 *
 * ⚠ Раньше здесь стоял статичный текст «сначала приостановите опрос». Совет верный, но человек,
 * который уже приостановил, видел его же — и переставал читать; а тот, кто не приостановил,
 * читал ровно так же. Предупреждение, одинаковое в безопасном и опасном случае, не предупреждает
 * ни о чём. Состояние у нас есть (`/api/setup-status`), и спросить его дешевле, чем надеяться.
 *
 * `null` — состояние неизвестно (вне портала, не админ, отказ запроса). Тогда предупреждаем МЯГКО:
 * «не смогли проверить» честнее, чем уверенное «опрос идёт» или уверенное «всё спокойно».
 */
const pollRunning = computed<boolean | null>(() => {
  if (!setupKnown.value) return null
  if (!setup.value.pollEnabled) return false
  const connected = setup.value.connectedAccounts
  const paused = setup.value.pausedAccounts ?? 0
  if (connected === 0) return false
  return paused < connected
})

const period = computed(() => parsePeriod({ from: from.value, to: to.value }))
const periodBad = computed(() => period.value === null)
const scopeLabel = computed(() => (picked.value.length > 0 ? `счета: ${picked.value.join(', ')}` : 'все счета'))

function toggle(accountKey: string): void {
  const i = picked.value.indexOf(accountKey)
  if (i >= 0) picked.value.splice(i, 1)
  else picked.value.push(accountKey)
  // ⚠ Любое изменение отбора снимает подтверждение: посчитанное число относилось к ПРЕЖНЕМУ
  // отбору, и оставить его значило бы предложить стереть не то, что обещано.
  reset()
}

function reset(): void {
  pending.value = null
  confirming.value = false
}

function providerLabel(p: BankProviderId): string {
  return BANK_LABELS[p] ?? p
}

async function onCount(): Promise<void> {
  confirming.value = false
  if (!period.value) return
  await count(period.value, picked.value)
  confirming.value = (pending.value?.count ?? 0) > 0
}

async function onErase(): Promise<void> {
  if (!period.value) return
  await erase(period.value, picked.value)
  confirming.value = false
}
</script>

<template>
  <div class="space-y-4">
    <B24Alert
      v-if="inPortal && !isAdmin"
      color="air-primary-warning"
      title="Очистка доступна только администратору портала"
      description="Действие необратимо и затрагивает CRM всего портала."
    />
    <template v-else>
      <HelpLink
        anchor="erased-returned"
        label="Почему стёртые дела возвращаются?"
      />
      <p
        data-testid="erase-activities"
        class="text-sm text-(--ui-color-base-3)"
      >
        Удаляет <strong>только дела, созданные этим приложением</strong> — по служебной метке.
        Звонки, встречи и задачи ваших сотрудников не затрагиваются.
      </p>

      <!-- ⚠ Об этом нельзя молчать: маркер дедупа живёт на самом деле, поэтому удаление стирает и
           его. Пока опрос идёт, операция за то же окно будет записана заново — и человек решит,
           что кнопка не работает.
           ⚠ Текст следует ЖИВОМУ состоянию, а не висит всегда одинаковый: предупреждение, которое
           одинаково и в опасном, и в безопасном случае, перестают читать. -->
      <B24Alert
        v-if="pollRunning === true"
        color="air-primary-alert"
        title="Опрос банка сейчас работает — сначала приостановите его"
        description="Приложение узнаёт «эта операция уже записана» по самому делу. Если удалить дела при работающем опросе, операции за последние сутки запишутся снова. Поставьте подключения на паузу в разделе «Подключение банка», а потом стирайте."
      />
      <B24Alert
        v-else-if="pollRunning === false"
        color="air-primary-success"
        title="Опрос сейчас не идёт — стирать безопасно"
        description="Операции не будут записаны заново, пока опрос приостановлен или выключен."
      />
      <B24Alert
        v-else
        color="air-primary-warning"
        title="Не удалось проверить, идёт ли опрос"
        description="Если опрос работает, удалённые дела за последние сутки запишутся снова: приложение узнаёт «эта операция уже записана» по самому делу. Проверьте паузу в разделе «Подключение банка»."
      />

      <!-- ⚠ Сказать прямо, что стираются ТОЛЬКО дела. Текст выше говорит, чего мы НЕ трогаем у
           клиента, и на этом фоне молчание про наш же смарт-процесс читается как «его тоже
           стёрли». А получилось бы наоборот: дел нет, элементы реестра остались. -->
      <p class="text-xs text-(--ui-color-base-3)">
        Стираются <strong>только дела</strong>. Элементы смарт-процесса «Импорт выписки: платежи»
        остаются — реестр платежей продолжает хранить историю операций.
      </p>

      <!-- ⚠ Период ОДНИМ полем-диапазоном, а не двумя календарями: два одинаковых месяца рядом
           не показывали сам период — человек выбирал начало, терял его из виду и получал
           перевёрнутый период, о котором узнавал из предупреждения внизу. Диапазон подсвечивает
           выбранное между границами и перевёрнутым быть не может по построению. Нативное
           `type="date"` не годилось раньше по другой причине: оно показывало формат операционной
           системы (в портале сплошь `mm/dd/yyyy`) и молча принимало несуществующий день, а
           действие здесь необратимо. -->
      <B24FormField
        label="Период"
        hint="Пусто — за всё время: с самого начала по сегодня"
      >
        <DayRangeField
          v-model:from="from"
          v-model:to="to"
          @update:from="reset"
          @update:to="reset"
        />
      </B24FormField>

      <p
        v-if="periodBad"
        class="text-xs text-(--ui-color-accent-main-alert)"
      >
        Начало периода позже его конца — проверьте даты.
      </p>

      <div
        v-if="pickable.length"
        class="space-y-2"
      >
        <div class="text-sm font-medium">
          Счета
        </div>
        <p class="text-xs text-(--ui-color-base-3)">
          Ничего не выбрано — стираем по всем счетам.
        </p>
        <div class="flex flex-wrap gap-2">
          <B24Button
            v-for="a in pickable"
            :key="a.accountKey"
            size="xs"
            :color="picked.includes(a.accountKey) ? 'air-primary' : 'air-tertiary-no-accent'"
            :label="`${providerLabel(a.provider)} · ${a.accountKey}`"
            @click="toggle(a.accountKey)"
          />
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <B24Button
          label="Посчитать"
          color="air-secondary-accent"
          :loading="counting"
          :disabled="counting || periodBad"
          @click="onCount"
        />
        <span
          v-if="period"
          class="text-xs text-(--ui-color-base-3)"
        >
          {{ periodLabel(period) }}, {{ scopeLabel }}
        </span>
      </div>

      <B24Alert
        v-if="pending && pending.count === 0"
        color="air-primary-success"
        title="Стирать нечего"
        description="Под этот отбор не попало ни одного дела, созданного приложением."
      />

      <div
        v-if="confirming && pending"
        class="space-y-2 rounded-md border border-(--ui-color-design-tinted-alert-stroke) p-3"
      >
        <div class="text-sm font-medium">
          Под удаление попадёт дел: {{ pending.count }}{{ pending.capped ? ' и более' : '' }}
        </div>
        <p class="text-xs text-(--ui-color-base-3)">
          {{ periodLabel(period!) }}, {{ scopeLabel }}. Восстановить удалённые дела нельзя.
          <template v-if="pending.capped">
            За один раз стирается не больше {{ pending.count }} — остальные удалятся повторным нажатием.
          </template>
        </p>
        <div class="flex flex-wrap gap-2">
          <B24Button
            label="Да, стереть"
            color="air-primary-alert"
            :loading="erasing"
            :disabled="erasing"
            @click="onErase"
          />
          <B24Button
            label="Отмена"
            color="air-tertiary-no-accent"
            @click="reset"
          />
        </div>
      </div>

      <B24Alert
        v-if="result"
        :color="result.remaining > 0 ? 'air-primary-warning' : 'air-primary-success'"
        :title="`Удалено дел: ${result.deleted}`"
        :description="result.remaining > 0
          ? `Под тот же отбор попадает ещё ${result.remaining} — нажмите «Посчитать» и повторите.`
          : 'Под этот отбор больше ничего не осталось.'"
      />

      <B24Alert
        v-if="error"
        color="air-primary-alert"
        :description="error"
      />
    </template>
  </div>
</template>
