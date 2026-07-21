import { withSpan } from './telemetrySpan'
import { portalHash } from './telemetryAttributes'

// Shared manual-OTel wrapper for frame-token HTTP routes (телеметрия, DEFAULT OFF). Emits ONE span
// per request with latency + a PII-safe outcome + hashed portal id — never the request body or any
// business content (settings blob / chat ids / statement data / feedback text). Matches the
// /api/settings spans. Zero overhead when telemetry is off (withSpan gates on span.isRecording();
// portal.hash is computed in finalize, which runs ONLY when recording).
//
// Usage: extract the frame domain first (sync, for portal.hash), then set `span.outcome` — either at
// each early return inside the handler, or once from the handler's status via `httpOutcomeForStatus`.
// `http.outcome` is a conventional PII-safe label:
//   ok | no_auth | auth_failed | forbidden | bad_request | conflict | unavailable | upstream_error

export interface RouteSpan { outcome: string }

export interface FrameRouteSpanInfo {
  /** Span name, e.g. 'http.chat-search.get'. */
  name: string
  /** HTTP verb: 'GET' | 'POST'. */
  method: string
  /** Logical route op, e.g. 'chat-search.search'. */
  op: string
  /** Portal domain from the frame auth (hashed → portal.hash; undefined ⇒ 'unknown'). */
  domain: string | undefined
}

/** Run a frame-route handler inside a span. The handler mutates `span.outcome` (defaults 'ok'). */
export function withFrameRouteSpan<T>(info: FrameRouteSpanInfo, fn: (span: RouteSpan) => Promise<T>): Promise<T> {
  const span: RouteSpan = { outcome: 'ok' }
  return withSpan(
    info.name,
    { 'http.method': info.method, 'http.op': info.op },
    () => fn(span),
    () => ({ 'http.outcome': span.outcome, 'portal.hash': portalHash(info.domain) })
  )
}
