// Route guard for the operator/employee area (e.g. /queues, later the import
// pages). Redirects unauthenticated users to /login. Runs CLIENT-side (the site is
// SSG — the static HTML is public; the REAL protection is that data endpoints
// require the session cookie). When auth is not configured (no password) the area
// is open; when the backend is unreachable we don't hard-lock the UI. See docs/AUTH.md.

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return // skip during SSG prerender; enforced on the client
  const { fetchSession } = useAuth()
  try {
    const s = await fetchSession()
    if (!s.configured) return // login disabled → open
    if (!s.authenticated) {
      return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
    }
  } catch {
    // Backend not reachable (static preview / API down) — don't block the UI here;
    // protected data endpoints still enforce the session server-side.
  }
})
