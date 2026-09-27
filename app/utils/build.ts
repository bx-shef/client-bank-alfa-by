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
 * Требуем `https`, хост без логина (`httpsHref`) и путь к репозиторию; `javascript:` и прочее до
 * `href` не доедет по построению. Прежняя регулярка пропускала `https://github.com@чужой.сайт/…`
 * — адрес, который ведёт на `чужой.сайт`.
 */
export function resolveRepoUrl(value: unknown): string {
  const v = String(value ?? '').trim().replace(/\/+$/, '')
  const href = /\s/.test(v) ? '' : httpsHref(v)
  if (!href || new URL(href).pathname.length < 2) return REPO_URL
  return v
}

/**
 * Автор в подвале по умолчанию (#758, решение владельца 2026-09-27; прежнее умолчание
 * `bx-shef` / `https://bx-shef.by` снято). Имя — то же, что `LANDING_PUBLISHER` в `seo.ts`: это
 * один и тот же человек, и эти две копии строки уже успели разойтись («И.С.» против «И. С.»),
 * поэтому `seo.ts` берёт его отсюда. Направление такое, потому что этот модуль без зависимостей
 * и его грузит сервер ради `/api/health`, а `seo.ts` тянет за собой таблицу маршрутов.
 * ⚠ Логотип (`AppLogo.vue`) пишет «Шевчик И.С.» слитно и сюда не привязан: это начертание знака,
 * а не подпись.
 */
export const DEFAULT_AUTHOR_NAME = 'ИП Шевчик И. С.'
export const DEFAULT_AUTHOR_URL = 'https://offer.bx-shef.by/?ref=bank-import'

/**
 * Адрес для `href`, если это `https` без логина в адресе; иначе пусто.
 *
 * ⚠ Через `new URL`, а не регуляркой: `https://свой.сайт@чужой.сайт` — валидный адрес, который
 * ведёт на `чужой.сайт`, и регулярка вида «https, потом хост» его пропускала.
 */
function httpsHref(value: string): string {
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return ''
    return u.href
  } catch {
    return ''
  }
}

/**
 * Автор для подвала: заданное значение или умолчание.
 *
 * ⚠ Умолчание применяется ЗДЕСЬ, а в `nuxt.config.ts` у ключей пусто: пустая переменная сборки
 * перекрывает любое умолчание конфига (замерено: `NUXT_PUBLIC_AUTHOR_NAME=` при `nuxt generate`
 * даёт `authorName:""`), а `Dockerfile` выставляет её пустой всякий раз, когда переменная
 * репозитория не задана. У клона без переменных подвал выходил ПУСТЫМ.
 *
 * ⚠ Имя и ссылка идут ПАРОЙ, в обе стороны:
 * - имени нет ⇒ наше имя и наша ссылка, даже если задан адрес: наше имя не должно вести на чужой
 *   сайт;
 * - имя своё ⇒ ссылка только своя: своё имя без адреса выходит подписью без ссылки, а не
 *   ссылкой на наш оффер;
 * - имя совпало с нашим ⇒ без адреса подставляется наш.
 *
 * Значения приходят через `destr` и бывают числом или булевым (`2026` → число), поэтому
 * приводим к строке, а не зовём `.trim()` у чего попало.
 */
export function resolveAuthor(name: unknown, url: unknown): { name: string, url: string } {
  const n = String(name ?? '').trim()
  const u = httpsHref(String(url ?? '').trim())
  if (!n) return { name: DEFAULT_AUTHOR_NAME, url: DEFAULT_AUTHOR_URL }
  if (n === DEFAULT_AUTHOR_NAME) return { name: n, url: u || DEFAULT_AUTHOR_URL }
  return { name: n, url: u }
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
