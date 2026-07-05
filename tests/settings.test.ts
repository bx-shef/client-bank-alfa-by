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
    expect(defaultPortalSettings()).toEqual({ chat: defaultChatSettings() })
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
      }
    }
    expect(parsePortalSettings(serializePortalSettings(s))).toEqual(s)
  })

  it('missing fields fill from defaults', () => {
    expect(parsePortalSettings('{}')).toEqual(defaultPortalSettings())
    expect(parsePortalSettings('{"chat":{"dialogId":"chat7"}}')).toEqual({
      chat: { dialogId: 'chat7', rules: { directions: ['credit'], excludeAccounts: [], excludePurposePatterns: [] } }
    })
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
})
