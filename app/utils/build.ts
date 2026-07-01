// Build/version info for the footer — a link to the exact commit the running
// build came from. The SHA is injected at build time via NUXT_PUBLIC_COMMIT_SHA
// (CI passes ${{ github.sha }}); empty in dev. Pure + unit-tested.

export const REPO_URL = 'https://github.com/bx-shef/client-bank-alfa-by'

/** Short (7-char) commit for display; '' when the SHA is unknown (dev builds). */
export function shortSha(sha: string | undefined | null): string {
  return (sha ?? '').trim().slice(0, 7)
}

/** Link to the exact commit, or the repo root when the SHA is unknown. */
export function commitUrl(sha: string | undefined | null): string {
  const s = (sha ?? '').trim()
  return s ? `${REPO_URL}/commit/${s}` : REPO_URL
}
