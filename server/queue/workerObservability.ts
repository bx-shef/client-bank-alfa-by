// Worker failure/error VISIBILITY (#78, #242). BullMQ Workers are created without any `failed`/
// `error` listeners, so an EXHAUSTED job failure (all retries spent) or a WORKER-LEVEL error (e.g. a
// Redis connection drop) is completely SILENT — the only trace is an OTel span, which is a no-op unless
// the collector is running (default OFF, docs/OBSERVABILITY.md). That means "the worker died / jobs are
// failing" is invisible in logs today. This wires greppable, PII-safe log lines onto every worker, so
// on-call (and any future log-based alert) can see failures without the collector.
//
// PRIVACY (docs/PRIVACY.md): the log line carries ONLY the queue name, attempt counters, and the error
// message — NEVER `job.data` (statement content) and NEVER the raw jobId (a fetch/crm jobId embeds an
// account number via fetchJobId). Our own errors don't carry statement content; a stray B24 error text
// is acceptable operationally (matches the existing `console.error(..., (e).message)` convention).

/** Minimal shape we need off a BullMQ Worker — structurally satisfied by the real `Worker` (which
 *  extends EventEmitter), and trivially faked in tests. Kept loose (`unknown[]`) so the two event
 *  shapes (`failed`: job, err, prev / `error`: err) both fit one listener signature. */
export interface WorkerLike {
  name: string
  on(event: 'failed' | 'error', listener: (...args: unknown[]) => void): unknown
}

/** A BullMQ-job-ish subset we read for the log line. Everything optional — the `failed` event can, in
 *  rare races, hand an undefined job, and we must never throw from a log handler. */
export interface FailedJobLike {
  attemptsMade?: number
  opts?: { attempts?: number }
}

export interface WorkerObservabilityDeps {
  error: (msg: string) => void
  warn: (msg: string) => void
}

/** Total attempts configured for a job (BullMQ default is 1 when `attempts` is unset). */
function totalAttempts(job: FailedJobLike | undefined): number {
  const a = job?.opts?.attempts
  return typeof a === 'number' && a > 0 ? a : 1
}

/**
 * Build the PII-safe failure log line for a `failed` event. `final` is true once the job has spent all
 * its attempts (this is the loud, alert-worthy case); a non-final failure is an expected retry. NEVER
 * includes job.data or the raw jobId (see the module header).
 */
export function formatJobFailure(queue: string, job: FailedJobLike | undefined, err: unknown): { final: boolean, line: string } {
  const attempts = totalAttempts(job)
  const made = job?.attemptsMade ?? 0
  const final = made >= attempts
  const msg = err instanceof Error ? err.message : String(err)
  const tag = final ? 'queue-job-failed' : 'queue-job-retry'
  const line = `[${tag}] queue=${queue} attempt=${made}/${attempts}${final ? ' FINAL' : ''} error=${msg}`
  return { final, line }
}

/** Build the log line for a worker-level (`error`) event — connection/Redis errors, always loud. */
export function formatWorkerError(queue: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return `[queue-worker-error] queue=${queue} error=${msg}`
}

/**
 * Wire failure/error visibility onto a worker (#78):
 *  - `failed` fires per attempt → a non-final attempt logs at `warn` (expected retry), the final
 *    (exhausted) attempt logs at `error` (loud — what an alert keys on);
 *  - `error` (worker/connection level) always logs at `error`.
 * Idempotent-agnostic: call once per worker at startup.
 */
export function attachWorkerObservability(worker: WorkerLike, deps: WorkerObservabilityDeps): void {
  const queue = worker.name
  worker.on('failed', (...args: unknown[]) => {
    const [job, err] = args as [FailedJobLike | undefined, unknown]
    const { final, line } = formatJobFailure(queue, job, err)
    if (final) deps.error(line)
    else deps.warn(line)
  })
  worker.on('error', (...args: unknown[]) => {
    deps.error(formatWorkerError(queue, args[0]))
  })
}
