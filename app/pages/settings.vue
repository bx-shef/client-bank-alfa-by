<script setup lang="ts">
import { onMounted } from 'vue'
import { useB24 } from '~/composables/useB24'
import { useChatSettings } from '~/composables/useChatSettings'
import { useSettingsSync } from '~/composables/useSettingsSync'
import { pageTitle } from '~/utils/landing'

// In-portal page: `clear` layout wraps it in <B24App> for iframe theming.
// This full-page route is the fallback / direct link; the primary entry is the
// settings slideover opened from /app (both render the same <SettingsForm/>).
definePageMeta({ layout: 'clear' })

useHead({ title: pageTitle('Настройки') })

// Live-reload when another open instance saves. MUST run SYNCHRONOUSLY in setup — after an
// `await` the active effect scope is lost and onScopeDispose (inside subscribeReload) wouldn't
// bind → leak. Best-effort, auto-disposed with the component scope.
const chatSettings = useChatSettings()
useSettingsSync().subscribeReload(() => void chatSettings.load())

const b24 = useB24()
onMounted(async () => {
  await b24.init()
  if (!b24.isInit()) return
  try {
    const $b24 = b24.getOrThrow()
    await $b24.parent.setTitle('Настройки')
    await $b24.parent.fitWindow()
  } catch (e) {
    if (import.meta.dev) console.warn('[settings] B24 parent calls failed', e)
  }
})
</script>

<template>
  <main class="mx-auto max-w-5xl px-4 py-6">
    <h1 class="text-2xl font-semibold">
      Настройки
    </h1>
    <p class="mt-2 text-sm text-(--ui-color-base-3)">
      Куда слать уведомления и ошибки импорта, и по каким операциям. Сохраняются в вашем портале Bitrix24.
    </p>

    <ClientOnly>
      <BankConnectCard class="mt-6" />
    </ClientOnly>

    <ClientOnly>
      <PollNowButton class="mt-6" />
    </ClientOnly>

    <ClientOnly>
      <ProvisionSpCard class="mt-6" />
    </ClientOnly>

    <ClientOnly>
      <DistributionTab class="mt-6" />
    </ClientOnly>

    <ClientOnly>
      <SettingsForm class="mt-6" />
    </ClientOnly>

    <!-- Cross-sell: custom development offer (same card as on /app). -->
    <div class="mt-8 max-w-[520px]">
      <CustomDevCard />
    </div>
  </main>
</template>
