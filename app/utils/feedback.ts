// Pure builder for the «сотрудник» feedback channel (docs/FEEDBACK.md): an employee rates the
// import result 👍/👎 with an optional comment → a GitHub issue in the configured PRIVATE receiving
// repo. Security-critical sanitization ported verbatim from the ai-price-import channel.
//
// PRIVACY: the comment is employee-written free text and MAY contain client context (account, sums,
// counterparties from a statement). The receiving repo (GITHUB_FEEDBACK_REPO) MUST therefore be a
// PRIVATE repo — never the public code repo. The builder keeps the comment (that's the point) but
// renders it INERT (hostile-char-stripped + HTML-escaped inside <pre><code>) so it can't
// Trojan-Source the issue list or inject markdown.

/** 👍 / 👎 — the two employee ratings. RU words for the issue. */
export const FEEDBACK_KINDS = { up: 'положительный 👍', down: 'отрицательный 👎' } as const
export type FeedbackKind = keyof typeof FEEDBACK_KINDS

export const MAX_COMMENT_LENGTH = 5000

// Hostile / confusing chars, spelled out with \u / \x escapes so a reviewer can verify what is
// stripped WITHOUT trusting invisible code points in the source (a literal here would itself be a
// Trojan-Source vector against the reviewer): C0 controls except tab/LF/CR; bidi overrides
// (U+202A..U+202E, U+2066..U+2069), ALM (U+061C); zero-width/BOM (U+200B..U+200D, U+FEFF); word
// joiner + invisible operators (U+2060..U+2064); line/paragraph separators (U+2028/U+2029).
// eslint-disable-next-line no-control-regex
const HOSTILE_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\u061c\u200b-\u200d\u2028-\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/** Remove C0 controls, bidi overrides, zero-widths and BOM from arbitrary user text. */
export function stripHostileChars(input: unknown): string {
  return String(input ?? '').replace(HOSTILE_CHARS, '')
}

/** Strip hostile chars + truncate the comment to a sane maximum. */
export function sanitizeComment(input: unknown): string {
  const stripped = stripHostileChars(input)
  if (stripped.length <= MAX_COMMENT_LENGTH) return stripped
  return `${stripped.slice(0, MAX_COMMENT_LENGTH)}…\n\n[truncated to ${MAX_COMMENT_LENGTH} characters]`
}

