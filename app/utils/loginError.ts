// Map a failed POST /api/auth/login error to the operator-facing message shown
// on /login. Pure so it can be unit-tested without the mountSuspended harness
// (an earlier in-component assertion was flaky — the mocked rejection surfaced
// as an unhandled rejection; see #84/#65). login.vue just calls this in its
// catch. Mirrors the loginRedirect.ts extraction.

/**
 * Extract the HTTP status from a login failure. Handles both error shapes we can
 * see: a Nuxt `$fetch` FetchError (`statusCode`) and an axios-style error
 * (`response.status`). `statusCode` wins when both are present. Returns
 * `undefined` when neither is set (network error, thrown string, etc.).
 */
export function loginErrorStatus(e: unknown): number | undefined {
  const err = e as { statusCode?: number, response?: { status?: number } } | null | undefined
  return err?.statusCode ?? err?.response?.status
}

/** Operator-facing message for a login failure, keyed by the HTTP status. */
export function loginErrorMessage(e: unknown): string {
  const status = loginErrorStatus(e)
  if (status === 503) return 'Вход не настроен на сервере (нет пароля).'
  if (status === 401) return 'Неверный логин или пароль.'
  return 'Не удалось войти — попробуйте позже.'
}
