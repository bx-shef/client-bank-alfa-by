<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useB24 } from '~/composables/useB24'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useBankConnect } from '~/composables/useBankConnect'
import { PREVIEW_BANK_MATRIX, useBankMatrix } from '~/composables/useBankMatrix'
import { isPreviewQuery } from '~/utils/inPortalGate'
import { BANK_LABELS } from '~/utils/bankLabels'
import { CONNECT_STATE_TTL_MIN } from '~/utils/bankConnectTtl'

// Online bank connect (stage 5, A7c). Admin picks the bank and starts the OAuth connect:
// POST /api/bank/connect (frame token) → the backend returns the bank authorize
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

// The list is a child component; after a connect finishes we ask it to re-read. Without this the
// admin returns from the bank tab to a list that still says «пока ничего не подключено» — the exact
// complaint #404 is about, reproduced inside one session.
const connectedList = useTemplateRef<{ reload: () => Promise<void> }>('connectedList')

// Сверка счетов (#494) живёт ЗДЕСЬ, а не внутри блока, который её рисует: тот же ответ нужен и
// списку подключений выше — из него он делает кнопки «выбрать счёт» вместо поля ввода. Один запрос
// на два блока: он ходит в банк, и два запроса означали бы двойной поход плюс риск показать две
// половины экрана, противоречащие друг другу.
const route = useRoute()
const matrix = useBankMatrix()

// ⚠ Вне портала матрица пуста (нет фрейм-токена), поэтому блок сверки не попадал ни в один снимок
// и ни в один визуальный эталон. Под `?preview=1` подставляем синтетическую — ту же роль, что
// `PREVIEW_BANK_ACCOUNTS` играет для списка подключений.
//
// ⚠ Флаг читается из РОУТЕРА, а не из `window.location`: на гидратации пререндеренной страницы
// строка запроса пуста (#555).
//
// ⚠ И проверяется ДВАЖДЫ — реактивно и ещё раз после ответа сети. Вне портала `load()` выходит
// рано и без единого `await`, но ВНУТРИ портала он уходит в сеть и вернулся бы ПОСЛЕ подстановки,
// молча затерев фикстуру. Ровно эту гонку ревью нашло у соседнего списка; повторять её незачем.
const previewMatrix = computed(() => isPreviewQuery(route.query.preview))

function usePreviewMatrix(): void {
  matrix.rows.value = PREVIEW_BANK_MATRIX.rows
  matrix.providers.value = PREVIEW_BANK_MATRIX.providers
  matrix.loaded.value = true
}

watch(previewMatrix, (on) => {
  if (on) usePreviewMatrix()
}, { immediate: true })

/** ЕДИНСТВЕННАЯ точка перечитывания сверки — иначе один из трёх вызывающих однажды сходит в сеть
 *  мимо фикстуры и молча сотрёт её на экране предпросмотра (и в визуальном эталоне). */
async function reloadMatrix(): Promise<void> {
  if (previewMatrix.value) {
    usePreviewMatrix()
    return
  }
  await matrix.load()
  if (previewMatrix.value) usePreviewMatrix()
}

onMounted(reloadMatrix)

const adminChecked = ref(false)
const started = ref(false)

// The authorize URL is kept so the admin can HAND IT OVER. The account often belongs to a client,
// not to the admin: only the account holder knows the internet-bank password, so the person who
// presses the button and the person who authorises are different people. Until now the URL only
// ever went into `window.location` of a new tab — the sole way to pass it on was copying it out of
// the address bar, and it is long (a signed request-JWT plus state) so messengers wrap and break it.
const authorizeUrl = ref('')
const copied = ref(false)

// ⚠ THE LINK IS SHORT-LIVED — both the signed connect state (CONNECT_STATE_TTL_MS) and Prior's
// request-JWT expire ~10 minutes after the button press, and the clock starts HERE, not when the
// client opens it. A client hunting for their bank password past that gets «Ссылка недействительна»,
// which reads as a breakage rather than as an expiry. Nothing in the UI said so; now it does, so the
// admin coordinates first and presses second.
const LINK_TTL_MIN = CONNECT_STATE_TTL_MIN

async function copyLink() {
  if (!authorizeUrl.value) return
  try {
    await navigator.clipboard.writeText(authorizeUrl.value)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2500)
  } catch {
    // Clipboard API is unavailable over plain http and can be denied by permissions policy — in a
    // portal iframe both are realistic. Say so instead of failing mutely; the input below still
    // holds the URL for a manual select-and-copy.
    error.value = 'Не удалось скопировать — выделите ссылку в поле ниже и скопируйте вручную'
  }
}

/** The banks that have an online (OAuth) connect path. `manual` is file upload — not connectable,
 *  so the picker's type is the NARROWED union (a `manual` value can't be selected or sent). */
