<script setup lang="ts">
// Operator login page (public, outside Bitrix24). Posts credentials to
// /api/auth/login; on success the server sets a signed HttpOnly session cookie and
// we return to `?redirect=` (default /queues). On b24ui so it themes with the rest
// (light/dark). Ported from the Procure AI auth model. See docs/AUTH.md.
import LockMIcon from '@bitrix24/b24icons-vue/outline/LockMIcon'

// `clear` layout wraps the page in <B24App> → b24ui components + colorMode (dark) work.
definePageMeta({ layout: 'clear' })

const route = useRoute()
const { login } = useAuth()

useHead({
  title: 'Вход — импорт выписки',
  meta: [{ name: 'robots', content: 'noindex, nofollow' }]
})

const user = ref('operator')
const password = ref('')
const error = ref('')
const busy = ref(false)

const redirect = computed(() => safeRedirect(route.query.redirect))

async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await login(user.value, password.value)
    await navigateTo(redirect.value)
  } catch (e) {
    const status = (e as { statusCode?: number, response?: { status?: number } })?.statusCode
      ?? (e as { response?: { status?: number } })?.response?.status
    error.value = status === 503
      ? 'Вход не настроен на сервере (нет пароля).'
      : status === 401
        ? 'Неверный логин или пароль.'
        : 'Не удалось войти — попробуйте позже.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="flex min-h-screen items-center justify-center px-4 py-10">
    <B24Card class="w-full max-w-sm">
      <template #header>
        <div class="flex items-center gap-3">
          <span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-(--ui-color-design-tinted-na-bg) text-(--ui-color-base-3)">
            <LockMIcon class="size-5" />
          </span>
          <div>
            <h1 class="font-semibold">
              Вход для сотрудников
            </h1>
            <p class="text-sm text-(--ui-color-base-3)">
              Импорт выписки из клиент-банка
            </p>
          </div>
        </div>
      </template>

      <form
        class="flex flex-col gap-4"
        @submit.prevent="submit"
      >
        <B24FormField label="Логин">
          <B24Input
            v-model="user"
            autocomplete="username"
            name="username"
            class="w-full"
          />
        </B24FormField>
        <B24FormField label="Пароль">
          <B24Input
            v-model="password"
            type="password"
            autocomplete="current-password"
            name="password"
            required
            class="w-full"
          />
        </B24FormField>

        <B24Alert
          v-if="error"
          color="air-primary-alert"
          variant="soft"
          :title="error"
        />

        <B24Button
          type="submit"
          color="air-primary"
          block
          :loading="busy"
          :label="busy ? 'Вход…' : 'Войти'"
        />
      </form>
    </B24Card>
  </main>
</template>
