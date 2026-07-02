import { describe, expect, it } from 'vitest'
import { buildEventBindCalls, isBindableHandlerUrl, type EventBinding } from '../app/utils/b24EventBind'

const EVENTS = ['ONAPPINSTALL', 'ONAPPUNINSTALL'] as const
const URL = 'https://bank-import.bx-shef.by/api/b24/events'

describe('buildEventBindCalls', () => {
  it('binds every wanted event on a fresh install (no existing bindings)', () => {
    const { unbind, bind } = buildEventBindCalls([], EVENTS, URL)
    expect(unbind).toEqual([])
    expect(bind).toEqual([
      { method: 'event.bind', params: { event: 'ONAPPINSTALL', handler: URL } },
      { method: 'event.bind', params: { event: 'ONAPPUNINSTALL', handler: URL } }
    ])
  })

  it('is idempotent — skips events already bound to the same handler', () => {
    const existing: EventBinding[] = [
      { event: 'ONAPPINSTALL', handler: URL },
      { event: 'ONAPPUNINSTALL', handler: URL }
    ]
    const { unbind, bind } = buildEventBindCalls(existing, EVENTS, URL)
    expect(unbind).toEqual([])
    expect(bind).toEqual([])
  })

  it('re-points a stale binding (unbind old handler, bind the new one)', () => {
    const existing: EventBinding[] = [
      { event: 'ONAPPINSTALL', handler: 'https://old.example/api/b24/events' }
    ]
    const { unbind, bind } = buildEventBindCalls(existing, EVENTS, URL)
    expect(unbind).toEqual([
      { method: 'event.unbind', params: { event: 'ONAPPINSTALL', handler: 'https://old.example/api/b24/events' } }
    ])
    // ONAPPINSTALL rebound + ONAPPUNINSTALL freshly bound.
    expect(bind).toEqual([
      { method: 'event.bind', params: { event: 'ONAPPINSTALL', handler: URL } },
      { method: 'event.bind', params: { event: 'ONAPPUNINSTALL', handler: URL } }
    ])
  })

  it('ignores bindings for events we do not manage', () => {
    const existing: EventBinding[] = [{ event: 'ONCRMDEALADD', handler: 'https://x/y' }]
    const { unbind, bind } = buildEventBindCalls(existing, EVENTS, URL)
    expect(unbind).toEqual([])
    expect(bind).toHaveLength(2)
  })

  it('matches event names case-insensitively', () => {
    const existing: EventBinding[] = [{ event: 'onappinstall', handler: URL }]
    const { unbind, bind } = buildEventBindCalls(existing, EVENTS, URL)
    expect(unbind).toEqual([])
    // Only ONAPPUNINSTALL is left to bind.
    expect(bind).toEqual([
      { method: 'event.bind', params: { event: 'ONAPPUNINSTALL', handler: URL } }
    ])
  })
})

describe('isBindableHandlerUrl', () => {
  it('accepts absolute http(s) URLs', () => {
    expect(isBindableHandlerUrl(URL)).toBe(true)
    expect(isBindableHandlerUrl('http://localhost:3000/api/b24/events')).toBe(true)
  })

  it('rejects empty and relative URLs (the NUXT_PUBLIC_SITE_URL-missing case)', () => {
    // appUrl empty in prod → handler is just the relative path.
    expect(isBindableHandlerUrl('')).toBe(false)
    expect(isBindableHandlerUrl('/api/b24/events')).toBe(false)
    expect(isBindableHandlerUrl('bank-import.bx-shef.by/api/b24/events')).toBe(false)
  })
})
