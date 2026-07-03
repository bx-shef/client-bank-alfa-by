<script setup lang="ts">
import { buildB24FormSrc } from '~/utils/b24Form'

// Embedded Bitrix24 CRM web-form. The form itself lives in a dedicated
// same-origin document (`/public/b24-form.html`) served with a form-scoped CSP;
// here we only build the iframe `src` from public config and relay the submit
// event to Metrika. Empty config ⇒ a placeholder slot (owner sets the env vars).
const config = useRuntimeConfig()

const src = computed(() => buildB24FormSrc(
  config.public.b24FormScriptUrl as string,
  config.public.b24FormId as string,
  config.public.b24FormSecret as string
))

// b24:form:submit is relayed from the iframe document via postMessage.
function onFrameMessage(e: MessageEvent) {
  if (e.data !== 'b24:form:submit') return
  const id = Number(config.public.metrikaId)
  if (!id) return
  const w = window as Window & { ym?: (...args: unknown[]) => void }
  w.ym?.(id, 'reachGoal', 'brief_submit')
}

onMounted(() => window.addEventListener('message', onFrameMessage))
onUnmounted(() => window.removeEventListener('message', onFrameMessage))
</script>

<template>
  <div class="overflow-hidden rounded-2xl border border-(--b24ui-color-design-tinted-na-stroke) bg-(--b24ui-color-bg-content-primary)">
    <iframe
      v-if="src"
      :src="src"
      class="min-h-[760px] w-full border-0 sm:min-h-[620px]"
      title="Форма заявки на установку"
      loading="lazy"
    />

    <div
      v-else
      class="flex min-h-[280px] items-center justify-center p-6 text-center"
    >
      <p class="text-sm text-(--b24ui-color-text-secondary)">
        Слот под CRM-форму Bitrix24 — задайте переменные
        <code class="font-mono">NUXT_PUBLIC_B24_FORM_*</code>, чтобы встроить форму.
      </p>
    </div>
  </div>
</template>
