// Feedback channel config (docs/FEEDBACK.md): enabled ONLY when a token AND a valid receiving repo
// are set. Fail-closed on purpose — we do NOT default the repo: an unconfigured channel stays OFF
// rather than risk writing client context (employee comments, statement data) into a public repo.
// The owner points GITHUB_FEEDBACK_REPO at a PRIVATE repo (never the public code repo).

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export interface FeedbackConfig {
  token: string
  /** owner/repo of the PRIVATE receiving repo. */
  repo: string
}

/** Resolve the feedback config from env, or null when the channel is disabled/misconfigured. */
export function resolveFeedbackConfig(env: Record<string, string | undefined> = process.env): FeedbackConfig | null {
  const token = (env.GITHUB_FEEDBACK_TOKEN ?? '').trim()
  if (!token) return null // no token → channel OFF (widget hidden, POST → 503)
  const repo = (env.GITHUB_FEEDBACK_REPO ?? '').trim()
  if (!REPO_RE.test(repo)) return null // fail-closed: require an explicit valid repo (never default)
  return { token, repo }
}
