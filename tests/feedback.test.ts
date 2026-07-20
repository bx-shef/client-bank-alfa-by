import { describe, expect, it } from 'vitest'
import { attachedFileContent, buildFeedbackIssue, escapeHtml, MAX_COMMENT_LENGTH, MAX_FILE_EMBED, normalizeKind, sanitizeComment, stripHostileChars } from '~/utils/feedback'

// Build hostile chars from code points (never type the invisible characters literally — that would
// itself be a Trojan-Source vector, and the point of the strip is to remove exactly these).
const ZWSP = String.fromCharCode(0x200b)
const BIDI = String.fromCharCode(0x202e) // RTL override
const BOM = String.fromCharCode(0xfeff)
const NUL = String.fromCharCode(0x00)
const WJ = String.fromCharCode(0x2060) // WORD JOINER (invisible)

describe('feedback — sanitization', () => {
  it('stripHostileChars removes zero-width / bidi / BOM / controls but keeps tab+newline', () => {
    expect(stripHostileChars(`a${ZWSP}b${BIDI}c${BOM}d${NUL}e${WJ}f`)).toBe('abcdef')
    expect(stripHostileChars('a\tb\nc')).toBe('a\tb\nc')
  })
  it('sanitizeComment caps content at the max + adds a truncation marker', () => {
    const long = 'x'.repeat(MAX_COMMENT_LENGTH * 2)
    const out = sanitizeComment(long)
    expect(out.length).toBeLessThan(long.length)
    expect(out.startsWith('x'.repeat(MAX_COMMENT_LENGTH))).toBe(true) // exactly the cap of content
    expect(out).toContain('[truncated to')
    // a comment at/under the cap is returned unchanged (no marker)
    expect(sanitizeComment('x'.repeat(MAX_COMMENT_LENGTH))).not.toContain('[truncated')
  })
  it('escapeHtml makes markup inert', () => {
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;')
  })
})

describe('feedback — normalizeKind', () => {
  it('accepts only up/down', () => {
    expect(normalizeKind('up')).toBe('up')
    expect(normalizeKind('down')).toBe('down')
    expect(normalizeKind('idea')).toBeNull()
    expect(normalizeKind(undefined)).toBeNull()
  })
})

describe('feedback — buildFeedbackIssue', () => {
  it('builds title/body/labels; comment rendered inert inside <pre><code>', () => {
    const p = buildFeedbackIssue('down', 'выписка <script> не разобралась')
    expect(p.labels).toEqual(['user-feedback', 'feedback:down'])
    expect(p.title).toContain('отрицательный')
    expect(p.body).toContain('<pre><code>')
    // HTML in the comment is escaped, not live.
    expect(p.body).toContain('&lt;script&gt;')
    expect(p.body).not.toContain('<script>')
  })
  it('empty comment → «(без текста)» and a generic title', () => {
    const p = buildFeedbackIssue('up', '   ')
    expect(p.body).toContain('(без текста)')
    expect(p.title).toContain('Отзыв сотрудника')
  })
  it('strips hostile chars from the comment before building', () => {
    const p = buildFeedbackIssue('up', `хоро${ZWSP}шо`)
    expect(p.body).toContain('хорошо')
  })
  it('renders a Контекст section from provided fields (file/version), inert', () => {
    const p = buildFeedbackIssue('down', 'плохо', {
      fileName: `вы${ZWSP}писка.txt`,
      appVersion: 'abc1234'
    })
    expect(p.body).toContain('**Контекст:**')
    expect(p.body).toContain('выписка.txt') // hostile char stripped
    expect(p.body).toContain('abc1234')
  })
  it('renders context values inert inside an inline code span (no live markdown/HTML)', () => {
    const p = buildFeedbackIssue('up', 'ok', { fileName: '<img src=x>' })
    // Inside a code span `<img src=x>` is literal text, not a live tag, and not a markdown link.
    expect(p.body).toContain('- **Файл:** `<img src=x>`')
  })
  it('neutralizes newline + markdown-link injection in a context value (no forged sections)', () => {
    // A hostile fileName tries to break out of its line and forge a new heading + a live link.
    const p = buildFeedbackIssue('up', 'ok', {
      fileName: 'a.txt\n## FORGED\n[x](https://evil.example)'
    })
    // The forged heading/link must NOT appear as a STANDALONE markdown line — interior newlines are
    // collapsed to spaces, so the value stays on ONE `- **Файл:** ...` line wrapped in a code span
    // (where `##`/`[](...)` render literally, not as a heading/link).
    const lines = p.body.split('\n')
    expect(lines).not.toContain('## FORGED')
    expect(lines).not.toContain('[x](https://evil.example)')
    const fileLine = lines.find(l => l.startsWith('- **Файл:**'))!
    expect(fileLine).toBe('- **Файл:** `a.txt ## FORGED [x](https://evil.example)`')
  })
  it('omits the Контекст section entirely when no context is provided', () => {
    const p = buildFeedbackIssue('up', 'ok')
    expect(p.body).not.toContain('**Контекст:**')
  })
})

