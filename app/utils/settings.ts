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
// Runtime allow-list of identifier kinds, kept in lock-step with the `IdentifierKind`
// union by TYPE: a `Record<IdentifierKind, true>` forces every member to appear here —
// a new kind added to `purposeMatch` won't compile until it's listed (mirrors the
// exhaustive `IDENTIFIER_ROUTES` table in identifierDispatch.ts). Without this a missed
// kind would be silently dropped by `cleanRecognition` instead of failing the build.
const IDENTIFIER_KIND_TABLE: Record<IdentifierKind, true> = {
  'invoice-number': true, 'invoice-id': true, 'deal-id': true, 'deal-field': true,
  'order-id': true, 'order-number': true, 'payment-id': true, 'payment-number': true,
  'smart-id': true, 'smart-field': true, 'document-number': true
}
const IDENTIFIER_KIND_SET = new Set<string>(Object.keys(IDENTIFIER_KIND_TABLE))

// Keys that must never be written into a plain-object map built from untrusted JSON —
// they would shadow/pollute the prototype chain. `configFields` skips them defensively
// (JSON.parse + string-only values already make this safe, but the guard documents the
// invariant so a future refactor to spread/Object.assign can't quietly open a hole).
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Coerce an unknown to a trimmed, length-clamped string (empty for non-strings). */
function clampStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

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
  const alphabet: Alphabet = typeof obj.alphabet === 'string' && VALID_ALPHABETS.includes(obj.alphabet as Alphabet)
    ? obj.alphabet as Alphabet
    : 'cyrillic'

  // Bound the iteration itself (not just the accepted count): an invalid-heavy array
  // would otherwise be scanned in full. A legit config never exceeds the cap, so
  // slicing to it first can't drop a genuine matrix.
  const matrices: MatchMatrix[] = []
  if (Array.isArray(obj.matrices)) {
    for (const raw of obj.matrices.slice(0, MAX_MATRICES)) {
      const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const mask = clampStr(m.mask, MAX_MASK_CHARS)
      const kind = typeof m.kind === 'string' && IDENTIFIER_KIND_SET.has(m.kind) ? m.kind as IdentifierKind : null
      if (!mask || !kind) continue // both required
      const note = clampStr(m.note, MAX_NOTE_LEN)
      matrices.push({ mask, kind, ...(note ? { note } : {}) })
    }
  }

  const configFields: Record<string, string> = {}
  if (obj.configFields && typeof obj.configFields === 'object' && !Array.isArray(obj.configFields)) {
    for (const [k, val] of Object.entries(obj.configFields as Record<string, unknown>).slice(0, MAX_CONFIG_FIELDS)) {
      const key = clampStr(k, MAX_FIELD_LEN)
      const field = clampStr(val, MAX_FIELD_LEN)
      if (key && field && !UNSAFE_KEYS.has(key)) configFields[key] = field // drop blank/prototype-polluting key or blank field
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
  return clampStr(v, MAX_DIALOG_ID_LEN)
}

/** Attach a cleaned `title` to a target only when non-empty AND the target has a
 *  dialog id (a title without an id is meaningless — no chat selected). Keeps the
 *  shape minimal (no `title` key when unset), so defaults/round-trips stay clean. */
function withTitle<T extends { dialogId: string }>(raw: unknown, target: T): T {
  const title = clampStr(raw, MAX_ITEM_LEN)
  return title && target.dialogId ? { ...target, title } : target
}

/** Serialize settings to the JSON string stored in `app.option`. */
export function serializePortalSettings(s: PortalSettings): string {
  return JSON.stringify(s)
}
