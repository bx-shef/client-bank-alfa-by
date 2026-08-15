<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useBankAccounts, type ConnectedBankAccount } from '~/composables/useBankAccounts'
import { isPendingAccountKey } from '~/utils/bankAccountKey'
import { formatRelativeTime } from '~/utils/importStatus'
import { BANK_LABELS } from '~/utils/bankLabels'
import { connectionHealth, connectionHealthBadge } from '~/utils/bankTokenLifetime'

// Connected bank accounts, with a per-row disconnect (#404). Lives inside BankConnectCard, above
// the connect form, so the admin sees what is already bound BEFORE adding another account —
// previously a successful connect left no trace anywhere in the UI.
//
// Admin gate is NOT repeated here: the card that hosts this already gates on admin, and the
// backend re-gates both routes (the client gate is convenience, the server one is authority).

const { accounts, loading, loaded, removing, saving, error, load, disconnect, setAccount, rowKey } = useBankAccounts()

/** Черновики номеров для подключений, ждущих выбора счёта (#407) — по одному на строку. */
const drafts = ref<Record<string, string>>({})

/** Which row is awaiting confirmation. Disconnect is destructive (imports stop), so it takes a
 *  deliberate second click rather than a native confirm() — the latter is blocked in some iframes. */
const confirming = ref('')

onMounted(load)

function providerLabel(id: ConnectedBankAccount['provider']): string {
  return BANK_LABELS[id] ?? id
}

/** «подключён N минут назад». The store gives epoch ms; the shared formatter takes an ISO string
 *  plus an explicit «now» (it is pure — no hidden clock), hence the conversion here. A row with a
 *  bad timestamp renders nothing rather than «Invalid Date». */
function connectedAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return formatRelativeTime(new Date(ms).toISOString(), Date.now())
}

/** Бейдж состояния подключения (#488) или `null`, когда сказать нечего. Чистое ядро —
 *  `bankTokenLifetime.ts`, ТО ЖЕ, по которому сервер решает, кого обновлять: собственное правило
 *  в интерфейсе рисовало бы зелёное на подключении, которое сервер уже похоронил. */
function healthBadge(a: ConnectedBankAccount) {
  return connectionHealthBadge(connectionHealth(a, Date.now()))
}

/** Подпись строки для скринридера. Временный ключ служебный — озвучивать его бессмысленно. */
function rowLabel(a: ConnectedBankAccount): string {
  return isPendingAccountKey(a.accountKey)
    ? `${providerLabel(a.provider)}, счёт не выбран`
    : `${providerLabel(a.provider)} ${a.accountKey}`
}

async function onAssign(a: ConnectedBankAccount) {
  const key = rowKey(a)
  // Успех → строка перечитается уже с настоящим номером, черновик больше не нужен.
  if (await setAccount(a, drafts.value[key] ?? '')) drafts.value[key] = ''
}

async function onDisconnect(a: ConnectedBankAccount) {
  confirming.value = ''
  await disconnect(a)
}

defineExpose({ reload: load })
</script>

