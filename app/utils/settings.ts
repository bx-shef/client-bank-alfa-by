import type { OperationDirection } from '~/types/statement'
import type { ChatNotifyRules } from '~/utils/statement'
import type { Alphabet, IdentifierKind, MatchMatrix } from '~/utils/purposeMatch'
import { MAX_MASK_CHARS, MAX_MATRICES } from '~/utils/purposeMatch'

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

// Size caps (defense-in-depth): app.option is admin-writable, but we still never
// store unbounded values. A dialog id is short ("chat2941"); exclusion lists are
// human-maintained. Over-long/over-large input is clamped, not rejected.
const MAX_DIALOG_ID_LEN = 64
const MAX_LIST_ITEMS = 500
const MAX_ITEM_LEN = 256
// Recognition settings caps (§4). Matrix count / mask length mirror the recognizer's
// own DoS caps (`purposeMatch`) so what settings stores can't exceed what it consumes.
const MAX_NOTE_LEN = 256
const MAX_CONFIG_FIELDS = 200
const MAX_FIELD_LEN = 128

const VALID_ALPHABETS: readonly Alphabet[] = ['cyrillic', 'latin']
const IDENTIFIER_KINDS: readonly IdentifierKind[] = [
  'invoice-number', 'invoice-id', 'deal-id', 'deal-field', 'order-id', 'order-number',
  'payment-id', 'payment-number', 'smart-id', 'smart-field', 'document-number'
]
const IDENTIFIER_KIND_SET = new Set<string>(IDENTIFIER_KINDS)

/** Chat-notification settings: where to announce + which operations. */
export interface ChatSettings {
  /** B24 dialog id (e.g. "chat2941"). Empty ⇒ no target ⇒ notifications off. */
  dialogId: string
  /** Chat display name, cached at selection time — a UI convenience so the picker
   *  shows the name (not a raw id) on reload. Optional; the worker ignores it and
   *  needs only `dialogId`. May go stale if the chat is renamed (self-heals on re-pick). */
  title?: string
  /** Filter rules (directions / excluded accounts / excluded purpose patterns). */
  rules: ChatNotifyRules
}

/** A bare chat target (dialog id + optional cached title). Used for the error chat,
 *  which has no per-operation rules — every processing error goes there (business
 *  tone, app-name prefix; см. docs/PROCESSING.md §5). Empty ⇒ error reporting off. */
export interface ChatTarget {
  dialogId: string
  /** Cached display name (UI convenience; see ChatSettings.title). */
  title?: string
}

/** Payment-purpose recognition config (#109, PROCESSING.md §4). Drives
 *  `recognizeByMatrices` (matrices + alphabet) and the deal-field/smart-field
 *  lookups (`configFields`). All portal-configured — the recognizer ships no
 *  hard-coded numbers/prefixes. */
export interface RecognitionSettings {
  /** Which alphabet homoglyphs fold to before matching (`ВОРС`↔`BOPC`). */
  alphabet: Alphabet
  /** Recognition matrices (`mask` → `kind`), from «карта сопоставления» §4. */
  matrices: MatchMatrix[]
  /** Configured CRM field names for the `deal-field`/`smart-field` kinds: a config
   *  key → the field (`UF_CRM_*` / `UF_*`) the number lives in. The exact key scheme
   *  (per deal direction / per smart process + direction, §4) is finalized at the
   *  deal-field/smart-field lookup slice; stored generically so the shape can settle
   *  WITHOUT an `app.option` key migration. */
  configFields: Record<string, string>
}

/** The full settings blob stored under one `app.option` key. */
export interface PortalSettings {
  /** Notification chat (target + filter rules). */
  chat: ChatSettings
  /** Error chat — where the app reports processing failures (separate from the
   *  notification chat; см. PROCESSING.md §5, чат ошибок а не пользователь). */
  errorChat: ChatTarget
  /** Payment-purpose recognition (matrices + alphabet + config-field map, §4). */
  recognition: RecognitionSettings
}

/** The single `app.option` key holding the JSON settings blob (versioned name). */
export const SETTINGS_KEY = 'cb_settings_v1'

