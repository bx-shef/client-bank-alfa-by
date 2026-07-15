import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// CI-gate for the feedback-triage kit's offline validator (docs/FEEDBACK_TRIAGE_AGENT.md §8.3).
// scripts/validate-docs.sh checks the docs+script stay consistent (limits block, privacy-guard,
// channels described, placeholder repo consistent across doc↔script, no broken .md links, .sh/.ps1
// step parity). Running it here wires it into `pnpm test`/CI so regressions (a dropped privacy-guard,
// a drifted placeholder, a broken cross-link) fail automatically instead of only on a manual run —
// same idea as tests/mdReviewStamp.test.ts.
const REPO_ROOT = process.cwd()

/** Is a POSIX `bash` reachable? (Windows dev without Git Bash/WSL → skip, like the .ps1 SKIPs.) */
function hasBash(): boolean {
  return spawnSync('bash', ['-c', 'exit 0']).status === 0
}

describe('feedback-triage offline validator', () => {
  it.skipIf(!hasBash())('scripts/validate-docs.sh exits 0', () => {
    const res = spawnSync('bash', [join('scripts', 'validate-docs.sh')], {
      cwd: REPO_ROOT,
      encoding: 'utf-8'
    })
    // Surface the validator's own output on failure so the CI log pinpoints the failing step.
    expect(res.status, res.stdout + res.stderr).toBe(0)
  })
})
