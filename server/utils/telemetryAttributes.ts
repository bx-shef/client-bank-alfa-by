// Privacy policy for OpenTelemetry span attributes (#78, docs/PRIVACY.md). Telemetry must
// NEVER carry financial PII — payment purpose, counterparty name/УНП, account numbers, or
// amounts. This is the mirror of the article's whitelist approach (habr 1048228 «UIProfile»):
// our OWN manual spans emit ONLY an allowlisted set of safe keys, and AUTO-instrumentation
// attributes (which can leak SQL text / URLs with tokens) are redacted by a span processor.
//
// Pure — no OTel import here, so both layers are unit-testable. The SpanProcessor that calls
// `redactAttributes` lives in the preload (otel.instrument.mjs); the manual-span helpers call
// `pickSafeAttributes` before setting anything.

import { createHash } from 'node:crypto'

/** Attribute VALUE we allow on a span: a scalar primitive. Objects/arrays are dropped (they
 *  could smuggle a payload, and every attribute we emit is a scalar shape/count/hash anyway —
 *  keeping this scalar also makes the bag structurally an OTel `Attributes` with no cast). */
export type SafeAttrValue = string | number | boolean

/**
 * The ONLY attribute keys our manual spans may set. Everything describes the SHAPE of an
 * operation (which method, which queue, outcome, timing) — never its financial content.
 * A hashed portal id (`portal.hash`) lets us correlate per-portal without exposing member_id.
 */
export const SAFE_MANUAL_ATTR_KEYS = new Set<string>([
  // dependency call (B24 REST / bank OAuth)
  'dep.system', // 'bitrix24' | 'alfa' | 'prior'
  'dep.operation', // logical name, e.g. 'crm.item.list'
  'dep.method', // REST method / HTTP verb
  'dep.scope', // B24 scope, e.g. 'crm'
  'dep.status', // 'ok' | 'error'
  'dep.error_kind', // sanitized error class, never the message body
  'dep.op_count', // number of commands in a batch dependency call (shape, not content)
  // queue / job
  'job.queue', // 'crm-sync' | 'file-parse' | 'bank-fetch' | 'b24-events' | cron.*
  'job.provider', // BankProviderId
  'job.kind', // event job kind: 'ONAPPINSTALL' | 'ONAPPUNINSTALL' (event type, not content)
  'job.op_count', // number of operations in a batch / fetched / parsed count
  'job.outcome', // 'ok' | 'error'
  'job.error_kind', // sanitized error class on a job span (never the message)
  // allocation / processing OUTCOMES (counts + verdicts, never ids-from-purpose or amounts)
  'proc.recognized',
  'proc.resolved',
  'proc.allocated',
  'proc.ambiguous',
  'proc.manual',
  'proc.distributed',
  // correlation
  'portal.hash'
])

/** Keep only allowlisted keys whose value is a safe primitive/array. Drops everything else
 *  (unknown keys, objects, null/undefined) so a caller can't accidentally attach a payload. */
export function pickSafeAttributes(input: Record<string, unknown>): Record<string, SafeAttrValue> {
  const out: Record<string, SafeAttrValue> = {}
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!SAFE_MANUAL_ATTR_KEYS.has(key)) continue
    if (isSafePrimitive(value)) out[key] = value as SafeAttrValue
  }
  return out
}

function isSafePrimitive(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

/**
 * Attribute keys emitted by AUTO-instrumentation that can leak data and must be dropped
 * from every span before export. `db.statement`/`db.query.text` can carry SQL with literal
 * account/amount params; `*.url`/`*.query`/`*.target` can carry access tokens (our bank
 * callback / OAuth URLs); `*.body`/`*.message` can carry payloads. Belt-and-suspenders: the
 * collector also filters, but we scrub at the source so PII never leaves the process.
 */
export const REDACT_ATTR_KEYS = new Set<string>([
  'db.statement',
  'db.query.text',
  'http.url',
  'url.full',
  'url.query',
  'url.path', // stable-semconv server path — may embed an id in a future route
  'http.target',
  'http.route', // may embed ids; route templating is enough via span name
  'http.request.body',
  'http.response.body',
  'messaging.message.body',
  'messaging.message.payload'
])

/** Substring markers: any attribute key containing one of these is dropped (covers vendor
 *  drift like `db.statement.text`, `net.peer.body`, custom `*.token*`/`*.secret*`). */
const REDACT_KEY_MARKERS = ['body', 'payload', 'token', 'secret', 'password', 'authorization', 'cookie']

/** True if an attribute key must be scrubbed (exact match or a sensitive marker substring). */
export function isRedactedKey(key: string): boolean {
  if (REDACT_ATTR_KEYS.has(key)) return true
  const lower = key.toLowerCase()
  return REDACT_KEY_MARKERS.some(m => lower.includes(m))
}

/** Return a copy of the attribute bag with every sensitive key removed. Used by the export
 *  SpanProcessor over auto-instrumentation spans. Non-mutating. */
export function redactAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (isRedactedKey(key)) continue
    out[key] = value
  }
  return out
}

/**
 * Stable, NON-reversible short id for a portal (member_id), so telemetry can correlate a
 * portal's spans/metrics without exposing the member_id itself. SHA-256 → first 12 hex.
 * Empty/absent member ⇒ 'unknown' (never throws).
 */
export function portalHash(memberId: string | undefined | null): string {
  const id = (memberId ?? '').trim()
  if (!id) return 'unknown'
  return createHash('sha256').update(id).digest('hex').slice(0, 12)
}
