// Route guard for the operator/employee area (e.g. /queues, later the import
// pages). Redirects unauthenticated users to /login. Runs CLIENT-side (the site is
// SSG — the static HTML is public; the REAL protection is that data endpoints
// require the session cookie). Когда логин не настроен, зона открыта ТОЛЬКО в деве — в проде
// незаданный пароль означает недонастроенный деплой и зона закрыта. Недоступный бэкенд UI не
// блокирует. См. docs/AUTH.md.

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return // skip during SSG prerender; enforced on the client
  const { fetchSession } = useAuth()
  try {
    const s = await fetchSession()
    if (s.open) return // логин выключен и зона открыта (дев) → пускаем
    // Пароль не задан, но зона закрыта — это прод без настройки. На /login отправлять НЕЛЬЗЯ:
    // там 503, и получился бы бесконечный кружок. Объяснение показывает AuthGate.
    if (!s.configured) return
    if (!s.authenticated) {
      return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
    }
  } catch {
    // Backend not reachable (static preview / API down) — don't block the UI here;
    // protected data endpoints still enforce the session server-side.
  }
})
