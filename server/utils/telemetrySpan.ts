// Manual-span helpers over @opentelemetry/api (#78). The API is a thin, always-safe import:
// when NO SDK is registered (telemetry off — the default), `getTracer().startSpan()` returns
// a non-recording no-op span, so every helper here is ZERO overhead and changes nothing. The
// preload (otel.instrument.mjs) registers the real SDK only when an OTLP endpoint is set.
//
// All attributes go through the PII allowlist (`pickSafeAttributes`) — a caller physically
// cannot attach payment purpose / amount / account to a span (docs/PRIVACY.md). Attribute
// computation is gated behind `span.isRecording()` so the OFF path pays nothing (no hashing).

import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import type { Span } from '@opentelemetry/api'
import { pickSafeAttributes, portalHash } from './telemetryAttributes'

const TRACER_NAME = 'client-bank-alfa-by'

/** Set only the allowlisted (PII-safe) attributes on a span. SafeAttrValue is a scalar, so it
 *  is directly an OTel AttributeValue — no cast. */
function setSafe(span: Span, attributes: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(pickSafeAttributes(attributes))) span.setAttribute(k, v)
}

/** A dependency call we time as its own span: an external system + a logical operation. */
export interface DependencySpanInfo {
  /** External system: 'bitrix24' | 'alfa' | 'prior'. */
  system: string
  /** Logical operation name, e.g. a REST method 'crm.item.list' or 'oauth.refresh'. */
  operation: string
  /** HTTP verb / REST method, optional. */
  method?: string
  /** B24 scope, e.g. 'crm', optional. */
  scope?: string
  /** Portal member id — hashed into `portal.hash`, never emitted raw. */
  memberId?: string
  /** Command count for a batch dependency call → `dep.op_count` (shape, not content). */
  opCount?: number
}

/**
 * Sanitized error label for a span — a short token from the error's `code`/`name`, NEVER its
 * `message` (which could carry account numbers / amounts). Keeps only `[A-Za-z0-9_.-]`, caps
 * at 64 chars; unknown ⇒ 'error'. Pure — unit-tested.
 */
export function errorKind(e: unknown): string {
  const raw = (e as { code?: unknown, name?: unknown })?.code ?? (e as { name?: unknown })?.name ?? 'error'
  const token = String(raw).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
  return token || 'error'
}

/**
 * Run `fn` inside a dependency span (B24 REST / bank OAuth). On success tags `dep.status=ok`;
 * on throw tags `dep.status=error` + a sanitized `dep.error_kind`, sets ERROR status, and
 * RETHROWS (never swallows). No-op overhead when telemetry is off.
 */
export async function withDependencySpan<T>(info: DependencySpanInfo, fn: () => Promise<T>): Promise<T> {
  const span = trace.getTracer(TRACER_NAME).startSpan(`dep ${info.system} ${info.operation}`)
  // Only compute/hash attributes when the span actually records (telemetry on).
  if (span.isRecording()) {
    setSafe(span, {
      'dep.system': info.system,
      'dep.operation': info.operation,
      'dep.method': info.method ?? '',
      'dep.scope': info.scope ?? '',
      'portal.hash': portalHash(info.memberId),
      ...(info.opCount !== undefined ? { 'dep.op_count': info.opCount } : {})
    })
  }
  // Run `fn` with THIS span active in the OTel context, so any child span created inside it
  // (auto pg/ioredis/undici, or a nested manual span) parents under it → a real trace TREE,
  // not orphan roots. No-op when off (the no-op context manager just calls `fn`).
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn()
      span.setAttribute('dep.status', 'ok')
      return result
    } catch (e) {
      span.setAttribute('dep.status', 'error')
      span.setAttribute('dep.error_kind', errorKind(e))
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw e
    } finally {
      span.end()
    }
  })
}

/**
 * Run `fn` inside a generic named span, tagging only the given SAFE attributes (allowlisted).
 * `finalize(result)` may return extra safe attributes to set at the end (e.g. job outcome
 * counts). Rethrows on error with `job.outcome=error` + sanitized `job.error_kind`.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: () => Promise<T>,
  finalize?: (result: T) => Record<string, unknown>
): Promise<T> {
  const span = trace.getTracer(TRACER_NAME).startSpan(name)
  if (span.isRecording()) setSafe(span, attributes)
  // Activate the span for `fn` so its child spans (auto pg/ioredis/undici + nested manual dep
  // spans) nest under this job/cron span → one trace tree. No-op when telemetry is off.
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn()
      if (span.isRecording() && finalize) setSafe(span, finalize(result))
      span.setAttribute('job.outcome', 'ok')
      return result
    } catch (e) {
      span.setAttribute('job.outcome', 'error')
      span.setAttribute('job.error_kind', errorKind(e))
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw e
    } finally {
      span.end()
    }
  })
}
