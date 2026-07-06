import type { OperationDirection } from '~/types/statement'
import type { ChatNotifyRules } from '~/utils/statement'

// Per-portal application settings, persisted as a JSON string in the portal's
// `app.option` (server reads by OAuth token, UI writes by frame token — same
// namespace). Pure: schema + defensive parse/serialize, no I/O, fully unit-tested.
//
// The `app.option` value is an UNTYPED string that a portal admin could in theory
// edit, so `parsePortalSettings` never trusts it: it try/parses, coerces every field,
// and falls back to defaults on anything corrupt — it can't throw.
//
// Top-level object (not chat-only) so it grows with PROCESSING.md §4 (получатель
// ошибок, распределение, стадия инвойса, …) without a key migration.
//
// SECURITY: NEVER store the bank apiKey (Alfa secret) here — app.option is readable
// in any app-admin context. Only chat target + notify rules live here.

const VALID_DIRECTIONS: readonly OperationDirection[] = ['credit', 'debit']

/** Chat-notification settings: where to announce + which operations. */
export interface ChatSettings {
  /** B24 dialog id (e.g. "chat2941"). Empty ⇒ no target ⇒ notifications off. */
  dialogId: string
  /** Filter rules (directions / excluded accounts / excluded purpose patterns). */
  rules: ChatNotifyRules
}

/** A bare chat target (dialog id only). Used for the error chat, which has no
 *  per-operation rules — every processing error goes there (business tone, app-name
 *  prefix; см. docs/PROCESSING.md §5). Empty ⇒ error reporting off. */
export interface ChatTarget {
  dialogId: string
}

/** The full settings blob stored under one `app.option` key. */
export interface PortalSettings {
  /** Notification chat (target + filter rules). */
  chat: ChatSettings
  /** Error chat — where the app reports processing failures (separate from the
   *  notification chat; см. PROCESSING.md §5, чат ошибок а не пользователь). */
  errorChat: ChatTarget
}

/** The single `app.option` key holding the JSON settings blob (versioned name). */
export const SETTINGS_KEY = 'cb_settings_v1'

export function defaultChatSettings(): ChatSettings {
  return { dialogId: '', rules: { directions: ['credit'], excludeAccounts: [], excludePurposePatterns: [] } }
}

export function defaultPortalSettings(): PortalSettings {
  return { chat: defaultChatSettings(), errorChat: { dialogId: '' } }
}

/** Trim, drop blanks, dedupe — for the exclusion lists (unknown input). */
function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  for (const raw of v) {
    const s = String(raw).trim()
    if (s) seen.add(s)
  }
  return [...seen]
}

/** Coerce `directions`: keep valid values in order; only fall back to the default
 *  when the field is missing/not-an-array. An explicit `[]` (both switches off) is a
 *  legitimate "announce nothing" and is preserved. */
function cleanDirections(v: unknown): OperationDirection[] {
  if (!Array.isArray(v)) return ['credit']
  const out: OperationDirection[] = []
  for (const d of VALID_DIRECTIONS) {
    if (v.includes(d)) out.push(d)
  }
  return out
}

/**
 * Parse the stored JSON string into typed settings. Defensive: `null`/empty/corrupt/
 * partial input all yield sane defaults (never throws, never NaN/undefined fields).
 */
export function parsePortalSettings(raw: string | null | undefined): PortalSettings {
  let obj: Record<string, unknown> = {}
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>
    } catch {
      return defaultPortalSettings()
    }
  }
  const chatRaw = (obj.chat ?? {}) as Record<string, unknown>
  const rulesRaw = (chatRaw.rules ?? {}) as Record<string, unknown>
  const errorRaw = (obj.errorChat ?? {}) as Record<string, unknown>
  return {
    chat: {
      dialogId: cleanDialogId(chatRaw.dialogId),
      rules: {
        directions: cleanDirections(rulesRaw.directions),
        excludeAccounts: cleanList(rulesRaw.excludeAccounts),
        excludePurposePatterns: cleanList(rulesRaw.excludePurposePatterns)
      }
    },
    errorChat: { dialogId: cleanDialogId(errorRaw.dialogId) }
  }
}

/** Coerce a dialog id: trimmed string, else empty (non-string ⇒ off). */
function cleanDialogId(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Serialize settings to the JSON string stored in `app.option`. */
export function serializePortalSettings(s: PortalSettings): string {
  return JSON.stringify(s)
}
