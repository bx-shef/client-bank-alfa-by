import { describe, expect, it, vi } from 'vitest'
import {
  attachWorkerObservability,
  formatJobFailure,
  formatWorkerError,
  type WorkerLike
} from '../server/queue/workerObservability'

describe('formatJobFailure', () => {
  it('marks the exhausted (final) attempt loud, non-final as retry', () => {
    const final = formatJobFailure('crm-sync', { attemptsMade: 3, opts: { attempts: 3 } }, new Error('boom'))
    expect(final.final).toBe(true)
    expect(final.line).toContain('[queue-job-failed]')
    expect(final.line).toContain('queue=crm-sync')
    expect(final.line).toContain('attempt=3/3')
    expect(final.line).toContain('FINAL')
    expect(final.line).toContain('error=boom')

    const retry = formatJobFailure('crm-sync', { attemptsMade: 1, opts: { attempts: 3 } }, new Error('boom'))
    expect(retry.final).toBe(false)
    expect(retry.line).toContain('[queue-job-retry]')
    expect(retry.line).not.toContain('FINAL')
    expect(retry.line).toContain('attempt=1/3')
  })

  it('defaults attempts to 1 when unset → a single failure is final', () => {
    const r = formatJobFailure('bank-fetch', { attemptsMade: 1 }, new Error('x'))
    expect(r.final).toBe(true)
    expect(r.line).toContain('attempt=1/1')
  })

  it('tolerates an undefined job (rare race) without throwing', () => {
    const r = formatJobFailure('file-parse', undefined, new Error('x'))
    expect(r.final).toBe(false) // made=0, attempts=1 → 0 >= 1 is false (unknown → treated as non-final)
    expect(r.line).toContain('attempt=0/1')
  })

  it('coerces a non-Error rejection to string', () => {
    const r = formatJobFailure('crm-sync', { attemptsMade: 1, opts: { attempts: 1 } }, 'plain string')
    expect(r.line).toContain('error=plain string')
  })

  it('never leaks job.data or a raw jobId (PII: statement content / account in id)', () => {
    // A malicious/PII-bearing payload must not appear — the formatter only reads attempt counters.
    const job = {
      attemptsMade: 2,
      opts: { attempts: 2 },
      id: 'fetch|member42|alfa-by|BY13ALFA30120000000000000000|2026-01-01|2026-01-02',
      data: { account: 'BY13ALFA3012', items: [{ amount: 1000, purpose: 'секрет' }] }
    }
    const { line } = formatJobFailure('bank-fetch', job, new Error('upstream 500'))
    expect(line).not.toContain('BY13ALFA')
    expect(line).not.toContain('секрет')
    expect(line).not.toContain('member42')
    expect(line).toBe('[queue-job-failed] queue=bank-fetch attempt=2/2 FINAL error=upstream 500')
  })
})

describe('formatWorkerError', () => {
  it('builds a loud worker-level line', () => {
    expect(formatWorkerError('crm-sync', new Error('ECONNREFUSED'))).toBe(
      '[queue-worker-error] queue=crm-sync error=ECONNREFUSED'
    )
  })
})

/** A tiny fake worker capturing registered listeners, structurally a WorkerLike. */
function fakeWorker(name: string) {
  const handlers: Record<string, (...args: unknown[]) => void> = {}
  const worker: WorkerLike = {
    name,
    on(event, listener) {
      handlers[event] = listener
      return worker
    }
  }
  return { worker, handlers }
}

describe('attachWorkerObservability', () => {
  it('routes final failures to error and retries to warn', () => {
    const { worker, handlers } = fakeWorker('crm-sync')
    const error = vi.fn()
    const warn = vi.fn()
    attachWorkerObservability(worker, { error, warn })

    handlers.failed!({ attemptsMade: 1, opts: { attempts: 3 } }, new Error('transient'))
    expect(warn).toHaveBeenCalledOnce()
    expect(error).not.toHaveBeenCalled()
    expect(warn.mock.calls[0]![0]).toContain('[queue-job-retry]')

    handlers.failed!({ attemptsMade: 3, opts: { attempts: 3 } }, new Error('dead'))
    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0]![0]).toContain('[queue-job-failed]')
    expect(error.mock.calls[0]![0]).toContain('FINAL')
  })

  it('routes worker-level error events to error', () => {
    const { worker, handlers } = fakeWorker('bank-fetch')
    const error = vi.fn()
    const warn = vi.fn()
    attachWorkerObservability(worker, { error, warn })

    handlers.error!(new Error('redis gone'))
    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0]![0]).toBe('[queue-worker-error] queue=bank-fetch error=redis gone')
    expect(warn).not.toHaveBeenCalled()
  })

  it('registers both failed and error listeners', () => {
    const { worker, handlers } = fakeWorker('q')
    attachWorkerObservability(worker, { error: vi.fn(), warn: vi.fn() })
    expect(typeof handlers.failed).toBe('function')
    expect(typeof handlers.error).toBe('function')
  })
})
