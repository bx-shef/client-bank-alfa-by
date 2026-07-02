<script setup lang="ts">
// Operator login page (public, outside Bitrix24). Posts credentials to
// /api/auth/login; on success the server sets a signed HttpOnly session cookie and
// we return to `?redirect=` (default /queues). Ported from the Procure AI auth
// model (postroyka/purchase-ai-chat). See docs/AUTH.md.
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

const redirect = computed(() => {
  const r = route.query.redirect
  const path = typeof r === 'string' ? r : '/queues'
  // Only allow same-site relative paths (no protocol-relative //host, no absolute URL).
  return path.startsWith('/') && !path.startsWith('//') ? path : '/queues'
})

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
  <main class="lg-page">
    <form
      class="lg-card"
      @submit.prevent="submit"
    >
      <h1 class="lg-title">
        Вход для сотрудников
      </h1>
      <p class="lg-sub">
        Импорт выписки из клиент-банка
      </p>

      <label class="lg-label">
        Логин
        <input
          v-model="user"
          class="lg-input"
          type="text"
          autocomplete="username"
          name="username"
        >
      </label>
      <label class="lg-label">
        Пароль
        <input
          v-model="password"
          class="lg-input"
          type="password"
          autocomplete="current-password"
          name="password"
          required
        >
      </label>

      <p
        v-if="error"
        class="lg-error"
      >
        {{ error }}
      </p>

      <button
        class="lg-btn"
        type="submit"
        :disabled="busy"
      >
        {{ busy ? 'Вход…' : 'Войти' }}
      </button>
    </form>
  </main>
</template>

<style scoped>
.lg-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: #f3f4f6; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #111827; }
.lg-card { width: 100%; max-width: 360px; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px;
  padding: 28px 24px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); display: flex; flex-direction: column; gap: 14px; }
.lg-title { margin: 0; font-size: 20px; font-weight: 700; }
.lg-sub { margin: -8px 0 6px; color: #6b7280; font-size: 14px; }
.lg-label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; font-weight: 500; color: #374151; }
.lg-input { padding: 9px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 15px; }
.lg-input:focus { outline: 2px solid #2563eb; outline-offset: 0; border-color: #2563eb; }
.lg-error { margin: 0; padding: 8px 12px; border-radius: 8px; background: #fef2f2; color: #b91c1c; font-size: 14px; }
.lg-btn { margin-top: 4px; padding: 10px 12px; border: 0; border-radius: 8px; background: #2563eb; color: #fff;
  font-size: 15px; font-weight: 600; cursor: pointer; }
.lg-btn:disabled { opacity: 0.6; cursor: default; }
.lg-btn:not(:disabled):hover { background: #1d4ed8; }
</style>
