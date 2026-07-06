import { describe, expect, it } from 'vitest'
import {
  SETTINGS_KEY,
  defaultPortalSettings,
  defaultChatSettings,
  parsePortalSettings,
  serializePortalSettings
} from '~/utils/settings'

// Pure per-portal settings schema (chat target + notify rules) stored as a JSON
// string in app.option. parsePortalSettings must never throw on untyped input.

describe('defaults', () => {
  it('default chat = no target (off), credits only, empty exclusions', () => {
    expect(defaultChatSettings()).toEqual({
      dialogId: '', rules: { directions: ['credit'], excludeAccounts: [], excludePurposePatterns: [] }
    })
    expect(defaultPortalSettings()).toEqual({ chat: defaultChatSettings(), errorChat: { dialogId: '' } })
  })

  it('storage key is versioned', () => {
    expect(SETTINGS_KEY).toBe('cb_settings_v1')
  })
})

describe('parsePortalSettings — defensive', () => {
  it('null / empty / whitespace → defaults (no throw)', () => {
    expect(parsePortalSettings(null)).toEqual(defaultPortalSettings())
    expect(parsePortalSettings('')).toEqual(defaultPortalSettings())
    expect(parsePortalSettings('   ')).toEqual(defaultPortalSettings())
    expect(parsePortalSettings(undefined)).toEqual(defaultPortalSettings())
  })

  it('corrupt JSON → defaults (no throw)', () => {
    expect(parsePortalSettings('{not json')).toEqual(defaultPortalSettings())
    expect(parsePortalSettings('42')).toEqual(defaultPortalSettings()) // non-object
  })

  it('round-trips a full valid value', () => {
    const s = {
      chat: {
        dialogId: 'chat2941',
        rules: { directions: ['credit', 'debit'] as const, excludeAccounts: ['BY00'], excludePurposePatterns: ['возврат'] }
      },
      errorChat: { dialogId: 'chat77' }
    }
    expect(parsePortalSettings(serializePortalSettings(s))).toEqual(s)
  })

  it('missing fields fill from defaults', () => {
    expect(parsePortalSettings('{}')).toEqual(defaultPortalSettings())
    expect(parsePortalSettings('{"chat":{"dialogId":"chat7"}}')).toEqual({
      chat: { dialogId: 'chat7', rules: { directions: ['credit'], excludeAccounts: [], excludePurposePatterns: [] } },
      errorChat: { dialogId: '' }
    })
  })

  it('errorChat: parsed defensively (trimmed; missing/non-string → empty)', () => {
    expect(parsePortalSettings('{"errorChat":{"dialogId":"  chat5 "}}').errorChat.dialogId).toBe('chat5')
    expect(parsePortalSettings('{"errorChat":{"dialogId":42}}').errorChat.dialogId).toBe('')
    expect(parsePortalSettings('{"chat":{"dialogId":"chat1"}}').errorChat).toEqual({ dialogId: '' })
  })

  it('title: cached name kept when present, absent otherwise (UI convenience, optional)', () => {
    const p = parsePortalSettings('{"chat":{"dialogId":"chat5","title":"  Отдел продаж "},"errorChat":{"dialogId":"chat9","title":"Ошибки"}}')
    expect(p.chat.title).toBe('Отдел продаж') // trimmed
    expect(p.errorChat.title).toBe('Ошибки')
    // no title key when unset or non-string (keeps the shape minimal)
    expect('title' in parsePortalSettings('{"chat":{"dialogId":"chat5"}}').chat).toBe(false)
    expect('title' in parsePortalSettings('{"chat":{"dialogId":"chat5","title":42}}').chat).toBe(false)
    expect('title' in parsePortalSettings('{"chat":{"dialogId":"chat5","title":"   "}}').chat).toBe(false) // blank → dropped
  })

  it('title: clamped to 256 chars', () => {
    const long = 'z'.repeat(400)
    expect(parsePortalSettings(JSON.stringify({ chat: { dialogId: 'chat5', title: long } })).chat.title!.length).toBe(256)
  })

  it('title: dropped when there is no dialogId (a title without a chat is meaningless)', () => {
    const p = parsePortalSettings('{"chat":{"dialogId":"","title":"Orphan"},"errorChat":{"dialogId":"","title":"X"}}')
    expect('title' in p.chat).toBe(false)
    expect('title' in p.errorChat).toBe(false)
  })

  it('directions: invalid entries dropped, order normalized; missing → [credit]', () => {
    expect(parsePortalSettings('{"chat":{"rules":{"directions":["debit","credit","xxx"]}}}').chat.rules.directions)
      .toEqual(['credit', 'debit']) // valid-only, canonical order
    expect(parsePortalSettings('{"chat":{"rules":{"directions":"credit"}}}').chat.rules.directions)
      .toEqual(['credit']) // not-an-array → default
  })

  it('directions: explicit [] is preserved as "announce nothing"', () => {
    expect(parsePortalSettings('{"chat":{"rules":{"directions":[]}}}').chat.rules.directions).toEqual([])
    expect(parsePortalSettings('{"chat":{"rules":{"directions":["nope"]}}}').chat.rules.directions).toEqual([])
  })

  it('exclusion lists: coerced, trimmed, de-blanked, deduped', () => {
    const r = parsePortalSettings('{"chat":{"rules":{"excludeAccounts":[" BY1 ","BY1","",2],"excludePurposePatterns":["x","x"]}}}').chat.rules
    expect(r.excludeAccounts).toEqual(['BY1', '2'])
    expect(r.excludePurposePatterns).toEqual(['x'])
  })

  it('dialogId trimmed; non-string → empty', () => {
    expect(parsePortalSettings('{"chat":{"dialogId":"  chat9 "}}').chat.dialogId).toBe('chat9')
    expect(parsePortalSettings('{"chat":{"dialogId":123}}').chat.dialogId).toBe('')
  })

  it('clamps oversized input (defense-in-depth)', () => {
    const longId = 'chat' + 'x'.repeat(500)
    expect(parsePortalSettings(JSON.stringify({ chat: { dialogId: longId } })).chat.dialogId.length).toBe(64)
    // 1000 unique exclusion entries → capped at 500
    const many = Array.from({ length: 1000 }, (_, i) => `acc${i}`)
    const r = parsePortalSettings(JSON.stringify({ chat: { rules: { excludeAccounts: many } } })).chat.rules
    expect(r.excludeAccounts!.length).toBe(500)
    // each entry length-capped at 256
    const longEntry = 'y'.repeat(400)
    const r2 = parsePortalSettings(JSON.stringify({ chat: { rules: { excludePurposePatterns: [longEntry] } } })).chat.rules
    expect(r2.excludePurposePatterns![0]!.length).toBe(256)
  })
})