export function defaultChatSettings(): ChatSettings {
  return { dialogId: '', rules: { directions: ['credit'], excludeAccounts: [], excludePurposePatterns: [] } }
}

export function defaultRecognitionSettings(): RecognitionSettings {
  return { alphabet: 'cyrillic', matrices: [], configFields: {} }
}

export function defaultPortalSettings(): PortalSettings {
  return { chat: defaultChatSettings(), errorChat: { dialogId: '' }, recognition: defaultRecognitionSettings() }
}

/** Trim, drop blanks, dedupe, and clamp size — for the exclusion lists (unknown
 *  input). Each entry is capped in length; the list is capped in count. */
function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  for (const raw of v) {
    const s = String(raw).trim().slice(0, MAX_ITEM_LEN)
    if (s) seen.add(s)
    if (seen.size >= MAX_LIST_ITEMS) break
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

/** Coerce the recognition section defensively: valid alphabet else default; keep
 *  only well-formed matrices (non-empty mask, known kind) capped in count/length;
 *  config-field map coerced to string→string, blanks dropped, clamped. */
function cleanRecognition(v: unknown): RecognitionSettings {
  const obj = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const alphabet = VALID_ALPHABETS.includes(obj.alphabet as Alphabet) ? obj.alphabet as Alphabet : 'cyrillic'

  const matrices: MatchMatrix[] = []
  if (Array.isArray(obj.matrices)) {
    for (const raw of obj.matrices) {
      if (matrices.length >= MAX_MATRICES) break
      const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const mask = typeof m.mask === 'string' ? m.mask.trim().slice(0, MAX_MASK_CHARS) : ''
      if (!mask || !IDENTIFIER_KIND_SET.has(m.kind as string)) continue // both required
      const note = typeof m.note === 'string' ? m.note.trim().slice(0, MAX_NOTE_LEN) : ''
      matrices.push({ mask, kind: m.kind as IdentifierKind, ...(note ? { note } : {}) })
    }
  }

  const configFields: Record<string, string> = {}
  if (obj.configFields && typeof obj.configFields === 'object' && !Array.isArray(obj.configFields)) {
    for (const [k, val] of Object.entries(obj.configFields as Record<string, unknown>)) {
      if (Object.keys(configFields).length >= MAX_CONFIG_FIELDS) break
      const key = k.trim().slice(0, MAX_FIELD_LEN)
      const field = typeof val === 'string' ? val.trim().slice(0, MAX_FIELD_LEN) : ''
      if (key && field) configFields[key] = field // drop blank key or non-string/blank field
    }
  }

  return { alphabet, matrices, configFields }
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
    chat: withTitle(chatRaw.title, {
      dialogId: cleanDialogId(chatRaw.dialogId),
      rules: {
        directions: cleanDirections(rulesRaw.directions),
        excludeAccounts: cleanList(rulesRaw.excludeAccounts),
        excludePurposePatterns: cleanList(rulesRaw.excludePurposePatterns)
      }
    }),
    errorChat: withTitle(errorRaw.title, { dialogId: cleanDialogId(errorRaw.dialogId) }),
    recognition: cleanRecognition(obj.recognition)
  }
}

/** Coerce a dialog id: trimmed, length-clamped string, else empty (non-string ⇒ off). */
function cleanDialogId(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, MAX_DIALOG_ID_LEN) : ''
}

/** Attach a cleaned `title` to a target only when non-empty AND the target has a
 *  dialog id (a title without an id is meaningless — no chat selected). Keeps the
 *  shape minimal (no `title` key when unset), so defaults/round-trips stay clean. */
function withTitle<T extends { dialogId: string }>(raw: unknown, target: T): T {
  const title = typeof raw === 'string' ? raw.trim().slice(0, MAX_ITEM_LEN) : ''
  return title && target.dialogId ? { ...target, title } : target
}

/** Serialize settings to the JSON string stored in `app.option`. */
export function serializePortalSettings(s: PortalSettings): string {
  return JSON.stringify(s)
}
