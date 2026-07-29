<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SettingsIcon from '@bitrix24/b24icons-vue/outline/SettingsIcon'
import { splitByDirection } from '~/utils/statement'
import type { OperationDirection, StatementItem } from '~/types/statement'
import { useB24 } from '~/composables/useB24'
import { useImportStatus } from '~/composables/useImportStatus'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useChatSettings } from '~/composables/useChatSettings'
import { useSettingsSync } from '~/composables/useSettingsSync'
import { pageTitle } from '~/utils/landing'

// In-portal page: `clear` layout wraps it in <B24App> so b24ui theming/colorMode
// work inside the iframe; standalone (direct URL) it just renders the same UI.
definePageMeta({ layout: 'clear' })

useHead({ title: pageTitle('Выписка по счёту') })

// Real operations only — no demo data. The backend operations feed (#5) lands here
// later; until then the list is empty (honest empty state, not a mock).
const items = ref<StatementItem[]>([])
const byDirection = computed(() => splitByDirection(items.value))

// Filter chips (labels keep the "(N)" counts). Default "all" shows everything.
type Filter = 'all' | OperationDirection
const filter = ref<Filter>('all')
const chips = computed(() => [
  { value: 'all' as Filter, label: `Все (${items.value.length})` },
  { value: 'credit' as Filter, label: `Приходы (${byDirection.value.credits.length})` },
  { value: 'debit' as Filter, label: `Расходы (${byDirection.value.debits.length})` }
])
const shown = computed(() =>
  filter.value === 'all' ? items.value : items.value.filter(i => i.direction === filter.value)
)

// Pagination (renders only when it overflows a page).
const perPage = 10
const page = ref(1)
const paged = computed(() => shown.value.slice((page.value - 1) * perPage, page.value * perPage))
function setFilter(f: Filter) {
  filter.value = f
  page.value = 1
}

// Settings slideover (primary entry; /settings route is the fallback).
const settingsOpen = ref(false)

// Import status (demo until the backend poller, #5). Client fetches on mount.
const { status, refresh } = useImportStatus()

// Admin gate (drives which setup banner shows). Resolved after useB24().init().
const { inPortal, isAdmin, check: checkAdmin } = useIsAdmin()

// Chat settings (shared singleton with the SettingsForm slideover). Subscribe to the
// cross-instance reload pull so a save in another open instance re-reads live. MUST run
// SYNCHRONOUSLY in setup — after an `await` the active effect scope is lost and
// onScopeDispose (inside subscribeReload) wouldn't bind → the pull client would leak.
// Best-effort; no-op if the portal pull server / frame is unavailable.
const chatSettings = useChatSettings()
useSettingsSync().subscribeReload(() => void chatSettings.load())

// «Настроено» = a notification chat is chosen (its dialogId is non-empty). That is the
// minimal switch that turns the pipeline on, so it gates the setup banner.
const configured = computed(() => chatSettings.settings.chat.dialogId !== '')
// Settings are «ready» to decide the view: outside the portal there's nothing to load;
// inside, only once chatSettings.load() has resolved. Gating on this avoids a flash of the
// "not configured" banner while the fetch is still in flight for an already-configured portal.
const settingsReady = computed(() => !inPortal.value || chatSettings.loaded.value)
// Show the setup banner only inside the portal, after settings loaded, when not configured.
// Standalone/dev (no frame) is neither blocked nor nagged — it renders the empty operations view.
const showSetupBanner = computed(() => inPortal.value && chatSettings.loaded.value && !configured.value)

const b24 = useB24()
onMounted(async () => {
  await refresh()
  await b24.init()
  if (!b24.isInit()) return
  checkAdmin()
  // Load chat settings so the setup banner reflects the real configured state.
  await chatSettings.load()
  try {
    const $b24 = b24.getOrThrow()
    await $b24.parent.setTitle('Выписка по счёту')
    await $b24.parent.fitWindow()
  } catch (e) {
    if (import.meta.dev) console.warn('[app] B24 parent calls failed', e)
  }
})
</script>

