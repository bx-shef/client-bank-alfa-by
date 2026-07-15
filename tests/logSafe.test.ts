import { describe, expect, it } from 'vitest'
import { logSafe } from '../server/utils/logSafe'

describe('logSafe (#242 — log-injection guard)', () => {
  it('strips CR/LF so a crafted value cannot forge a new log line', () => {
    const forged = 'ok\r\n[recognize] portal EVIL fake line'
    const out = logSafe(forged)
    expect(out).not.toContain('\r')
    expect(out).not.toContain('\n')
    // the injected content stays on one line (spaces where the breaks were)
    expect(out).toBe('ok  [recognize] portal EVIL fake line')
  })

  it('strips control (\\p{Cc}) and format (\\p{Cf}) chars', () => {
    expect(logSafe('a\x00b\x07c')).toBe('a b c') // NUL, BEL
    expect(logSafe('x\x1b[31mred\x1b[0m')).toBe('x [31mred [0m') // ANSI ESC
    expect(logSafe('a​b')).toBe('a b') // zero-width space (Cf)
  })

  it('truncates to the length cap (default 128) as a DoS guard', () => {
    expect(logSafe('a'.repeat(500))).toHaveLength(128)
    expect(logSafe('a'.repeat(500), 10)).toHaveLength(10)
  })

  it('leaves ordinary text (incl. Cyrillic/digits/mask literals) untouched', () => {
    expect(logSafe('СЧ-0001|BOPC-12/3')).toBe('СЧ-0001|BOPC-12/3')
  })

  it('coerces non-strings and nullish input without throwing', () => {
    expect(logSafe(undefined as unknown as string)).toBe('')
    expect(logSafe(null as unknown as string)).toBe('')
    expect(logSafe(123 as unknown as string)).toBe('123')
  })
})
