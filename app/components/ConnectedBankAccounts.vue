<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useBankAccounts, type ConnectedBankAccount } from '~/composables/useBankAccounts'
import { formatRelativeTime } from '~/utils/importStatus'
import { BANK_LABELS } from '~/utils/bankLabels'

// Connected bank accounts, with a per-row disconnect (#404). Lives inside BankConnectCard, above
// the connect form, so the admin sees what is already bound BEFORE adding another account —
// previously a successful connect left no trace anywhere in the UI.
//
// Admin gate is NOT repeated here: the card that hosts this already gates on admin, and the
// backend re-gates both routes (the client gate is convenience, the server one is authority).

const { accounts, loading, loaded, removing, error, load, disconnect, rowKey } = useBankAccounts()

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

    <B24Alert
      v-else-if="error"
      color="air-primary-alert"
      variant="soft"
      :description="error"
      data-testid="accounts-error"
    />

    <p
      v-else-if="!accounts.length"
      class="text-sm text-(--ui-color-base-3)"
      data-testid="accounts-empty"
    >
      Пока ничего не подключено. Подключите счёт ниже — после этого он появится здесь.
    </p>

    <ul
      v-else
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
              <B24Badge
                v-if="!a.hasRefresh"
                color="air-primary-warning"
                size="xs"
                label="нужно переподключить"
              />
            </div>
            <div class="truncate font-mono text-xs text-(--ui-color-base-3)">
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
              <span class="text-xs text-(--ui-color-base-3)">Отключить?</span>
              <B24Button
                label="Да, отключить"
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
