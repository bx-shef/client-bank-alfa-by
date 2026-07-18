// Portable OpenTelemetry bootstrap for a Node/Nitro app (#78, docs/OBSERVABILITY.md).
// Drop this file into an app, install the deps from package.json here, and run the app with
// `NODE_OPTIONS=--import /abs/path/otel.instrument.mjs`. Set two env vars and the app shows up
// in the shared station's Grafana (distinguished by OTEL_SERVICE_NAME). See README.md.
//
// DEFAULT OFF: no OTEL_EXPORTER_OTLP_ENDPOINT ⇒ starts nothing (the app runs unchanged).
//
// PRIVACY: a redaction SpanProcessor strips sensitive auto-instrumentation attributes
// (SQL text, URLs/tokens, bodies) before export. Keep DB queries PARAMETERIZED — span NAMES
// are not scrubbed, so a literal in a non-parameterized query would surface in the pg span name.

const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim()
const enabled = endpoint && (process.env.TELEMETRY_ENABLED ?? '1') !== '0'

if (!enabled) {
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
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'node-app',
    [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || 'dev'
  })

  const sdk = new NodeSDK({
    resource,
    spanProcessors: [redactionProcessor, new BatchSpanProcessor(new OTLPTraceExporter())],
    metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
    instrumentations: [getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: false }
    })]
  })

  sdk.start()
  console.info('[otel] started → %s (service=%s)', endpoint, process.env.OTEL_SERVICE_NAME || 'node-app')

  // Flush on shutdown but DO NOT process.exit — let the app own the exit (drain workers first).
  const shutdown = () => {
    sdk.shutdown().catch(() => {})
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}