<template>
  <section
    class="space-y-3"
    data-testid="connected-accounts"
  >
    <h3 class="text-sm font-semibold">
      Подключённые счета
    </h3>

    <p
      v-if="loading && !loaded"
      class="text-sm text-(--ui-color-base-3)"
      role="status"
      aria-live="polite"
    >
      Загружаем…
    </p>

    <!-- Error sits ABOVE the list, never INSTEAD of it: a failed disconnect used to collapse the
         whole section into one alert, so the admin lost the row they were trying to retry. -->
    <div
      role="alert"
      aria-live="assertive"
    >
      <B24Alert
        v-if="error"
        color="air-primary-alert"
        :description="error"
        data-testid="accounts-error"
      />
    </div>

    <p
      v-if="loaded && !accounts.length"
      class="text-sm text-(--ui-color-base-3)"
      data-testid="accounts-empty"
    >
      Пока ничего не подключено. Подключите счёт ниже — после этого он появится здесь.
    </p>

    <ul
      v-else-if="accounts.length"
      class="space-y-2"
    >
      <li
        v-for="a in accounts"
        :key="rowKey(a)"
        class="rounded-md border border-(--ui-color-design-tinted-na-stroke) p-3"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-medium">{{ providerLabel(a.provider) }}</span>
              <!-- Два РАЗНЫХ состояния, поэтому разные цвета и оба показываются вместе: у Приора
                   refresh часто пуст, и раньше после привязки счёта бейдж «счёт не выбран» сменялся
                   на «нужно переподключить» — читалось так, будто привязка что-то сломала. -->
              <B24Badge
                v-if="isPendingAccountKey(a.accountKey)"
                color="air-secondary-accent"
                size="xs"
                label="счёт не выбран"
              />
              <!-- Состояние подключения (#488). Считается по ВОЗРАСТУ ПАРЫ, а не по `expiresAt`:
                   тот описывает access-токен, и именно поэтому мёртвое подключение раньше
                   выглядело здоровым — access свежий, а refresh за ним уже не существует.
                   `ok` бейджа не даёт намеренно: значок на каждой исправной строке приучает их
                   не читать, а «подключён N назад» строчкой ниже и так всё говорит. -->
              <B24Badge
                v-if="healthBadge(a)"
                :color="healthBadge(a)!.color"
                size="xs"
                :label="healthBadge(a)!.label"
                :title="healthBadge(a)!.hint"
              />
            </div>
            <!-- Подключение без счёта (#407): строка есть, номера ещё нет — просим выбрать прямо
                 здесь, иначе такое подключение было бы «висящим» и непонятным. -->
            <div
              v-if="isPendingAccountKey(a.accountKey)"
              class="mt-1 flex flex-wrap items-center gap-2"
              :data-testid="`pending-${a.provider}`"
            >
              <B24Input
                v-model="drafts[rowKey(a)]"
                placeholder="BY00ALFA00000000000000000000"
                class="w-full max-w-xs font-mono text-xs"
                :aria-label="`Номер счёта для подключения ${providerLabel(a.provider)}`"
              />
              <B24Button
                label="Привязать счёт"
                color="air-primary"
                size="xs"
                :loading="saving === rowKey(a)"
                :disabled="saving === rowKey(a)"
                @click="onAssign(a)"
              />
            </div>
            <div
              v-else
              class="truncate font-mono text-xs text-(--ui-color-base-3)"
            >
              {{ a.accountKey }}
            </div>
            <div
              v-if="connectedAgo(a.connectedAt)"
              class="text-xs text-(--ui-color-base-3)"
            >
              подключён {{ connectedAgo(a.connectedAt) }}
            </div>
          </div>

          <div class="flex items-center gap-2">
            <template v-if="confirming === rowKey(a)">
              <span
                class="text-xs text-(--ui-color-base-3)"
                role="status"
                aria-live="polite"
              >Отключить?</span>
              <B24Button
                label="Да, отключить"
                :aria-label="`Да, отключить ${rowLabel(a)}`"
                color="air-primary-alert"
                size="xs"
                :loading="removing === rowKey(a)"
                :disabled="removing === rowKey(a)"
                @click="onDisconnect(a)"
              />
              <B24Button
                label="Отмена"
                color="air-tertiary-no-accent"
                size="xs"
                @click="() => { confirming = '' }"
              />
            </template>
            <B24Button
              v-else
              label="Отключить"
              :aria-label="`Отключить ${rowLabel(a)}`"
              color="air-secondary-no-accent"
              size="xs"
              @click="() => { confirming = rowKey(a) }"
            />
          </div>
        </div>
      </li>
    </ul>

    <p class="text-xs text-(--ui-color-base-3)">
      Отключение убирает доступ приложения к счёту — операции по нему перестанут поступать.
      Уже записанные в CRM данные остаются.
    </p>
  </section>
</template>
