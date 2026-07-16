import { describe, expect, it } from 'vitest'
import { MAX_CONCURRENCY, activityTransport, envFlag, queueRuntimeConfig } from '../server/queue/runtime'

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
  it('defaults to a single-container role (workers + cron, concurrency 1)', () => {
    expect(queueRuntimeConfig({})).toEqual({ workers: true, cron: true, concurrency: 1 })
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

describe('activityTransport (#259 Phase B)', () => {
  it('defaults to `todo` when unset/blank', () => {
    expect(activityTransport({})).toBe('todo')
    expect(activityTransport({ ACTIVITY_TRANSPORT: '' })).toBe('todo')
    expect(activityTransport({ ACTIVITY_TRANSPORT: '   ' })).toBe('todo')
  })
  it('turns on only for the exact token `configurable` (any case, trimmed)', () => {
    for (const v of ['configurable', 'CONFIGURABLE', ' Configurable ']) {
      expect(activityTransport({ ACTIVITY_TRANSPORT: v })).toBe('configurable')
    }
  })
  it('any other value falls back to `todo` (fail-safe: a typo cannot switch the write path)', () => {
    for (const v of ['config', 'todo', '1', 'true', 'configurables', 'conf']) {
      expect(activityTransport({ ACTIVITY_TRANSPORT: v })).toBe('todo')
    }
  })
})
