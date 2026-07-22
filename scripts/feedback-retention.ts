// Retention sweep for the PRIVATE feedback repo (#284, docs/FEEDBACK.md). The receiving repo
// accumulates real client statements (financial PII) embedded in issue bodies (employee consent #198,
// or the program `format` channel's failed file). This sweep REDACTS the statement block out of CLOSED
// issues whose `closed_at` is older than the retention window, leaving the non-PII triage metadata.
//
// Decision logic is the PURE, unit-tested core (app/utils/feedbackRetention.ts); this file is the I/O
// shell: list issues via the GitHub REST API, PATCH the redacted bodies. DRY-RUN by default — pass
// `--apply` to actually write. Inert (exit 0) when the channel isn't configured, so the scheduled
// workflow is safe without secrets.
//
// Config (env or .env.feedback, git-ignored):
//   GITHUB_FEEDBACK_TOKEN  — PAT with Issues:RW on the private repo (same token the backend uses).
//   GITHUB_FEEDBACK_REPO   — owner/repo of the private receiving repo.
//   FEEDBACK_RETENTION_DAYS — optional; default 30, clamped [1,365].
//
// Run:  pnpm feedback:retention           (dry-run: prints what would be redacted)
//       pnpm feedback:retention --apply    (writes the redactions)

import { loadDotEnv } from './lib/env.mjs'
import { httpRequest } from './lib/http.mjs'
import { C, head, ok, warn, die } from './lib/cli.mjs'
import {
  planRetention,
  resolveRetentionDays,
  type RetentionIssue
} from '../app/utils/feedbackRetention.ts'

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const API = 'https://api.github.com'
const apply = process.argv.includes('--apply')

loadDotEnv(['.env.feedback', '.env'])

const token = (process.env.GITHUB_FEEDBACK_TOKEN ?? '').trim()
const repo = (process.env.GITHUB_FEEDBACK_REPO ?? '').trim()

// Inert when the channel is unconfigured — the scheduled workflow must exit 0, not fail, when the
// owner hasn't set the secrets (channel OFF, no statements to sweep). Mirrors feedbackConfig fail-closed.
if (!token || !REPO_RE.test(repo)) {
  ok('Feedback channel not configured (GITHUB_FEEDBACK_TOKEN / GITHUB_FEEDBACK_REPO) — nothing to sweep.')
  process.exit(0)
}

const retentionDays = resolveRetentionDays(process.env.FEEDBACK_RETENTION_DAYS)

/** GitHub REST call. Never logs the token. Throws on non-2xx (with body for diagnosis, token-free). */
async function gh(method: string, path: string, body?: unknown) {
  const res = await httpRequest(`${API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cba-feedback-retention',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  if (res.status === undefined || res.status < 200 || res.status >= 300) {
    const detail = res.json?.message ? ` — ${res.json.message}` : ''
    throw new Error(`${method} ${path} → HTTP ${res.status}${detail}`)
  }
  return res.json
}

/** List ALL closed issues (paginated). Pull requests are filtered out (they carry `pull_request`). */
async function listClosedIssues(): Promise<RetentionIssue[]> {
  const out: RetentionIssue[] = []
  for (let page = 1; page <= 50; page++) {
    const batch = await gh('GET', `/repos/${repo}/issues?state=closed&per_page=100&page=${page}`) as Array<Record<string, unknown>>
    if (!Array.isArray(batch) || batch.length === 0) break
    for (const it of batch) {
      if (it.pull_request) continue // the issues endpoint also returns PRs; skip them
      out.push({
        number: Number(it.number),
        state: String(it.state),
        closed_at: (it.closed_at as string | null) ?? null,
        body: (it.body as string | null) ?? ''
      })
    }
    if (batch.length < 100) break
  }
  return out
}

async function main() {
  head(`Feedback retention sweep — repo=${repo}, window=${retentionDays}d, mode=${apply ? C.red + 'APPLY' + C.reset : 'dry-run'}`)
  const issues = await listClosedIssues()
  const plan = planRetention(issues, Date.now(), retentionDays)

  ok(`Closed issues scanned: ${issues.length}; due for redaction: ${plan.length}`)
  if (plan.length === 0) {
    ok('Nothing to redact — all statement PII is within the retention window or already redacted.')
    return
  }

  for (const item of plan) {
    if (!apply) {
      warn(`#${item.number}: would redact statement block(s)`)
      continue
    }
    await gh('PATCH', `/repos/${repo}/issues/${item.number}`, { body: item.body })
    ok(`#${item.number}: redacted`)
  }

  if (!apply) {
    warn(`Dry-run — re-run with --apply to write the ${plan.length} redaction(s).`)
  } else {
    ok(`Redacted ${plan.length} issue(s).`)
  }
}

main().catch((e) => {
  die(`retention sweep failed: ${e instanceof Error ? e.message : String(e)}`)
})