describe('feedback — file attach (#198)', () => {
  it('embeds the statement text in a collapsed <details> block when fileContent is present', () => {
    const p = buildFeedbackIssue('down', 'не разобралось', { fileContent: '1CClientBankExchange\nСекция' })
    expect(p.body).toContain('**Файл выписки** (приложен по согласию сотрудника):')
    expect(p.body).toContain('<details><summary>Показать содержимое</summary>')
    expect(p.body).toContain('1CClientBankExchange\nСекция')
    expect(p.body).toContain('</details>')
  })

  it('omits the file block entirely for empty / whitespace-only / absent fileContent', () => {
    expect(buildFeedbackIssue('up', 'ok').body).not.toContain('Файл выписки')
    expect(buildFeedbackIssue('up', 'ok', { fileContent: '   \n  ' }).body).not.toContain('Файл выписки')
  })

  it('escapes so a </code></pre> inside the file cannot break out of the block', () => {
    const p = buildFeedbackIssue('down', 'x', { fileContent: 'до</code></pre>после' })
    expect(p.body).toContain('до&lt;/code&gt;&lt;/pre&gt;после')
    expect(p.body).not.toContain('до</code></pre>после')
  })

  it('caps a huge file to MAX_FILE_EMBED with a truncation marker', () => {
    const big = 'A'.repeat(MAX_FILE_EMBED + 5000)
    const p = buildFeedbackIssue('down', 'x', { fileContent: big })
    expect(p.body).toContain(`[обрезано до ${MAX_FILE_EMBED} символов]`)
    // The embedded run of A's is capped (escapeHtml doesn't touch 'A', so length is comparable).
    expect(p.body.match(/A+/)![0].length).toBe(MAX_FILE_EMBED)
  })

  it('hard-caps the ESCAPED block so an all-& file cannot blow past GitHub body limit', () => {
    // Under the raw cap (20000 < MAX_FILE_EMBED) but escapes ~5× → must be escaped-capped.
    const p = buildFeedbackIssue('down', 'x', { fileContent: '&'.repeat(20000) })
    expect(p.body).toContain('[обрезано]')
    expect(p.body.length).toBeLessThan(65536) // fits GitHub's issue-body limit
    // No trailing partial entity left dangling (would render as a stray '&am').
    expect(p.body).not.toMatch(/&[a-z]{0,3}\n\n\[обрезано\]/)
  })

  it('strips bidi/zero-width control chars from the embedded file (Trojan-Source-safe)', () => {
    const p = buildFeedbackIssue('down', 'x', { fileContent: `стро${ZWSP}ка${BIDI}RTL` })
    expect(p.body).toContain('строка')
    expect(p.body).not.toContain(ZWSP)
    expect(p.body).not.toContain(BIDI)
  })
})

describe('feedback — attachedFileContent (server consent gate)', () => {
  it('returns the text only with explicit consent (attachFile === true) + a string', () => {
    expect(attachedFileContent(true, 'выписка')).toBe('выписка')
  })
  it('drops the file when consent is absent/false/non-literal-true', () => {
    expect(attachedFileContent(false, 'выписка')).toBeUndefined()
    expect(attachedFileContent(undefined, 'выписка')).toBeUndefined()
    expect(attachedFileContent('true', 'выписка')).toBeUndefined() // only the literal boolean
    expect(attachedFileContent(1, 'выписка')).toBeUndefined()
  })
  it('drops non-string content even with consent', () => {
    expect(attachedFileContent(true, { a: 1 })).toBeUndefined()
    expect(attachedFileContent(true, undefined)).toBeUndefined()
  })
  it('caps the accepted text server-side', () => {
    expect(attachedFileContent(true, 'x'.repeat(MAX_FILE_EMBED + 100))!.length).toBe(MAX_FILE_EMBED)
  })
})
