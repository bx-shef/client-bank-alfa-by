import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FETCH_RATE_DURATION_MS, DEFAULT_FETCH_RATE_MAX, MAX_CONCURRENCY,
  MAX_FETCH_RATE_MAX, MIN_FETCH_RATE_DURATION_MS, envFlag, queueRuntimeConfig
} from '../server/queue/runtime'

describe('envFlag', () => {
  it('defaults when unset or blank', () => {
    expect(envFlag(undefined, true)).toBe(true)
    expect(envFlag('', true)).toBe(true)
    expect(envFlag('   ', false)).toBe(false)
  })
  it('treats 0/false/no/off (any case) as false', () => {
    for (const v of ['0', 'false', 'FALSE', 'No', 'off', ' off ']) expect(envFlag(v, true)).toBe(false)
  })
  it('treats anything else as true', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'x']) expect(envFlag(v, false)).toBe(true)
  })
})

describe('queueRuntimeConfig', () => {
  it('defaults to a single-container role (workers + cron, concurrency 1, 100/60s fetch rate)', () => {
    expect(queueRuntimeConfig({})).toEqual({
      workers: true,
      cron: true,
      concurrency: 1,
      fetchRate: { max: DEFAULT_FETCH_RATE_MAX, duration: DEFAULT_FETCH_RATE_DURATION_MS }
    })
  })

  it('parses QUEUE_FETCH_RATE_* and falls back to defaults on garbage/non-positive (never disables)', () => {
    expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_MAX: '40', QUEUE_FETCH_RATE_DURATION_MS: '30000' }).fetchRate)
      .toEqual({ max: 40, duration: 30_000 })
    // A 0/negative/garbage value must NOT disable the cap — fall back to the default.
    for (const v of ['0', '-5', 'abc', '']) {
      expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_MAX: v }).fetchRate.max).toBe(DEFAULT_FETCH_RATE_MAX)
      expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_DURATION_MS: v }).fetchRate.duration).toBe(DEFAULT_FETCH_RATE_DURATION_MS)
    }
  })

  it('clamps the UPPER edges so a fat-fingered value cannot effectively disable the cap', () => {
    // Huge max → clamped to MAX_FETCH_RATE_MAX (else 999999/min ≈ no cap).
    expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_MAX: '999999' }).fetchRate.max).toBe(MAX_FETCH_RATE_MAX)
    // Tiny duration → floored to MIN_FETCH_RATE_DURATION_MS (else a 1ms window ≈ no cap).
    expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_DURATION_MS: '1' }).fetchRate.duration).toBe(MIN_FETCH_RATE_DURATION_MS)
    // A sane override within bounds is preserved.
    expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_MAX: '250', QUEUE_FETCH_RATE_DURATION_MS: '30000' }).fetchRate)
      .toEqual({ max: 250, duration: 30_000 })
  })

  it('parseInt leniency: trailing garbage keeps the leading number (still a positive cap)', () => {
    // Consistent with clampConcurrency's idiom; safe because it yields a positive cap, never 0/disabled.
    expect(queueRuntimeConfig({ QUEUE_FETCH_RATE_MAX: '100abc' }).fetchRate.max).toBe(100)
  })

  it('HTTP/primary role: QUEUE_WORKERS=0 disables workers, cron stays', () => {
    expect(queueRuntimeConfig({ QUEUE_WORKERS: '0' })).toMatchObject({ workers: false, cron: true })
  })

  it('worker role: QUEUE_CRON=0 disables the scheduler, workers stay', () => {
    expect(queueRuntimeConfig({ QUEUE_CRON: '0' })).toMatchObject({ workers: true, cron: false })
  })

  it('parses and clamps QUEUE_CONCURRENCY', () => {
    expect(queueRuntimeConfig({ QUEUE_CONCURRENCY: '5' }).concurrency).toBe(5)
    expect(queueRuntimeConfig({ QUEUE_CONCURRENCY: String(MAX_CONCURRENCY + 500) }).concurrency).toBe(MAX_CONCURRENCY)
    // Non-positive / garbage / empty → floor of 1 (never 0, which BullMQ would reject).
    for (const v of ['0', '-3', 'abc', '']) expect(queueRuntimeConfig({ QUEUE_CONCURRENCY: v }).concurrency).toBe(1)
  })
})
