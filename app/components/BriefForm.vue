<script setup lang="ts">
import { buildB24FormSrc, resolveB24Form } from '~/utils/b24Form'

// Embedded Bitrix24 CRM web-form. The form itself lives in a dedicated
// same-origin document (`/public/b24-form.html`) served with a form-scoped CSP;
// here we only build the iframe `src` from public config and relay the submit
// event to Metrika. Which form: `resolveB24Form` — the configured one, else ours
// outside local mode; nothing ⇒ a placeholder slot.
const config = useRuntimeConfig()
const form = resolveB24Form({
  scriptUrl: config.public.b24FormScriptUrl,
  formId: config.public.b24FormId,
  formSecret: config.public.b24FormSecret
}, useLocalMode())
const src = buildB24FormSrc(form.scriptUrl, form.formId, form.formSecret)

// The goal goes through the single `ym` call site, which resolves the counter id
// the same way the snippet does (a raw config read went silent after #701).
const { reachGoal } = useMetrikaGoal()

// b24:form:submit is relayed from the iframe document via postMessage. The
// iframe (/b24-form.html) is same-origin, so reject any other origin — otherwise
// an unrelated frame could spoof the `brief_submit` analytics goal.
function onFrameMessage(e: MessageEvent) {
  if (e.origin !== window.location.origin) return
  if (e.data !== 'b24:form:submit') return
  reachGoal('brief_submit')
}

onMounted(() => window.addEventListener('message', onFrameMessage))
onUnmounted(() => window.removeEventListener('message', onFrameMessage))
</script>

<template>
  <div class="overflow-hidden rounded-2xl border border-white/10 bg-black/30 backdrop-blur-sm">
    <iframe
      v-if="src"
      :src="src"
      class="min-h-[760px] w-full border-0 rounded-2xl sm:min-h-[620px]"
      title="Форма заявки на установку"
      loading="lazy"
    />

    <div
      v-else
      class="flex min-h-[280px] items-center justify-center p-6 text-center"
    >
      <p class="text-sm text-white/50">
        Слот под CRM-форму Bitrix24 — задайте переменные
        <code class="font-mono">NUXT_PUBLIC_B24_FORM_*</code>, чтобы встроить форму.
      </p>
    </div>
  </div>
</template>
