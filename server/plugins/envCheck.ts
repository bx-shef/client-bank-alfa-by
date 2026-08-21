// Nitro startup plugin: validate the backend env and log the result at boot, so a
// misconfigured deploy (bad B24_TOKEN_ENC_KEY, a CHANGE_ME B24_APPLICATION_TOKEN,
// missing DATABASE_URL) is obvious immediately instead of failing deep in a request.
//
// Follows the codebase convention (see authGuard.ts / migrate.ts): log, never
// crash — a thrown boot error would crash-loop the container and break `nuxt
// generate` prerendering. Pure check lives in server/utils/envCheck.ts (tested).

import { statSync } from 'node:fs'
import { checkBackendEnv } from '../utils/envCheck'
import { useServerLogger } from '../utils/serverLogger'

const log = useServerLogger('env')

/** A readable, non-empty FILE — not a directory. Docker silently creates a DIRECTORY when a bind
 *  mount's host path is missing, which is exactly the case this probe has to catch. */
function caBundleReadable(path: string): boolean {
  try {
    const st = statSync(path)
    return st.isFile() && st.size > 0
  } catch {
    return false
  }
}

export default defineNitroPlugin(() => {
  // Nothing serves requests during static prerender, and the env isn't present
  // there — skip so `nuxt generate` / build stays quiet.
  if (import.meta.prerender) return

  const { errors, warnings } = checkBackendEnv(process.env, { caBundleReadable })
  for (const w of warnings) log.warning(w)
  for (const e of errors) log.error(e)
  if (errors.length) {
    log.error(`обнаружено проблем: ${errors.length}. Backend продолжит работу, но приём/хранение токенов портала может не работать — исправьте .env и перезапустите.`)
  }
})
