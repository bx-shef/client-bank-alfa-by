// Client wrapper over the operator auth endpoints (server/api/auth/*).
// The signed session lives in an HttpOnly cookie (not readable/here); this only
// posts credentials and reads the session status. State-changing calls carry the
// CSRF header (a custom header can't be sent cross-site without a CORS preflight).
// See docs/AUTH.md.

export interface SessionInfo {
  /** Пароль задан. */
  configured: boolean
  authenticated: boolean
  /** Пускать без сессии прямо сейчас. Решать надо ПО НЕМУ, а не по `!configured`: незаданный
   *  пароль в проде означает недонастроенный деплой, и зона там закрыта — иначе покажем контент,
   *  все запросы которого вернут 401. Зеркало `SessionStatus` в server/utils/session.ts. */
  open: boolean
  user?: string
}

// Mirror of server/utils/session.ts CSRF_HEADER (kept in sync by hand — the client
// bundle must not import server code).
const CSRF_HEADERS = { 'x-cba-auth': '1' }

export function useAuth() {
  // `url` is typed as plain `string` (not a literal) on purpose: it bypasses
  // Nitro's typed-route inference for $fetch, which otherwise triggers a
  // "excessive stack depth" TS error on these endpoints.
  const get = <T>(url: string): Promise<T> => $fetch(url) as Promise<T>
  const post = <T>(url: string, body?: unknown): Promise<T> =>
    $fetch(url, { method: 'POST', headers: CSRF_HEADERS, ...(body ? { body } : {}) }) as Promise<T>

  const fetchSession = (): Promise<SessionInfo> => get<SessionInfo>('/api/auth/session')
  const login = (user: string, password: string): Promise<{ ok: boolean, user: string, exp: number }> =>
    post('/api/auth/login', { user, password })
  const logout = (): Promise<{ ok: boolean }> => post('/api/auth/logout')

  return { fetchSession, login, logout }
}
