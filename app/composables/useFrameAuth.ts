import { useB24 } from '~/composables/useB24'

// Shared Bitrix24 frame-auth for the settings composables (useChatSettings,
// useBankConnect, …). One copy of a security-relevant contract — pull the access
// token + domain from the frame SDK and build the backend auth headers — so the
// header names and the `auth === false` guard can't drift between callers.

export interface FrameAuth {
  token: string
  domain: string
}

/** Frame auth (access token + domain) from the SDK, or null outside a portal
 *  (no frame → no token → callers stay inert). */
export function frameAuth(): FrameAuth | null {
  const b24 = useB24()
  if (!b24.isInit()) return null
  try {
    const auth = b24.getOrThrow().auth.getAuthData()
    if (auth === false || !auth.access_token || !auth.domain) return null
    return { token: auth.access_token, domain: auth.domain }
  } catch {
    return null
  }
}

/** Backend auth headers for a frame-authenticated request. */
export function frameAuthHeaders(a: FrameAuth): Record<string, string> {
  return { 'authorization': `Bearer ${a.token}`, 'x-b24-domain': a.domain }
}

/** Human-readable message from a $fetch error, preferring the route's {error}. */
export function frameFetchError(e: unknown, fallback: string): string {
  const err = e as { status?: number, statusCode?: number, data?: { error?: string } } | null | undefined
  // ⚠ 429 НАЗЫВАЕМ ОТДЕЛЬНО. Его отдаёт nginx, а не наш роут, поэтому тела с `error` в нём нет и
  // человек видел голое «Не удалось загрузить …» — то есть отказ, неотличимый от поломки сервера.
  // Живая находка 2026-09-09: админ несколько раз подряд открыл настройки, выбрал лимит зоны, и
  // сразу ТРИ блока (список подключений, сверка счетов, экран готовности) сказали «не удалось» —
  // из чего он заключил, что пропало подключение к Приору. Оно никуда не пропадало.
  if (err?.status === 429 || err?.statusCode === 429) {
    return `${fallback}: слишком много запросов подряд. Подождите минуту и обновите страницу`
  }
  return err?.data?.error ? `${fallback}: ${err.data.error}` : fallback
}
