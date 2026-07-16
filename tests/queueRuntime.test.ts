import { describe, expect, it, vi } from 'vitest'
import { MAX_CONCURRENCY, envFlag, pickPortalResolver, queueRuntimeConfig } from '../server/queue/runtime'

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
  it('defaults to a single-container role (workers + cron, concurrency 1, SDK transport OFF)', () => {
    expect(queueRuntimeConfig({})).toEqual({ workers: true, cron: true, concurrency: 1, sdkTransport: false })
  })

  it('SDK transport is opt-in: default OFF, QUEUE_SDK_TRANSPORT=1 turns it on', () => {
    // Default OFF — flipping the prod default waits until a real crm-sync job is seen
    // processing through the SDK in the worker (the gate exercised makePortalSdkCall directly).
    expect(queueRuntimeConfig({}).sdkTransport).toBe(false)
    expect(queueRuntimeConfig({ QUEUE_SDK_TRANSPORT: '1' }).sdkTransport).toBe(true)
    expect(queueRuntimeConfig({ QUEUE_SDK_TRANSPORT: 'on' }).sdkTransport).toBe(true)
    expect(queueRuntimeConfig({ QUEUE_SDK_TRANSPORT: '0' }).sdkTransport).toBe(false)
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

describe('pickPortalResolver (flag → resolver selection, #191)', () => {
  // Guards the load-bearing swap wiring in worker.ts: with the flag ON the SDK resolver is
  // built, with it OFF the callRest resolver — and the NON-chosen branch is never constructed
  // (lazy thunks). An inverted ternary or wrong-branch build would flip these assertions.
  it('flag ON → builds the SDK resolver, never the callRest one', () => {
    const buildSdk = vi.fn(() => 'SDK')
    const buildCallRest = vi.fn(() => 'CALLREST')
    expect(pickPortalResolver(true, buildSdk, buildCallRest)).toBe('SDK')
    expect(buildSdk).toHaveBeenCalledTimes(1)
    expect(buildCallRest).not.toHaveBeenCalled() // non-chosen branch not constructed
  })

  it('flag OFF → builds the callRest resolver, never the SDK one', () => {
    const buildSdk = vi.fn(() => 'SDK')
    const buildCallRest = vi.fn(() => 'CALLREST')
    expect(pickPortalResolver(false, buildSdk, buildCallRest)).toBe('CALLREST')
    expect(buildCallRest).toHaveBeenCalledTimes(1)
    expect(buildSdk).not.toHaveBeenCalled()
  })
})
