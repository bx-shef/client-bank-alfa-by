<script setup lang="ts">
// Client-side access gate for operator pages. The site is SSG — the static HTML
// is public and the route `middleware: auth` redirect only fires AFTER the page
// has painted, so protected content would FLASH before the redirect (looks
// insecure, and it's a jarring blink). This wraps the page body: it renders a
// neutral "проверка доступа" state until the session is confirmed, and only then
// reveals the slot. Unauthenticated → the middleware navigates away; we render
// nothing. The REAL protection is server-side (data endpoints check the session);
// this is purely to avoid showing protected chrome to an unauthenticated visitor.
import { ref, onMounted } from 'vue'
import LoaderWaitIcon from '@bitrix24/b24icons-vue/animated/LoaderWaitIcon'

const state = ref<'checking' | 'ok' | 'denied' | 'locked'>('checking')

onMounted(async () => {
  const { fetchSession } = useAuth()
  try {
    const s = await fetchSession()
    if (s.authenticated || s.open) state.value = 'ok'
    // Пароль не задан и зона не открыта — это ПРОД без настройки. Отдельное состояние, а не
    // редирект на /login: войти там нельзя в принципе (роут отдаёт 503), и владелец крутился бы
    // между страницей и формой, не понимая, чего от него хотят.
    else if (!s.configured) state.value = 'locked'
    else state.value = 'denied'
  } catch {
    // Backend unreachable (static preview / API down): don't hard-block the UI —
    // consistent with the middleware. Data endpoints still enforce the session.
    state.value = 'ok'
  }
})
</script>

<template>
  <ClientOnly>
    <slot v-if="state === 'ok'" />
    <div
      v-else-if="state === 'checking'"
      role="status"
      aria-live="polite"
      class="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-(--ui-color-base-3)"
    >
      <LoaderWaitIcon
        class="size-8"
        aria-hidden="true"
      />
      <p class="text-sm">
        Проверка доступа…
      </p>
    </div>
    <div
      v-else-if="state === 'locked'"
      role="status"
      class="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-3 px-4 text-center"
    >
      <h1 class="text-lg font-semibold">
        Служебная зона закрыта
      </h1>
      <p class="text-sm text-(--ui-color-base-3)">
        На сервере не задан пароль оператора (<code>PUBLIC_PAGE_BASIC_AUTH_PASS</code>) — вход
        выключен, и данные не отдаются никому. Задайте пароль и <code>SESSION_SECRET</code> в
        <code>.env</code>, затем пересоздайте контейнер бэкенда.
      </p>
    </div>
    <!-- denied: the auth middleware redirects to /login; render nothing here. -->
  </ClientOnly>
</template>
