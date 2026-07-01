// GET /api/health — public liveness probe for the backend (Nitro) service.
// Returns { status, time, commit, commitUrl } — no secrets. `commit` is the build
// the backend is running (same NUXT_PUBLIC_COMMIT_SHA the landing footer shows), so
// hitting this URL tells you the backend is up and which build it is. Reachable at
// https://<domain>/api/health (nginx proxies /api/* to the backend).

import { healthInfo } from '../../app/utils/build'

export default defineEventHandler(() => {
  const commit = useRuntimeConfig().public.commitSha as string | undefined
  return healthInfo(commit, new Date().toISOString())
})