/** Make text inert for a GitHub issue body: &, <, > escaped (defence-in-depth in a code block). */
export function escapeHtml(input: unknown): string {
  return String(input ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Canonical kind if recognised, else null (the route rejects null with a 400). */
export function normalizeKind(kind: unknown): FeedbackKind | null {
  return kind === 'up' || kind === 'down' ? kind : null
}

export interface IssuePayload { title: string, body: string, labels: string[] }

/**
 * Optional import context attached to the feedback issue so triage can trace it back to a run.
 * PRIVACY: these fields may carry client data (file name) — they are ONLY rendered because the
 * receiving repo is PRIVATE (see the module header). Every value is stripped + escaped + capped
 * before rendering; unknown/empty fields are omitted. Enriched later (docs/FEEDBACK.md §«дальше»):
 * created-entity link, parse outcome, source-file link with consent.
 */
export interface FeedbackContext {
  fileName?: unknown
  appVersion?: unknown
  /** Raw statement text, embedded in the issue ONLY with the employee's explicit consent (#198).
   *  PRIVACY: this is the client's financial statement (accounts/amounts/УНП) — it is rendered
   *  ONLY because the receiving repo is PRIVATE (see the module header). Absent/empty ⇒ no block. */
  fileContent?: unknown
}

const MAX_CONTEXT_VALUE = 300

/** Cap for the embedded statement text. GitHub's issue body is limited (~65536 chars); keep the
 *  file excerpt well under it so the rest of the body (comment + context) always fits. */
export const MAX_FILE_EMBED = 30000

/**
 * One `- **Label:** `value`` line, rendered fully INERT. Client-supplied context values (fileName is
 * attacker-influenced — an uploaded document name) must not forge markdown into the issue body:
 *   - collapse interior CR/LF/tab (which `stripHostileChars` intentionally keeps) → a single space,
 *     so a value can't break out of its line and inject extra sections (the body is `join('\n')`d);
 *   - strip backticks, then wrap the value in an inline code span — inside a code span markdown
 *     metacharacters ([](), ![](), *, _, |, #) render literally, so no live links/images/formatting.
 * Empty value → null (omit the line entirely). Cap applied before wrapping.
 */
function contextLine(label: string, value: unknown): string | null {
  const flat = stripHostileChars(value).replace(/[\r\n\t]+/g, ' ').replace(/`/g, '').trim().slice(0, MAX_CONTEXT_VALUE)
  return flat ? `- **${label}:** \`${flat}\`` : null
}

/**
 * Body lines for the attached statement file (#198), or `[]` when there's nothing to embed. UNLIKE
 * `contextLine`, newlines are KEPT (it's a file — its line structure is the point), but the content
 * is made fully INERT: strip hostile control chars (bidi/zero-width/BOM — but keep \n\r\t) so it
 * can't Trojan-Source the issue, then `escapeHtml` so a literal `</code></pre>` inside the statement
 * can't close the block and inject markdown/HTML, then cap to `MAX_FILE_EMBED` with a truncation
 * marker. Wrapped in a collapsed `<details>` so a long file doesn't dominate the issue. Only ever
 * called with a value the employee consented to attach (the receiving repo is private).
 */
function fileEmbedLines(value: unknown): string[] {
  const stripped = stripHostileChars(value)
  const trimmed = stripped.trim()
  if (!trimmed) return []
  const capped = stripped.length <= MAX_FILE_EMBED
    ? stripped
    : `${stripped.slice(0, MAX_FILE_EMBED)}\n\n[обрезано до ${MAX_FILE_EMBED} символов]`
  return [
    '',
    '**Файл выписки** (приложен по согласию сотрудника):',
    '<details><summary>Показать содержимое</summary>',
    '',
    '<pre><code>',
    escapeHtml(capped),
    '</code></pre>',
    '</details>'
  ]
}

/**
 * Build the { title, body, labels } for the GitHub issue from a validated kind + raw comment +
 * optional import context. The comment is sanitized here (do not assume a pre-sanitized value — this
 * is exported). Body wraps the comment in <pre><code> so backticks/asterisks/HTML are inert. Context
 * lines are rendered ONLY because the receiving repo is private; each is made fully inert (newlines
 * collapsed + wrapped in an inline code span — see contextLine) so a client-supplied value can't
 * inject markdown. Absent/empty context → the section is omitted.
 */
export function buildFeedbackIssue(kind: FeedbackKind, comment: unknown, context: FeedbackContext = {}): IssuePayload {
  const safe = escapeHtml(sanitizeComment(comment)).trim() || '(без текста)'
  const firstLine = safe.split('\n', 1)[0]!.slice(0, 80).trim()
  const kindWord = FEEDBACK_KINDS[kind]
  const title = (firstLine && firstLine !== '(без текста)'
    ? `${kindWord} · ${firstLine}`
    : `Отзыв сотрудника — ${kindWord}`).slice(0, 120)
  const contextLines = [
    contextLine('Файл', context.fileName),
    contextLine('Версия приложения', context.appVersion)
  ].filter((l): l is string => l !== null)
  const body = [
    `- **Оценка:** ${kindWord}`,
    '',
    '**Комментарий:**',
    '<pre><code>',
    safe,
    '</code></pre>',
    ...(contextLines.length ? ['', '**Контекст:**', ...contextLines] : []),
    ...fileEmbedLines(context.fileContent)
  ].join('\n')
  return { title, body, labels: ['user-feedback', `feedback:${kind}`] }
}
