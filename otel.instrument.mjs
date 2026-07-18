// OpenTelemetry bootstrap for the Nitro backend (#78). Loaded via `NODE_OPTIONS=--import
// ./otel.instrument.mjs` BEFORE the app, so auto-instrumentation can hook http/pg/ioredis at
// module load (a Nitro plugin would be too late, and Nitro's bundler would break the require
// hooks — hence a preload with EXTERNAL node_modules, not a bundled import).
//
// DEFAULT OFF: with no `OTEL_EXPORTER_OTLP_ENDPOINT` set, this file starts NOTHING and the app
// runs exactly as before. Turn it on by pointing at a collector (see docs/OBSERVABILITY.md).
//
// PRIVACY (docs/PRIVACY.md): a redaction SpanProcessor strips sensitive auto-instrumentation
// attributes (SQL text, URLs/tokens, bodies) before export. Our OWN manual spans already emit
// only an allowlisted set (server/utils/telemetryAttributes.ts — the canonical list). The
// collector filters again (belt, suspenders, and a second belt).

const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim()
const enabled = endpoint && (process.env.TELEMETRY_ENABLED ?? '1') !== '0'

if (!enabled) {
  // No endpoint → telemetry off (the default). Say so once, then do nothing.
  console.info('[otel] disabled (no OTEL_EXPORTER_OTLP_ENDPOINT) — telemetry off')
} else {
  const { NodeSDK } = await import('@opentelemetry/sdk-node')
  const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node')
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
  const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-http')
  const { PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics')
  const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base')
  const { resourceFromAttributes } = await import('@opentelemetry/resources')
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import('@opentelemetry/semantic-conventions')

  // --- PII redaction (mirror of server/utils/telemetryAttributes.ts REDACT list; kept inline
  // because the preload can't import the app's TS bundle). Drops sensitive auto-instr attrs. ---
  const REDACT_EXACT = new Set([
    'db.statement', 'db.query.text', 'http.url', 'url.full', 'url.query', 'url.path', 'http.target',
    'http.route', 'http.request.body', 'http.response.body', 'messaging.message.body',
    'messaging.message.payload'
  ])
  const REDACT_MARKERS = ['body', 'payload', 'token', 'secret', 'password', 'authorization', 'cookie']
  const isRedacted = (key) => {
    if (REDACT_EXACT.has(key)) return true
    const lower = key.toLowerCase()
    return REDACT_MARKERS.some(m => lower.includes(m))
  }
  // NB: this scrubs span ATTRIBUTES, not span NAMES. Auto-instr span names are verbs / method
  // ids / PARAMETERIZED SQL — never literal values — so keeping DB queries parameterized is a
  // privacy-load-bearing invariant (a non-parameterized query with a literal amount would
  // surface in the pg span name and bypass this attribute scrub).
  const redactionProcessor = {
    onStart() {},
    onEnd(span) {
      const attrs = span.attributes
      if (!attrs) return
      for (const key of Object.keys(attrs)) {
        if (isRedacted(key)) delete attrs[key]
      }
    },
    forceFlush() { return Promise.resolve() },
    shutdown() { return Promise.resolve() }
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'client-bank-alfa-by-backend',
    [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || process.env.NUXT_PUBLIC_COMMIT_SHA || 'dev'
  })

  const sdk = new NodeSDK({
    resource,
    // Endpoint/headers come from env (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS).
    spanProcessors: [redactionProcessor, new BatchSpanProcessor(new OTLPTraceExporter())],
    metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
    instrumentations: [getNodeAutoInstrumentations({
      // fs spans are noise for a queue backend; disable them.
      '@opentelemetry/instrumentation-fs': { enabled: false },
      // pg: keep the parameterized statement OFF the "enhanced" mode so query PARAM VALUES
      // (which could be account/amount) are never captured. db.statement is still redacted above.
      '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: false }
    })]
  })

  sdk.start()
  console.info('[otel] started → %s (service=%s)', endpoint, process.env.OTEL_SERVICE_NAME || 'client-bank-alfa-by-backend')

  // Flush pending spans on shutdown — but DO NOT call process.exit(): the app (Nitro + BullMQ)
  // owns the exit and must finish draining in-flight jobs first (worker.close()). A forced
  // exit here would race that drain and abandon jobs. sdk.shutdown() just flushes; Nitro's own
  // signal handling ends the process after the drain completes.
  const shutdown = () => {
    sdk.shutdown().catch(() => {})
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}
