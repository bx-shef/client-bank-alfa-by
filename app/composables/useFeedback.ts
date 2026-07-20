import { ref } from 'vue'
import { frameAuth, frameAuthHeaders } from '~/composables/useFrameAuth'

// In-portal feedback client (docs/FEEDBACK.md, channel «сотрудник»): submit 👍/👎 + a comment on the
// import result. The channel is server-gated (GITHUB_FEEDBACK_* env) — `enabled` is probed ONCE and
// shared by every widget (module-level ref) so N widgets don't each hit /api/feedback. Inert outside
// a portal (no frame token → submit no-ops).

/** Import context attached to the feedback issue (all optional; rendered inert server-side). */
export interface FeedbackSubmitContext {
  fileName?: string
  appVersion?: string
  /** Raw statement text — sent ONLY when the employee ticks the consent box (#198). The server
   *  embeds it in the private issue only when `attachFile` is also true. */
  fileContent?: string
}

const enabled = ref<boolean | null>(null) // null = not probed yet; shared across widgets
let probing: Promise<void> | null = null

export function useFeedback() {
  /** Probe whether the channel is on (once). Failure → treated as OFF (widget stays hidden). */
  async function ensureEnabled(): Promise<void> {
    if (enabled.value !== null) return
    if (!probing) {
      probing = (async () => {
        try {
          const r = await $fetch<{ enabled?: boolean }>('/api/feedback')
          enabled.value = !!r?.enabled
        } catch {
          enabled.value = false
        }
      })()
    }
    await probing
  }

  /**
   * Send a rating (+ optional comment + import context). Throws on a server error; returns false
   * outside a portal (no frame token). Context (fileName/appVersion) traces the issue back to a run
   * — permitted because the receiving repo is private (see app/utils/feedback.ts). Empty/undefined
   * fields are dropped by the server builder.
   */
  async function submit(kind: 'up' | 'down', comment?: string, context?: FeedbackSubmitContext): Promise<boolean> {
    const a = frameAuth()
    if (!a) return false // outside a portal — no frame token
    // `attachFile` is the explicit consent flag the server gates the file embed on (#198): only set
    // when the caller actually provided fileContent (the widget passes it only when the box is ticked).
    const attachFile = typeof context?.fileContent === 'string' && context.fileContent.length > 0
    await $fetch('/api/feedback', { method: 'POST', headers: frameAuthHeaders(a), body: { kind, comment, context, attachFile } })
    return true
  }

  return { enabled, ensureEnabled, submit }
}