const PROVIDERS = [
  { value: 'alfa-by' as const, label: BANK_LABELS['alfa-by'] },
  { value: 'prior-by' as const, label: BANK_LABELS['prior-by'] }
]
type ConnectableProvider = (typeof PROVIDERS)[number]['value']
const provider = ref<ConnectableProvider>('alfa-by')
const providerLabel = computed(() => PROVIDERS.find(p => p.value === provider.value)?.label ?? '')

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
  authorizeUrl.value = ''
  copied.value = false
  // Open the tab SYNCHRONOUSLY inside the click gesture — a window.open after the awaited fetch
  // would be blocked. We navigate it to the authorize URL once we have it (or close it on failure).
  const win = window.open('', '_blank')
  const url = await start(provider.value)
  if (url && win) {
    win.opener = null // sever the opener before navigating to the bank (anti-tabnabbing)
    win.location.href = url
    authorizeUrl.value = url
    started.value = true
    // The bank tab is top-level and never notifies us, so poll-free: refresh when the admin comes
    // back to this tab. Once is enough — a second connect re-arms it.
    window.addEventListener('focus', () => {
      void connectedList.value?.reload()
      void reloadMatrix()
    }, { once: true })
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
      <ConnectedBankAccounts
        ref="connectedList"
        :bank-accounts="matrix.bankAccounts.value"
        @changed="reloadMatrix()"
      />

      <hr class="border-(--ui-color-design-tinted-na-stroke)">

      <!-- Сверка «наш счёт ↔ счёт в банке» (#494). Ниже списка подключений и ВЫШЕ формы: сначала
           «что подключено», потом «сходится ли это с реквизитами», и только потом «подключить ещё».
           На первом боевом прогоне именно этот вопрос остался без ответа — портал отчитался
           «117 обработано, 0 создано», и узнать почему было неоткуда. -->
      <AccountMatrix
        :rows="matrix.rows.value"
        :providers="matrix.providers.value"
        :loading="matrix.loading.value"
        :loaded="matrix.loaded.value"
        :error="matrix.error.value"
      />

      <hr class="border-(--ui-color-design-tinted-na-stroke)">

      <!-- ⚠ The copy states the order of operations, and that order is «bank first, account
           after». An account-number field used to sit above the button, and it misled: the admin
           typed a number, went to the bank — and the bank's page never asked about an account. The
           field read as if it steered the bank's consent when it only ever labelled OUR row. The
           number is picked after returning, from the list above, where it is already visible. -->
      <p class="text-sm text-(--ui-color-base-2)">
        Подключите банк — приложение будет автоматически забирать выписку и заносить операции
        в CRM. Откроется окно банка для входа и согласия; после подтверждения вернётесь сюда
        и укажете, какой счёт забирать, в списке выше.
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
        description="Подключение выполняется внутри портала Bitrix24. Здесь — предпросмотр."
        data-testid="preview-note"
      />

      <!-- Status region: announced to screen readers on change (error = assertive, success = polite). -->
      <div
        role="alert"
        aria-live="assertive"
      >
        <B24Alert
          v-if="error"
          color="air-primary-alert"
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
          :description="`Открыли окно банка в новой вкладке. Войдите и подтвердите доступ, затем вернитесь на эту страницу. Если счёт не ваш — передайте ссылку ниже владельцу счёта: она действует около ${LINK_TTL_MIN} минут.`"
          data-testid="connect-started"
        />
      </div>

      <!-- Hand-over block. Shown once a link exists, because before that there is nothing to hand
           over. The URL sits in a read-only input as well as behind the button: the Clipboard API
           is unavailable over plain http and can be blocked by permissions policy in an iframe, and
           a copy button that silently does nothing is worse than no button.
           ⚠ Deliberately NOT gated on `!error`. The two failures that set `error` after a link
           exists are «clipboard blocked» and «popup blocked» — and both are answered by handing the
           link over manually. Hiding the field on error unmounted the very input the error text
           tells the admin to select, leaving the page with an instruction and nothing to act on,
           and nothing clears `error` except pressing «Подключить» again, which mints a DIFFERENT
           link and invalidates the one already sent. -->
      <B24FormField
        v-if="started && authorizeUrl"
        label="Ссылка для владельца счёта"
        :description="`Действует около ${LINK_TTL_MIN} минут с момента нажатия «Подключить» — отсчёт уже идёт. Если владелец счёта не готов прямо сейчас, дождитесь его и нажмите «Подключить» заново: ссылка обновится.`"
        data-testid="authorize-link-field"
      >
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <B24Input
            :model-value="authorizeUrl"
            readonly
            class="w-full font-mono text-xs"
            data-testid="authorize-link"
            @focus="(e: FocusEvent) => (e.target as HTMLInputElement)?.select()"
          />
          <B24Button
            color="air-secondary-accent"
            class="shrink-0"
            data-testid="copy-link"
            @click="copyLink"
          >
            {{ copied ? 'Скопировано' : 'Скопировать' }}
          </B24Button>
        </div>
      </B24FormField>

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
