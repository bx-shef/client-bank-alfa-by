// Pure core for the manual statement-upload UI (P4). Validation, windows-1251
// decode + parse, and cross-file de-dup — no DOM. The reactive dropzone lives in
// `app/components/StatementUpload.vue`; the parsing itself is the already-tested
// `normalizeManualStatement` (manualImport.ts). Slice 1 is parse + preview only —
// writing the parsed batch to CRM (file-parse → crm-sync queue) is a later slice.
//
// Files are windows-1251 (Приор/Альфа/1С exports); decode BEFORE parsing. A file
// gate (size + extension) runs before decode as the first line of defence; the
// parser has its own char cap (MAX_CLIENT_BANK_CHARS, #19).

import { normalizeManualStatement } from '~/utils/manualImport'
import { dedupKey } from '~/utils/statement'
import type { StatementItem } from '~/types/statement'

/** Max accepted file size — statement text exports are small (KBs); cap well above
 *  a real file but far below anything that would freeze the browser. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
/** Max files per drop (mirrors the sibling upload UI's batch cap). */
export const MAX_UPLOAD_FILES = 10
/** Accepted extensions — both supported formats are plain text. */
export const ACCEPTED_EXTENSIONS = ['.txt'] as const

/** Per-file parse outcome shown in the upload list. */
export interface UploadItemResult {
  name: string
  ok: boolean
  /** Parsed operations (empty on error). */
  items: StatementItem[]
  /** Human message on failure. */
  error?: string
}

/** Validate a file before decoding: extension allowlist + size cap. Returns an
 *  error message, or null if acceptable. */
export function validateUploadFile(name: string, size: number): string | null {
  const lower = name.toLowerCase()
  if (!ACCEPTED_EXTENSIONS.some(ext => lower.endsWith(ext))) {
    return `Неподдерживаемый тип файла (нужен ${ACCEPTED_EXTENSIONS.join('/')})`
  }
  if (size === 0) return 'Пустой файл'
  if (size > MAX_UPLOAD_BYTES) {
    return `Файл слишком большой (> ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ)`
  }
  return null
}

/** Decode a windows-1251 statement buffer and parse it into operations. `account`
 *  empty ⇒ use the file's own account (the parser reads it). TextDecoder is
 *  available in both the browser and Node, so this is unit-testable on fixtures. */
export function decodeAndParse(buffer: ArrayBuffer | Uint8Array, account = ''): StatementItem[] {
  const text = new TextDecoder('windows-1251').decode(buffer)
  return normalizeManualStatement(text, { account })
}

/** Short user message from a parse error (normalizeManualStatement throws a RU
 *  message for an unknown format; keep it if sane, else a generic fallback). */
export function uploadErrorMessage(e: unknown): string {
  const msg = (e as Error)?.message
  return msg && msg.length <= 200 ? msg : 'Не удалось разобрать файл'
}

/** De-dup operations across files by `account|docId` — so a preview of several
 *  files (or the same file dropped twice) matches what crm-sync would actually
 *  write. Keeps first occurrence / order. */
export function dedupItems(items: StatementItem[]): StatementItem[] {
  const seen = new Set<string>()
  const out: StatementItem[] = []
  for (const it of items) {
    const key = dedupKey(it)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}
