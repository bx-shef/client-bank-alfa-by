// Manual-import ingest — pure logic over injected I/O (DI), so it is unit-testable
// without the network or a DB. The route (server/api/import.post.ts) is thin I/O.
//
// Flow: browser POSTs the RAW file (single parse authority is the server) with the
// B24 frame token. We (1) gate the file (extension + size), (2) resolve the portal
// we hold tokens for by its domain — absent ⇒ app not installed ⇒ reject ("no key",
// like the worker's packet-reject rule), (3) validate the frame token actually works
// against that domain (blocks domain spoofing — a token from another portal fails),
// then enqueue a file-parse packet carrying the file. The worker parses + hands off
// to crm-sync. See docs/PROCESSING.md §0.

import { validateUploadFile } from '../../app/utils/importUpload'
import { normalizeManualStatement } from '../../app/utils/manualImport'
import type { StatementItem } from '../../app/types/statement'
import type { ParseJob } from '../queue/topology'

export interface IngestResult {
  status: number
  body: Record<string, unknown>
}

/** Injected side-effects (live wiring in server/api/import.post.ts). */
export interface IngestDeps {
  /** Validate the frame token against `domain` via a cheap REST call; resolves the
   *  initiating user id, or THROWS if the token isn't valid for that portal. */
  validateFrame: (domain: string, accessToken: string) => Promise<string>
  /** member_id of the portal we hold tokens for, by domain; null if not installed. */
  memberIdByDomain: (domain: string) => Promise<string | null>
  /** Enqueue the parse packet (no-op → false when Redis is absent). */
  enqueueParse: (job: ParseJob) => Promise<boolean>
  /** Content hash (sha256 hex) for the idempotent job id. */
  hash: (bytes: Uint8Array) => string
}

export interface IngestInput {
  accessToken: string
  domain: string
  fileName: string
  bytes: Uint8Array
}

/**
 * Accept one uploaded statement file for async import. Returns 202 + a `batchId`
 * (the content hash) on success — the actual parse + CRM write happen in the worker
 * (fire-and-forget; the UI shows the operation count from its own preview). The file
 * is NOT parsed here — the server re-parses authoritatively in the worker.
 */
export async function handleImportUpload(deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  const { accessToken, domain, fileName, bytes } = input
  if (!accessToken || !domain) {
    return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  }
  // File gate first (cheapest): extension allowlist + size cap (windows-1251 .txt, ≤2МБ).
  const invalid = validateUploadFile(fileName, bytes.byteLength)
  if (invalid) return { status: 400, body: { error: invalid } }

  // Portal key check — do we hold tokens for this domain's portal? Absent ⇒ the app
  // was never installed / already uninstalled ⇒ nowhere to write ⇒ reject (§0).
  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed (no key)' } }

  // Prove the frame token really belongs to THIS portal (a token minted for another
  // portal fails against this domain) — otherwise a caller could spoof X-B24-Domain.
  let userId: string
  try {
    userId = await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token for this portal' } }
  }

  const fileHash = deps.hash(bytes)
  const job: ParseJob = {
    memberId,
    providerId: 'manual',
    fileName,
    contentBase64: bytesToBase64(bytes),
    fileHash,
    userId: userId || undefined
  }
  const enqueued = await deps.enqueueParse(job)
  if (!enqueued) return { status: 503, body: { error: 'import queue unavailable' } }
  return { status: 202, body: { accepted: true, batchId: fileHash } }
}

/** Decode a base64 windows-1251 statement (carried in the parse packet) and parse it
 *  into operations. Used by the worker's `parseFile` transport; pure + testable. */
export function parseManualFileBase64(contentBase64: string): StatementItem[] {
  const bytes = base64ToBytes(contentBase64)
  const text = new TextDecoder('windows-1251').decode(bytes)
  return normalizeManualStatement(text, { account: '' })
}

/** base64 ↔ bytes without assuming a browser/Node global beyond what both provide.
 *  The ingest + worker run in Node (Buffer available); guarded for safety. */
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}
function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}
