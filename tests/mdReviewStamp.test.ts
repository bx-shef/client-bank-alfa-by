import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Review-stamp convention (see CLAUDE.md › Конвенции): every tracked .md carries
// `> Last reviewed: YYYY-MM-DD` (ISO date) as a blockquote right under its H1.
const STAMP_RE = /^> Last reviewed: \d{4}-\d{2}-\d{2}$/m

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// `reporting-kit/` is a self-contained vendored bundle with its own conventions
// and its own CI (see docs/REPORTING_KIT.md). It does not follow our review-stamp
// convention, so it is excluded here — kept verbatim to stay syncable with source.
const EXCLUDED_PREFIXES = ['reporting-kit/'] as const

/** .md files tracked by git — naturally excludes node_modules/ and .nuxt/. */
function trackedMdFiles(): string[] {
  return execSync('git ls-files "*.md"', { cwd: repoRoot })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter(f => !EXCLUDED_PREFIXES.some(prefix => f.startsWith(prefix)))
}

describe('Markdown review stamp convention', () => {
  it('every tracked .md file carries a "> Last reviewed: YYYY-MM-DD" stamp', () => {
    const files = trackedMdFiles()
    expect(files.length).toBeGreaterThan(0) // sanity: git returned something

    const missing = files.filter(
      f => !STAMP_RE.test(readFileSync(join(repoRoot, f), 'utf-8'))
    )
    expect(missing, `Missing review stamp in:\n${missing.join('\n')}`).toEqual([])
  })
})
