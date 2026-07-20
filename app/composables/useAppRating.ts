import { ref } from 'vue'
import { useRuntimeConfig } from '#imports'
import { useB24 } from '~/composables/useB24'
import { frameAuth, frameAuthHeaders } from '~/composables/useFrameAuth'
import { marketDetailPath } from '~/config/b24'
import { LANDING_MARKET_CODE } from '~/utils/landing'

// In-portal «оцените приложение» client. Whether to show the modal is decided SERVER-SIDE
// (per-portal state in portal_app_rating, see server/utils/appRating*); this composable only:
//   • probes GET /api/app-rating for the show decision (throttled + verification-aware server-side),
//   • stamps the lifecycle (prompted / opened) back via POST,
//   • opens the app's Market detail page through the frame SDK's slider.openPath so the user can rate.
// Inert outside a portal (no frame auth) and when no Market code is configured (b24MarketCode empty).

export function useAppRating() {
  const b24 = useB24()
  // Default to the app's real Market slug (single source of truth in landing.ts); an env override
  // (NUXT_PUBLIC_B24_MARKET_CODE) can point at a different listing if the app is ever re-published.
  const marketCode = String(useRuntimeConfig().public.b24MarketCode || LANDING_MARKET_CODE)
  const path = marketDetailPath(marketCode)

  // Instance-local (not module-level) so there is no shared singleton across SSR requests or across
  // two mounts. The modal is a single page-level popup, so one instance owns this state for its life.
  const show = ref(false)
  let checked = false // probe once per mount — a re-render must not re-hit the API

  /** Ask the server whether to prompt now. No-op unless framed AND a Market code is set. */
  async function check(): Promise<void> {
    if (checked || !path) return
    checked = true
    await b24.init()
    const a = frameAuth()
    if (!a) return // outside a portal — never nag
    try {
      const r = await $fetch<{ show?: boolean }>('/api/app-rating', { headers: frameAuthHeaders(a) })
      show.value = !!r?.show
    } catch {
      show.value = false // any failure → stay silent
    }
  }

  /** Fire-and-forget lifecycle write (must never break the UX). */
  async function report(action: 'prompted' | 'opened'): Promise<void> {
    const a = frameAuth()
    if (!a) return
    try {
      await $fetch('/api/app-rating', { method: 'POST', headers: frameAuthHeaders(a), body: { action } })
    } catch {
      // ignore — the modal UX does not depend on the state write succeeding
    }
  }

  /** Modal was shown → throttle it server-side for the re-prompt interval. */
  function markPrompted(): void {
    void report('prompted')
  }

  /** User clicked «Оценить»: record the click, then open the Market detail page in a portal slider. */
  async function openMarket(): Promise<void> {
    show.value = false
    void report('opened')
    const frame = b24.get()
    if (!frame || !path) return
    try {
      const url = frame.slider.getUrl(path)
      await frame.slider.openPath(url)
    } catch {
      // openPath can reject on unsupported devices — the SDK already falls back to window.open;
      // nothing actionable for us beyond having closed the modal.
    }
  }

  /** «Не сейчас» / close — prompted_at was already stamped, so just hide. */
  function dismiss(): void {
    show.value = false
  }

  return { show, check, markPrompted, openMarket, dismiss }
}
