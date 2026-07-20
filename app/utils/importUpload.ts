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

/** Max accepted file size — statement text exports are small (KBs, rarely a couple
 *  hundred KB); cap well above a real file but far below anything that would freeze
 *  the browser during the synchronous windows-1251 decode + parse. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024
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

/** Minimal file shape the batch processor needs — the browser `File` satisfies it
 *  structurally, and tests can pass plain objects (no DOM). */
export interface UploadFileLike {
  name: string
  size: number
  arrayBuffer: () => Promise<ArrayBuffer | Uint8Array>
}

/** Result of processing a drop: per-file outcomes + how many files were dropped for
 *  exceeding {@link MAX_UPLOAD_FILES} (so the UI can surface it, not truncate silently). */
export interface UploadBatchResult {
  results: UploadItemResult[]
  /** Count of files beyond the cap that were NOT processed (0 when within cap). */
  truncated: number
}

/** Yield to the event loop once — the browser `defer` for {@link processUploadBatch}
 *  so a large batch doesn't freeze the tab between files. Shared by the upload UIs
 *  (StatementUpload, LandingDemo) so the helper isn't re-declared per component. */
export function deferToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve))
}

/** Process a dropped/picked batch: cap the count, validate + decode + parse each file
 *  in isolation (one bad file never sinks the rest), and report how many were dropped
 *  for exceeding the cap. Pure except for the injected per-file reads; `defer` yields
 *  to the event loop between files so a big batch doesn't freeze the tab (default no-op
 *  keeps tests synchronous/deterministic). */
export async function processUploadBatch(
  files: UploadFileLike[],
  defer: () => Promise<void> = () => Promise.resolve()
): Promise<UploadBatchResult> {
  const batch = files.slice(0, MAX_UPLOAD_FILES)
  const truncated = files.length - batch.length
  const results: UploadItemResult[] = []
  for (const file of batch) {
    const invalid = validateUploadFile(file.name, file.size)
    if (invalid) {
      results.push({ name: file.name, ok: false, items: [], error: invalid })
      continue
    }
    try {
      const items = decodeAndParse(await file.arrayBuffer())
      results.push({ name: file.name, ok: true, items })
    } catch (e) {
      results.push({ name: file.name, ok: false, items: [], error: uploadErrorMessage(e) })
    }
    await defer()
  }
  return { results, truncated }
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

/** Decode a windows-1251 statement buffer to text. TextDecoder is available in both the
 *  browser and Node, so this is unit-testable on fixtures. Shared by {@link decodeAndParse}
 *  (parse path) and the feedback file-attach (the raw statement text embedded in the issue). */
export function decodeUploadText(buffer: ArrayBuffer | Uint8Array): string {
  return new TextDecoder('windows-1251').decode(buffer)
}

/** Decode a windows-1251 statement buffer and parse it into operations. `account`
 *  empty ⇒ use the file's own account (the parser reads it). */
export function decodeAndParse(buffer: ArrayBuffer | Uint8Array, account = ''): StatementItem[] {
  return normalizeManualStatement(decodeUploadText(buffer), { account })
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
