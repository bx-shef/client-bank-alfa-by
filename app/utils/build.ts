// Build/version info for the footer — a link to the exact commit the running
// build came from. The SHA is injected at build time via NUXT_PUBLIC_COMMIT_SHA
// (CI passes ${{ github.sha }}); empty in dev. Pure + unit-tested.

/**
 * Репозиторий АПСТРИМА — запасной адрес, если свой не задан.
 *
 * ⚠ Клиентская установка разворачивается из КЛОНА в репозиторий клиента (docs/DEPLOY_BITRIXVM.md),
 * и до появления `NUXT_PUBLIC_REPO_URL` эта строка была единственной: подпись «сборка <sha>» у
 * клиента вела в НАШ репозиторий, куда у него доступа нет. То есть ровно та ссылка, которая должна
 * отвечать «какой код сейчас работает», приводила на страницу 404 — и это тем незаметнее, чем реже
 * по ней кликают.
 */
export const REPO_URL = 'https://github.com/bx-shef/client-bank-alfa-by'

/**
 * Адрес репозитория этой сборки: значение из env, иначе апстрим.
 *
 * ⚠ Проверяем, а не подставляем как есть: значение приходит переменной сборки, попадает в `href`
 * подписи на КАЖДОМ экране, и пустое/кривое дало бы битую ссылку в подвале вместо честной нашей.
 * Требуем `https` и непустой хост; `javascript:` и прочее до `href` не доедет по построению.
 */
export function resolveRepoUrl(value: string | undefined | null): string {
  const v = (value ?? '').trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^\s/]+\/\S+$/.test(v)) return REPO_URL
  return v
}

/** Short (7-char) commit for display; '' when the SHA is unknown (dev builds). */
export function shortSha(sha: string | undefined | null): string {
  return (sha ?? '').trim().slice(0, 7)
}

/** Link to the exact commit, or the repo root when the SHA is unknown.
 *  `repoUrl` — адрес репозитория ЭТОЙ сборки (у клона он свой); пусто ⇒ апстрим. */
export function commitUrl(sha: string | undefined | null, repoUrl?: string | null): string {
  const base = resolveRepoUrl(repoUrl)
  const s = (sha ?? '').trim()
  return s ? `${base}/commit/${s}` : base
}

/** Health/liveness payload for the backend `/api/health` endpoint. `commit` is
 * the running build (same SHA as the footer), `time` the moment of the request. */
export interface HealthInfo {
  status: 'ok'
  time: string
  commit: string
  commitUrl: string
}

/** Build the health payload from the build SHA and current time (pure/testable).
 * Falls back to 'dev' when no SHA was injected (local/dev builds). */
export function healthInfo(
  commitSha: string | undefined | null, nowIso: string, repoUrl?: string | null
): HealthInfo {
  const commit = (commitSha ?? '').trim() || 'dev'
  return { status: 'ok', time: nowIso, commit, commitUrl: commitUrl(commitSha, repoUrl) }
}
