// Backend env validation — pure, unit-testable (no side effects). A startup
// plugin (server/plugins/envCheck.ts) logs the result at boot so a misconfigured
// deploy is obvious immediately, instead of failing deep inside a request handler.
//
// Motivated by two real prod traps:
//   - B24_TOKEN_ENC_KEY the wrong length (e.g. a truncated paste → 31 bytes) →
//     refresh-token encryption throws and the install can't store its token;
//   - B24_APPLICATION_TOKEN left as a placeholder (CHANGE_ME) → the real token
//     from ONAPPINSTALL never matches it → the verdict is 403 → install rejected.

import { Buffer } from 'node:buffer'

const KEY_BYTES = 32

/** Obvious non-secret placeholders that must never be a live application_token. */
const PLACEHOLDER_TOKENS = new Set([
  'change_me', 'changeme', 'change-me', 'xxx', 'placeholder', 'todo', 'your-token', 'your_token', 'secret'
])

export interface EnvReport {
  /** Misconfigurations that break token receipt/storage (loud console.error). */
  errors: string[]
  /** Non-fatal gaps — event receipt works, but some later feature won't (warn). */
  warnings: string[]
}

/** Decode the enc key the same way secretCrypto.loadEncKey does (hex64 or base64). */
function encKeyBytes(raw: string): number {
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  return buf.length
}

/**
 * Validate the backend's environment. Returns errors + warnings; never throws
 * (so it's safe to call at boot without crash-looping the container).
 */
export function checkBackendEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const errors: string[] = []
  const warnings: string[] = []

  // --- Token encryption key: required, must decode to exactly 32 bytes. ---
  const key = (env.B24_TOKEN_ENC_KEY ?? '').trim()
  if (!key) {
    errors.push('B24_TOKEN_ENC_KEY не задан — refresh-токены не зашифровать, установка не сохранит токен. Сгенерируйте: openssl rand -hex 32')
  } else {
    const n = encKeyBytes(key)
    if (n !== KEY_BYTES) {
      errors.push(`B24_TOKEN_ENC_KEY должен декодироваться в ${KEY_BYTES} байта (сейчас ${n}). Нужно 64 hex-символа или base64 32 байт: openssl rand -hex 32`)
    }
  }

  // --- Application token: optional (per-portal bootstrap), but a placeholder
  //     value silently breaks every install (real token != placeholder → 403). ---
  const appTok = (env.B24_APPLICATION_TOKEN ?? '').trim()
  if (appTok && PLACEHOLDER_TOKENS.has(appTok.toLowerCase())) {
    errors.push(`B24_APPLICATION_TOKEN="${appTok}" похоже на плейсхолдер — реальный токен из ONAPPINSTALL с ним не совпадёт, и установка получит 403. Оставьте переменную пустой (мультитенант-bootstrap) или впишите реальный shared-guard токен.`)
  }

  // --- Postgres: the token store needs it. ---
  if (!(env.DATABASE_URL ?? '').trim()) {
    errors.push('DATABASE_URL не задан — хранилище токенов портала недоступно.')
  }

  // --- Operator session signing key (#242 P1): in production a set operator password
  //     with no SESSION_SECRET means the session zone is fail-closed (session.ts no
  //     longer derives the key from the password), so operators can't sign in. Error. ---
  const isProd = (env.NODE_ENV ?? '') === 'production'
  const hasOpPass = !!(env.PUBLIC_PAGE_BASIC_AUTH_PASS ?? '').trim()
  const hasSessionSecret = !!(env.SESSION_SECRET ?? '').trim()
  if (isProd && hasOpPass && !hasSessionSecret) {
    errors.push('SESSION_SECRET не задан в проде при заданном пароле оператора — ключ подписи cookie больше НЕ выводится из пароля (защита от офлайн-брутфорса), поэтому вход в служебную зону не работает (fail-closed). Задайте независимый ключ: openssl rand -hex 32')
  }

  // --- OAuth app creds: needed for access-token refresh, app.option, and the install-time
  //     member_id binding (#162). Events are still received and the token is still stored, but
  //     WITHOUT the member_id→grant verification. So: warning, not error. ---
  const hasClientId = !!(env.B24_CLIENT_ID ?? '').trim()
  const hasClientSecret = !!(env.B24_CLIENT_SECRET ?? '').trim()
  if (!hasClientId || !hasClientSecret) {
    warnings.push('B24_CLIENT_ID/B24_CLIENT_SECRET не заданы — refresh access-токена, настройка app.option и привязка member_id на установке (#162) работать не будут (приём событий и запись токена — будут, но БЕЗ проверки member_id→грант).')
  }

  // --- Redis: without it the queue is off and event persistence degrades to the
  //     synchronous fallback in the webhook (no async pipeline: no follow-up jobs,
  //     no cron fan-out). Not fatal (installs still persist), so: warning. ---
  if (!(env.REDIS_URL ?? '').trim()) {
    warnings.push('REDIS_URL не задан — очередь выключена; приём событий деградирует до синхронной записи в webhook (без асинхронного пайплайна — воркеры/крон не работают).')
  }

  // --- Bank online-fetch OAuth creds (stage 5): each bank needs ALL of
  //     <PREFIX>_CLIENT_ID/_CLIENT_SECRET/_TOKEN_URL to refresh its token (bankCredsFromEnv).
  //     A HALF-configured bank silently disables its online fetch (only a runtime warn),
  //     so surface a partial config at boot. Absent entirely = feature off, no warning. ---
  for (const [prefix, bank] of [['ALFA_OAUTH', 'Альфа'], ['PRIOR_OAUTH', 'Приор']] as const) {
    const parts = [`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`, `${prefix}_TOKEN_URL`]
    const set = parts.filter(k => !!(env[k] ?? '').trim())
    if (set.length > 0 && set.length < parts.length) {
      const missing = parts.filter(k => !(env[k] ?? '').trim())
      warnings.push(`Банк ${bank}: заданы не все OAuth-креды (нет ${missing.join('/')}) — онлайн-опрос ${bank} отключён (нужны все три: ${parts.join(', ')}).`)
    }
  }

  return { errors, warnings }
}
