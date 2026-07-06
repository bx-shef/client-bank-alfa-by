import { useB24 } from '~/composables/useB24'

// Shared Bitrix24 frame-auth for the settings composables (useAppSettings,
// useChatSettings). One copy of a security-relevant contract — pull the access
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
  const data = (e as { data?: { error?: string } })?.data
  return data?.error ? `${fallback}: ${data.error}` : fallback
}
