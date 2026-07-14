import { describe, expect, it } from 'vitest'
import {
  SETTINGS_KEY,
  defaultPortalSettings,
  defaultChatSettings,
  defaultRecognitionSettings,
  parsePortalSettings,
  serializePortalSettings
} from '~/utils/settings'
import { MAX_MASK_CHARS, MAX_MATRICES } from '~/utils/purposeMatch'

// Field-map caps are private to settings.ts; assert the exact documented values.
const MAX_FIELD_LEN = 128
const MAX_CONFIG_FIELDS = 200

// Pure per-portal settings schema (chat target + notify rules) stored as a JSON
// string in app.option. parsePortalSettings must never throw on untyped input.

describe('defaults', () => {
  it('default chat = no target (off), credits only, empty exclusions', () => {
    expect(defaultChatSettings()).toEqual({
      dialogId: '', rules: { directions: ['credit'], excludeAccounts: [], excludePurposePatterns: [] }
    })
    expect(defaultPortalSettings()).toEqual({
      chat: defaultChatSettings(), errorChat: { dialogId: '' }, recognition: defaultRecognitionSettings(), autoDistribute: false, invoicePaidStageId: ''
    })
  })

  it('default recognition = cyrillic alphabet, no matrices, empty field map', () => {
    expect(defaultRecognitionSettings()).toEqual({ alphabet: 'cyrillic', matrices: [], configFields: {} })
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
      errorChat: { dialogId: 'chat77' },
      recognition: {
        alphabet: 'latin' as const,
        matrices: [{ mask: 'СЧ-dddd', kind: 'invoice-number' as const, note: 'счёт' }],
        configFields: { 'deal:1': 'UF_CRM_1' }
      },
      autoDistribute: true,
      invoicePaidStageId: 'DT31_11:P'
    }
    expect(parsePortalSettings(serializePortalSettings(s))).toEqual(s)
  })

  it('missing fields fill from defaults', () => {
    expect(parsePortalSettings('{}')).toEqual(defaultPortalSettings())
    expect(parsePortalSettings('{"chat":{"dialogId":"chat7"}}')).toEqual({
      chat: { dialogId: 'chat7', rules: { directions: ['credit'], excludeAccounts: [], excludePurposePatterns: [] } },
      errorChat: { dialogId: '' },
      recognition: defaultRecognitionSettings(),
      autoDistribute: false,
      invoicePaidStageId: ''
    })
  })

  it('invoicePaidStageId: trimmed, length-clamped, empty for non-string', () => {
    expect(parsePortalSettings('{"invoicePaidStageId":"  DT31_11:P "}').invoicePaidStageId).toBe('DT31_11:P')
    expect(parsePortalSettings('{"invoicePaidStageId":123}').invoicePaidStageId).toBe('') // non-string → empty
    expect(parsePortalSettings('{}').invoicePaidStageId).toBe('') // missing → empty (no stage change)
    expect(parsePortalSettings('{"invoicePaidStageId":"' + 'x'.repeat(200) + '"}').invoicePaidStageId.length).toBe(64)
  })

  it('autoDistribute: only literal true enables it (fail-safe default off)', () => {
    expect(parsePortalSettings('{"autoDistribute":true}').autoDistribute).toBe(true)
    expect(parsePortalSettings('{"autoDistribute":false}').autoDistribute).toBe(false)
    expect(parsePortalSettings('{"autoDistribute":"true"}').autoDistribute).toBe(false) // string, not bool
    expect(parsePortalSettings('{"autoDistribute":1}').autoDistribute).toBe(false)
    expect(parsePortalSettings('{}').autoDistribute).toBe(false) // missing → off
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

  it('directions: bounded scan drops a valid value buried past the cap (#182)', () => {
    // A legit `directions` holds 0-2 entries; the coercion slices the untrusted array before
    // probing (O(1) Set) instead of scanning it whole per direction. A 'credit' hidden past
    // MAX_LIST_ITEMS junk entries is dropped — accepted trade-off; pinning [] catches a
    // regression that removes the slice (which would scan the full array and find it).
    const buried = [...Array.from({ length: 500 }, () => 'x'), 'credit']
    expect(parsePortalSettings(JSON.stringify({ chat: { rules: { directions: buried } } })).chat.rules.directions).toEqual([])
    // within the cap it's still honored
    expect(parsePortalSettings(JSON.stringify({ chat: { rules: { directions: ['credit'] } } })).chat.rules.directions).toEqual(['credit'])
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

  it('bounds iteration by slicing input, not by accepted count (#182)', () => {
    // 500 identical entries never grow `seen`; the old `seen.size >= cap` break would have
    // scanned the whole array. The input is now sliced to MAX_LIST_ITEMS (500) BEFORE the
    // loop, so the unique sitting PAST the cap is never reached and is dropped — the
    // accepted trade-off (a real exclusion list never nears 500). Pinning ['dup'] catches a
    // regression that removes the slice (which would instead return ['dup','unique-past-cap']).
    const input = [...Array.from({ length: 500 }, () => 'dup'), 'unique-past-cap']
    const r = parsePortalSettings(JSON.stringify({ chat: { rules: { excludeAccounts: input } } })).chat.rules
    expect(r.excludeAccounts).toEqual(['dup'])
    // A huge all-blank array is bounded too (blanks are dropped → empty result, no full scan).
    const blanks = Array.from({ length: 5000 }, () => '   ')
    expect(parsePortalSettings(JSON.stringify({ chat: { rules: { excludeAccounts: blanks } } })).chat.rules.excludeAccounts)
      .toEqual([])
  })
})

describe('parsePortalSettings — recognition (§4)', () => {
  const rec = (recognition: unknown) => parsePortalSettings(JSON.stringify({ recognition })).recognition

  it('missing / non-object recognition → default', () => {
    expect(parsePortalSettings('{}').recognition).toEqual(defaultRecognitionSettings())
    expect(rec(42)).toEqual(defaultRecognitionSettings())
    expect(rec(null)).toEqual(defaultRecognitionSettings())
  })

  it('alphabet: valid kept, unknown → cyrillic', () => {
    expect(rec({ alphabet: 'latin' }).alphabet).toBe('latin')
    expect(rec({ alphabet: 'greek' }).alphabet).toBe('cyrillic')
    expect(rec({ alphabet: 42 }).alphabet).toBe('cyrillic')
  })

  it('matrices: keeps well-formed (mask + known kind), optional note', () => {
    const r = rec({ matrices: [
      { mask: 'dddd', kind: 'invoice-number' },
      { mask: 'СЧ-dddd', kind: 'invoice-number', note: '  счёт  ' }
    ] })
    expect(r.matrices).toEqual([
      { mask: 'dddd', kind: 'invoice-number' },
      { mask: 'СЧ-dddd', kind: 'invoice-number', note: 'счёт' }
    ])
  })

  it('matrices: note dropped when non-string or blank (shape stays minimal)', () => {
    const r = rec({ matrices: [
      { mask: 'dddd', kind: 'deal-id', note: 42 },
      { mask: 'ddd', kind: 'deal-id', note: '   ' }
    ] })
    expect(r.matrices).toEqual([
      { mask: 'dddd', kind: 'deal-id' },
      { mask: 'ddd', kind: 'deal-id' }
    ])
    expect(r.matrices.every(m => !('note' in m))).toBe(true)
  })

  it('matrices: drops entries with a blank mask or an unknown kind', () => {
    const r = rec({ matrices: [
      { mask: '', kind: 'invoice-number' },
      { mask: '   ', kind: 'invoice-number' },
      { mask: 'dddd', kind: 'not-a-kind' },
      { mask: 'dddd' },
      'garbage',
      { mask: 'dddd', kind: 'deal-id' }
    ] })
    expect(r.matrices).toEqual([{ mask: 'dddd', kind: 'deal-id' }])
  })

  it('matrices: not-an-array → []', () => {
    expect(rec({ matrices: 'nope' }).matrices).toEqual([])
  })

  it('matrices: NOT deduped — same mask+kind kept twice (order = priority, intentional #182)', () => {
    // Unlike cleanList, cleanRecognition intentionally does not dedupe matrices: a recognizer
    // may want ordered/overlapping masks. This documents that as intended, not an oversight.
    const r = rec({ matrices: [
      { mask: 'dddd', kind: 'invoice-number' },
      { mask: 'dddd', kind: 'invoice-number' }
    ] })
    expect(r.matrices).toEqual([
      { mask: 'dddd', kind: 'invoice-number' },
      { mask: 'dddd', kind: 'invoice-number' }
    ])
  })

  it('matrices: mask clamped and count capped to the exact limits', () => {
    const longMask = 'd'.repeat(MAX_MASK_CHARS + 400)
    expect(rec({ matrices: [{ mask: longMask, kind: 'invoice-number' }] }).matrices[0]!.mask.length)
      .toBe(MAX_MASK_CHARS)
    const many = Array.from({ length: MAX_MATRICES + 100 }, () => ({ mask: 'dddd', kind: 'invoice-number' }))
    expect(rec({ matrices: many }).matrices.length).toBe(MAX_MATRICES)
  })

  it('configFields: coerced to string→string, blanks dropped, keys/values trimmed', () => {
    const r = rec({ configFields: { '  deal:1  ': '  UF_CRM_1  ', 'deal:2': '', 'blank': 42, '': 'x' } })
    expect(r.configFields).toEqual({ 'deal:1': 'UF_CRM_1' })
  })

  it('configFields: non-object → {}', () => {
    expect(rec({ configFields: ['a', 'b'] }).configFields).toEqual({})
    expect(rec({ configFields: 'x' }).configFields).toEqual({})
  })

  it('configFields: key/value clamped and count capped to the exact limits', () => {
    const longKey = 'k'.repeat(MAX_FIELD_LEN + 200)
    const longVal = 'v'.repeat(MAX_FIELD_LEN + 200)
    const r = rec({ configFields: { [longKey]: longVal } })
    const [k, v] = Object.entries(r.configFields)[0]!
    expect(k.length).toBe(MAX_FIELD_LEN)
    expect(v.length).toBe(MAX_FIELD_LEN)
    const many: Record<string, string> = {}
    for (let i = 0; i < MAX_CONFIG_FIELDS + 100; i++) many[`k${i}`] = `v${i}`
    expect(Object.keys(rec({ configFields: many }).configFields).length).toBe(MAX_CONFIG_FIELDS)
  })

  it('configFields: prototype-polluting keys are dropped, plain object stays clean', () => {
    const r = rec({ configFields: JSON.parse('{"__proto__":"UF_X","constructor":"UF_Y","prototype":"UF_Z","deal:1":"UF_OK"}') })
    expect(r.configFields).toEqual({ 'deal:1': 'UF_OK' })
    // the global prototype is untouched
    expect(({} as Record<string, unknown>).UF_X).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('UF_X')
  })
})
