// Live smoke of the #79 automation-trigger REGISTRATION: crm.automation.trigger.add via the
// EXACT pure builder the install runs (`buildTriggerRegisterCall` + `B24_PAYMENT_TRIGGER`), over
// the real per-portal OAuth transport (`makePortalSdkCall`) with an in-memory token store. The
// install iframe registers this on every (re)install, but a portal installed BEFORE #275 lacks
// it; trigger.add is idempotent + needs app (OAuth) context + admin rights, so it can't be
// webhook-tested. Get OAuth creds with scripts/extract-oauth-from-docker.sh → .env.b24oauth.
//
// Run:  node --experimental-strip-types --disable-warning=ExperimentalWarning \
//         --import ./scripts/lib/alias-loader.mjs scripts/trigger-register-test.ts [--apply]
// (wired as `pnpm trigger:test`). DRY-RUN by default (prints the call, registers nothing).
// --apply registers the CODE, then lists triggers to prove it is present (round-trip).

import { loadDotEnv } from './lib/env.mjs'
import { C, head, ok, warn, err } from './lib/cli.mjs'
import { makePortalSdkCall, type SdkPortalDeps } from '../server/utils/b24Sdk.ts'
import type { PortalToken } from '../server/utils/tokenStore.ts'
import { B24_REQUIRED_SCOPES, B24_PAYMENT_TRIGGER } from '../app/config/b24.ts'
import { buildTriggerRegisterCall } from '../app/utils/b24TriggerRegister.ts'

loadDotEnv(['.env.b24oauth', '.env.b24test'], { explicit: false })

const apply = process.argv.includes('--apply')
const env = (k: string) => (process.env[k] ?? '').trim()
const domain = env('B24_OAUTH_DOMAIN')
const memberId = env('B24_OAUTH_MEMBER_ID')
const accessToken = env('B24_OAUTH_ACCESS_TOKEN')
const refreshToken = env('B24_OAUTH_REFRESH_TOKEN')
const clientId = env('B24_CLIENT_ID')
const clientSecret = env('B24_CLIENT_SECRET')
const expiresIn = Number(env('B24_OAUTH_EXPIRES_IN') || 3600)

const missing = Object.entries({ B24_OAUTH_DOMAIN: domain, B24_OAUTH_MEMBER_ID: memberId, B24_OAUTH_ACCESS_TOKEN: accessToken, B24_OAUTH_REFRESH_TOKEN: refreshToken, B24_CLIENT_ID: clientId, B24_CLIENT_SECRET: clientSecret })
  .filter(([, v]) => !v).map(([k]) => k)
if (missing.length) {
  err(`Не хватает env: ${missing.join(', ')}`)
  err('Получи их через scripts/extract-oauth-from-docker.sh → .env.b24oauth (или export).')
  process.exit(1)
}

const token: PortalToken = {
  memberId, domain, accessToken, refreshToken, applicationToken: '',
  expiresAt: Date.now() + expiresIn * 1000
}
const deps: SdkPortalDeps = {
  loadToken: async () => token,
  saveToken: async () => { /* in-memory: nothing to persist for this smoke */ },
  creds: { clientId, clientSecret },
  now: Date.now,
  scope: B24_REQUIRED_SCOPES.join(',')
}

/** Pull the CODE list out of crm.automation.trigger.list (shape varies: array or {triggers}). */
function triggerCodes(result: unknown): string[] {
  const arr = Array.isArray(result) ? result : ((result as { triggers?: unknown[] })?.triggers ?? [])
  return (arr as Array<Record<string, unknown>>).map(t => String(t.CODE ?? t.code ?? '')).filter(Boolean)
}

async function main() {
  head(`crm.automation.trigger.add (#79 регистрация) · портал ${domain} · ${apply ? 'APPLY' : 'DRY-RUN'}`)
  const call = buildTriggerRegisterCall(B24_PAYMENT_TRIGGER.code, B24_PAYMENT_TRIGGER.name)
  if (!call) {
    err('buildTriggerRegisterCall вернул null (проверь CODE/NAME в B24_PAYMENT_TRIGGER)')
    process.exit(1)
  }
  console.log(`${C.dim}call:${C.reset} ${JSON.stringify(call)}`)

  if (!apply) {
    warn('DRY-RUN — ничего не регистрируем. Добавь --apply, чтобы зарегистрировать CODE и проверить список.')
    return
  }

  const rest = await makePortalSdkCall(memberId, deps)
  if (!rest) {
    err('makePortalSdkCall вернул null (нет токена?)')
    process.exit(1)
  }

  // 1) register (idempotent — re-adding the same CODE just updates NAME)
  await rest(call.method, call.params)
  ok(`crm.automation.trigger.add отработал (CODE=${B24_PAYMENT_TRIGGER.code})`)

  // 2) list → the CODE must now be present (registration round-trip)
  const listed = await rest('crm.automation.trigger.list', {}) as { result?: unknown }
  const codes = triggerCodes(listed.result)
  if (codes.includes(B24_PAYMENT_TRIGGER.code)) {
    ok(`round-trip OK — trigger.list содержит «${B24_PAYMENT_TRIGGER.code}» (всего ${codes.length})`)
  } else {
    err(`round-trip НЕ сошёлся — «${B24_PAYMENT_TRIGGER.code}» не в списке: [${codes.join(', ')}]`)
    process.exit(1)
  }

  console.log(`\n${C.green}✓ Регистрация триггера автоматизации работает вживую (#79).${C.reset}`)
  console.log(`${C.dim}Дальше админ портала вешает CODE «${B24_PAYMENT_TRIGGER.code}» на правило автоматизации,`)
  console.log(`а в настройках приложения указывает его в allocation.triggerCode — тогда воркер его фаерит.${C.reset}\n`)
}

main().catch((e) => {
  err(`FATAL: ${(e as Error).message}`)
  process.exit(1)
})
