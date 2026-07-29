<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useB24 } from '~/composables/useB24'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useBankConnect } from '~/composables/useBankConnect'
import { BANK_LABELS } from '~/utils/bankLabels'

// Online bank connect (stage 5, A7c). Admin picks the bank, enters the account number and starts
// the OAuth connect: POST /api/bank/connect (frame token) → the backend returns the bank authorize
// URL, which we open in a NEW TAB — opened SYNCHRONOUSLY in the click handler (a window.open after
// the fetch await would be popup-blocked), then pointed at the URL. The bank redirects to our
// callback (A7b-2), which saves the token. Gated on admin (connecting a bank binds credentials to
// the whole portal — the backend also enforces this). Outside the portal frame the card is a preview.
//
// Both banks are offered (A5b added Prior). A provider the server has no env config for is refused
// there with a clean 400 ("… недоступен"), so the picker never needs to know the deployment's config.
//
// Connections ACCUMULATE: the bank-token store is keyed (member_id, provider, account_key), so a
// portal can hold Alfa and Prior and several accounts of each at once — the picker connects ONE more
// account per run, it never replaces the previous one. Manual file upload (/import) is a separate
// path entirely and keeps working regardless. The copy below says so, because "подключить" reads
// like a single exclusive choice otherwise.
const { inPortal, isAdmin, check: checkAdmin } = useIsAdmin()
const { start, syncEnabled, connecting, error, enabled } = useBankConnect()

const adminChecked = ref(false)
const accountKey = ref('')
const started = ref(false)

/** The banks that have an online (OAuth) connect path. `manual` is file upload — not connectable,
 *  so the picker's type is the NARROWED union (a `manual` value can't be selected or sent). */
const PROVIDERS = [
  { value: 'alfa-by' as const, label: BANK_LABELS['alfa-by'] },
  { value: 'prior-by' as const, label: BANK_LABELS['prior-by'] }
]
type ConnectableProvider = (typeof PROVIDERS)[number]['value']
const provider = ref<ConnectableProvider>('alfa-by')
const providerLabel = computed(() => PROVIDERS.find(p => p.value === provider.value)?.label ?? '')
const accountPlaceholder = computed(() =>
  provider.value === 'prior-by' ? 'BY00PJCB00000000000000000000' : 'BY00ALFA00000000000000000000'
)

onMounted(async () => {
  await useB24().init().catch(() => {})
  // Let useB24 flip its ready flag on nextTick (isInit lags an un-awaited init).
  await nextTick()
  checkAdmin()
  syncEnabled() // resolve frame presence now so the preview note is correct before any click
  adminChecked.value = true
})

async function onConnect() {
  started.value = false
  // Open the tab SYNCHRONOUSLY inside the click gesture — a window.open after the awaited fetch
  // would be blocked. We navigate it to the authorize URL once we have it (or close it on failure).
  const win = window.open('', '_blank')
  const url = await start(provider.value, accountKey.value)
  if (url && win) {
    win.opener = null // sever the opener before navigating to the bank (anti-tabnabbing)
    win.location.href = url
    started.value = true
  } else if (url && !win) {
    error.value = 'Разрешите всплывающие окна для этого сайта и повторите'
  } else {
    win?.close() // start() failed (error is set) — drop the blank tab
  }
}
</script>

<template>
  <!-- Withhold until the admin check resolves (no fail-open flash to a non-admin). -->
  <p
    v-if="!adminChecked"
    class="text-sm text-(--ui-color-base-3)"
    role="status"
    aria-live="polite"
    data-testid="checking"
  >
    Проверка доступа…
  </p>

  <!-- Non-admin in the portal: warning only. -->
  <B24Alert
    v-else-if="inPortal && !isAdmin"
    color="air-primary-warning"
    variant="soft"
    title="Подключение банка доступно только администратору"
    description="Онлайн-подключение привязывает доступ к банку ко всему порталу — начать его может только администратор Bitrix24."
    data-testid="admin-gate"
  />

  <B24Card
    v-else
    data-testid="bank-connect"
  >
    <template #header>
      <h2 class="font-semibold">
        Онлайн-подключение банка
      </h2>
    </template>

    <div class="space-y-4">
      <!-- What is already bound, with a per-row disconnect (#404). Above the form on purpose:
           the first question after a connect is «что у меня подключено?». -->
      <ConnectedBankAccounts ref="connected" />

      <hr class="border-(--ui-color-design-tinted-na-stroke)">

      <p class="text-sm text-(--ui-color-base-2)">
        Подключите счёт — приложение будет автоматически забирать выписку и заносить операции
        в CRM. Откроется окно банка для входа и согласия; после подтверждения вернётесь сюда.
      </p>

      <p class="text-sm text-(--ui-color-base-3)">
        Подключения складываются: Альфа-Банк, Приорбанк и несколько счетов в каждом могут работать
        одновременно — подключайте по одному счёту за раз, предыдущие остаются. Ручная загрузка
        файла выписки доступна всегда и не зависит от онлайн-подключения.
      </p>

      <B24RadioGroup
        v-model="provider"
        legend="Банк"
        color="air-primary"
        orientation="horizontal"
        :items="PROVIDERS"
        data-testid="provider-picker"
      />

      <B24Alert
        v-if="!enabled"
        color="air-primary"
        variant="soft"
        description="Подключение выполняется внутри портала Bitrix24. Здесь — предпросмотр."
        data-testid="preview-note"
      />

      <B24FormField
        label="Номер счёта"
        :description="`Расчётный счёт (IBAN) в банке «${providerLabel}», который подключаем. Только буквы и цифры, как в банке.`"
      >
        <B24Input
          v-model="accountKey"
          :placeholder="accountPlaceholder"
          class="w-full font-mono text-xs"
          data-testid="account-input"
        />
      </B24FormField>

      <!-- Status region: announced to screen readers on change (error = assertive, success = polite). -->
      <div
        role="alert"
        aria-live="assertive"
      >
        <B24Alert
          v-if="error"
          color="air-primary-alert"
          variant="soft"
          :description="error"
          data-testid="connect-error"
        />
      </div>
      <div
        role="status"
        aria-live="polite"
      >
        <B24Alert
          v-if="!error && started"
          color="air-primary-success"
          variant="soft"
          description="Открыли окно банка в новой вкладке. Войдите и подтвердите доступ, затем вернитесь на эту страницу."
          data-testid="connect-started"
        />
      </div>

      <B24Button
        :loading="connecting"
        :disabled="connecting"
        :aria-busy="connecting"
        color="air-primary"
        data-testid="connect-button"
        @click="onConnect"
      >
        Подключить {{ providerLabel }}
      </B24Button>
    </div>
  </B24Card>
</template>