<template>
  <main class="mx-auto max-w-(--ui-container) px-4 py-6">
    <h1 class="sr-only">
      Выписка по счёту
    </h1>

    <ImportStatusBanner
      :status="status"
      class="mb-5"
    />

    <!-- Employee 👍/👎 on the import result (docs/FEEDBACK.md, channel «сотрудник»). Renders only
         when the channel is configured server-side (GITHUB_FEEDBACK_*), and is inert outside a
         portal. -->
    <FeedbackWidget class="mb-5" />

    <header class="mb-5 flex items-center justify-end gap-2">
      <B24Button
        label="Загрузить выписку"
        color="air-secondary-no-accent"
        size="sm"
        to="/import"
      />
      <B24Button
        :icon="SettingsIcon"
        color="air-tertiary-no-accent"
        size="sm"
        aria-label="Настройки"
        @click="() => { settingsOpen = true }"
      />
    </header>

    <!-- App not configured yet (no notification chat chosen). Admins get a call-to-action
         with a shortcut to the settings; everyone else is told an admin is setting it up. -->
    <template v-if="showSetupBanner">
      <B24Alert
        v-if="isAdmin"
        color="air-primary-warning"
        variant="soft"
        title="Приложение не настроено"
        description="Выберите чат для уведомлений в настройках — после этого приложение начнёт присылать операции и записывать их в CRM."
        class="mb-5"
      />
      <B24Button
        v-if="isAdmin"
        label="Открыть настройки"
        color="air-primary"
        class="mb-5"
        @click="() => { settingsOpen = true }"
      />
      <B24Alert
        v-else
        color="air-secondary-accent"
        variant="soft"
        title="Приложение ещё настраивается"
        description="Администратор портала завершает настройку. Импорт выписок станет доступен после этого."
        class="mb-5"
      />
    </template>

    <!-- Real operations view (empty until the backend feed, #5). Shown once settings are
         ready and the app is configured; hidden while unconfigured (setup banner) or while
         the in-portal settings fetch is still resolving (avoids a flash either way). -->
    <template v-else-if="settingsReady">
      <!-- Lively import-result summary (#62): count-up tiles + by-day / share charts.
           Same component as the /import preview — reused for the in-portal path. Shown
           only when there are real operations to summarize. -->
      <ImportStatsChart
        v-if="items.length"
        :items="items"
        title="Сводка по операциям"
        class="mb-5"
      />

      <!-- Operations, styled like the "Последние операции" view. -->
      <B24Card>
        <template #header>
          <h2 class="font-semibold">
            Последние операции
          </h2>
        </template>

        <!-- Filter chips -->
        <div class="flex flex-wrap gap-2">
          <B24Button
            v-for="c in chips"
            :key="c.value"
            :label="c.label"
            :color="filter === c.value ? 'air-primary' : 'air-tertiary-no-accent'"
            :aria-pressed="filter === c.value"
            size="sm"
            @click="setFilter(c.value)"
          />
        </div>

        <!-- Column header -->
        <div class="mt-4 flex items-center justify-between border-b border-(--ui-color-design-tinted-na-stroke) pb-2 text-xs text-(--ui-color-base-3)">
          <span>Операция</span>
          <span>Сумма</span>
        </div>

        <OperationList :items="paged" />

        <!-- Pagination shows only when operations overflow a page (real data). -->
        <B24Pagination
          v-if="shown.length > perPage"
          v-model:page="page"
          :total="shown.length"
          :items-per-page="perPage"
          class="mt-4 justify-center"
        />
      </B24Card>
    </template>

    <!-- Cross-sell: заказать доработку/автоматизацию под свой процесс (ИП Шевчик,
         партнёр Bitrix24). Только на внутренних страницах приложения (не на лендинге). -->
    <div class="mx-auto mt-8 w-full max-w-[520px]">
      <CustomDevCard />
    </div>

    <BuildFooter />

    <!-- Settings slideover (primary entry; /settings route stays as fallback).
         Opens from the bottom (a "bottom sheet") — comfortable in a narrow B24
         iframe / on mobile, where a right-side panel is cramped. -->
    <B24Slideover
      v-model:open="settingsOpen"
      title="Настройки"
      description="Подключение банка, уведомления в чат, исключения, распознавание. Сохраняются в вашем портале Bitrix24."
      side="bottom"
    >
      <template #body>
        <ClientOnly>
          <!-- In the slideover: Save/Cancel dismiss the panel (asSlider), like a B24 slider. -->
          <SettingsForm
            :as-slider="true"
            @close="settingsOpen = false"
          />

          <!-- Route to the FULL settings page. The slideover carries everything an admin needs to
               switch the import on (bank connection included), but the distribution ledger is
               `/settings`-only — and without this link that page was unreachable from the UI.
               Admin-only: the copy names admin-only features. -->
          <div
            v-if="isAdmin"
            class="mt-6 border-t border-(--ui-color-design-tinted-na-stroke) pt-4"
          >
            <p class="mb-2 text-sm text-(--ui-color-base-3)">
              Здесь — все настройки приложения. Отдельно вынесено только распределение платежей:
              там видно, какой платёж на какой счёт или сделку разнесён.
            </p>
            <B24Button
              label="Распределение платежей"
              color="air-secondary-no-accent"
              size="sm"
              to="/settings"
            />
          </div>
        </ClientOnly>
      </template>
    </B24Slideover>
  </main>
</template>
