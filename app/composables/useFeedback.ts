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
  /** The operation the employee pointed at (#499) — same shape as the program channel's sample, so
   *  one privacy rule covers both. No consent gate: pointing at it IS the report. */
  operation?: Record<string, unknown>
  /** Which screen the employee was on (операция / загрузка / разбор / экран готовности /
   *  общий экран). Not client data. */
  place?: string
  /** Raw statement text — sent ONLY when the employee ticks the consent box (#198). The server
   *  embeds it in the private issue only when `attachFile` is also true. */
  fileContent?: string
}

const enabled = ref<boolean | null>(null) // null = not probed yet; shared across widgets
let probing: Promise<void> | null = null

/**
 * Subjects already rated in this tab (#499).
 *
 * ⚠ MODULE-LEVEL ON PURPOSE, because the widget does not outlive its host. Inside an operation row
 * it sits in a `B24Collapsible`, which unmounts its content on collapse — so «Спасибо за отзыв!»
 * disappeared the moment the row was folded, and re-expanding offered the buttons again as if
 * nothing had happened. A second 👍 is a second POST, and the happy path has no content dedup
 * (only the transient-retry outbox dedups by hash), so that is a second GitHub issue about the same
 * payment, repeatable as many times as the row is toggled.
 *
 * A `Set` in module scope, not `sessionStorage`: this is politeness about double-sending, not a
 * durable fact. Surviving a reload would also mean an employee who genuinely wants to re-report a
 * payment after a fix has no way to.
 */
const ratedSubjects = new Set<string>()

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

  /** Has this subject already been rated in this tab? Empty key ⇒ never remembered (a widget with
   *  no subject is a general «как вам вообще» and may legitimately be sent more than once). */
  function alreadyRated(subjectKey?: string): boolean {
    return !!subjectKey && ratedSubjects.has(subjectKey)
  }

  function rememberRated(subjectKey?: string): void {
    if (subjectKey) ratedSubjects.add(subjectKey)
  }

  return { enabled, ensureEnabled, submit, alreadyRated, rememberRated }
}
