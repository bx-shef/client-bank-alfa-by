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
import { resolveTelegramConfig, telegramConfigAttempted } from './telegramAlert'
import { normalizeAuthorizeBase, normalizeBankApiBase, sameOrigin } from '../../app/utils/bankGatewayUrl'

const KEY_BYTES = 32

/** Whether two env-encoded keys decode to the same bytes (hex vs base64 spelling included). */
function sameKeyBytes(a: string, b: string): boolean {
  try {
    const decode = (v: string) => (/^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64'))
    return decode(a).equals(decode(b))
  } catch {
    return false
  }
}

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

  // --- Previous encryption key (rotation). When set it must be valid AND different: a malformed
  // one silently kills the second decryption attempt (the runtime skips it with a warning, so this
  // log line is the only loud signal), and an identical one usually means the rotation was started
  // but the new key was never put in. Compared BYTE-WISE, not as strings: the same key written as
  // hex in one variable and base64 in the other is still the same key.
  const oldKey = (env.B24_TOKEN_ENC_KEY_OLD ?? '').trim()
  if (oldKey) {
    const n = encKeyBytes(oldKey)
    if (n !== KEY_BYTES) {
      errors.push(`B24_TOKEN_ENC_KEY_OLD задан, но должен декодироваться в ${KEY_BYTES} байта (сейчас ${n}) — иначе токены, зашифрованные прежним ключом, не прочитаются`)
    } else if (sameKeyBytes(oldKey, key)) {
      warnings.push('B24_TOKEN_ENC_KEY_OLD совпадает с B24_TOKEN_ENC_KEY — ротация не начата, переменную можно убрать')
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
  const priorMethodRaw = (env.PRIOR_OAUTH_AUTH_METHOD ?? '').trim()
  const priorUsesJwt = priorMethodRaw === 'private_key_jwt'
  for (const [prefix, bank] of [['ALFA_OAUTH', 'Альфа'], ['PRIOR_OAUTH', 'Приор']] as const) {
    // Under private_key_jwt the client secret never travels (the signed assertion authenticates
    // us) and the bank may not issue one — so it is not part of the required set there (#444).
    const parts = prefix === 'PRIOR_OAUTH' && priorUsesJwt
      ? [`${prefix}_CLIENT_ID`, `${prefix}_TOKEN_URL`]
      : [`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`, `${prefix}_TOKEN_URL`]
    const set = parts.filter(k => !!(env[k] ?? '').trim())
    if (set.length > 0 && set.length < parts.length) {
      const missing = parts.filter(k => !(env[k] ?? '').trim())
      warnings.push(`Банк ${bank}: заданы не все OAuth-креды (нет ${missing.join('/')}) — онлайн-опрос ${bank} отключён (нужны все: ${parts.join(', ')}).`)
    }
  }

  // --- Prior client-auth method (#444). Two states are dangerous enough to name at boot, because
  //     both surface only as opaque 401s from the bank, far from the cause:
  //     1) a TYPO in the method — silently coerced to the sandbox-only Basic;
  //     2) private_key_jwt selected but its key material incomplete — the refresh job then throws
  //        per account, and connect answers 502, with nothing at startup hinting why. ---
  if (priorMethodRaw && priorMethodRaw !== 'client_secret_basic' && !priorUsesJwt) {
    warnings.push(`PRIOR_OAUTH_AUTH_METHOD="${priorMethodRaw}" не распознан — используется client_secret_basic (только для тестовой среды банка). Допустимые значения: client_secret_basic, private_key_jwt.`)
  }
  if (priorUsesJwt) {
    const jwtParts = ['PRIOR_OAUTH_PRIVATE_KEY', 'PRIOR_OAUTH_KID', 'PRIOR_OAUTH_AUDIENCE']
    const missing = jwtParts.filter(k => !(env[k] ?? '').trim())
    if (missing.length > 0) {
      warnings.push(`PRIOR_OAUTH_AUTH_METHOD=private_key_jwt, но нет ${missing.join('/')} — подпись client_assertion невозможна: подключение Приора вернёт 502, обновление токена будет падать по каждому счёту.`)
    }
  }

  // --- Crypto-gateway addressing (#455). `PRIOR_OAUTH_API_BASE` and `PRIOR_OAUTH_TOKEN_URL` are
  //     INDEPENDENT variables and nothing ties them together: move one onto the gateway, forget the
  //     other, and token refresh keeps quietly talking to the old host — the import then stops with
  //     what looks like an ordinary refresh failure. Same for a base that points at an internal
  //     gateway with no public authorize origin: the connect flow dies with NO server-side error. ---
  const priorApiBase = (env.PRIOR_OAUTH_API_BASE ?? '').trim()
  const priorTokenUrl = (env.PRIOR_OAUTH_TOKEN_URL ?? '').trim()
  // ⚠ РАЗНЫЕ адреса у этих двух переменных — НЕ ошибка сама по себе: банк разносит API, и
  // требование BY-крипто `:9345` относится к серверу авторизации (`Open-banking-authorize`), а не
  // к ресурсному `Open-banking`. Поэтому «токен через шлюз, ресурсы на публичном хосте» —
  // законная конфигурация, и предупреждать о ней значило бы приучать оператора игнорировать
  // предупреждения. Опасен ПОЛОВИНЧАТЫЙ переезд: одна переменная внутрь сети, другая осталась
  // снаружи по недосмотру. Внутренний адрес узнаём тем же способом, что и ниже: пригоден как
  // backend-origin, но непригоден как публичный.
  const isInternal = (v: string) => !!normalizeBankApiBase(v) && !normalizeAuthorizeBase(v)
  if (priorApiBase && priorTokenUrl && !sameOrigin(priorApiBase, priorTokenUrl)
    && isInternal(priorApiBase) !== isInternal(priorTokenUrl)) {
    warnings.push('PRIOR_OAUTH_API_BASE и PRIOR_OAUTH_TOKEN_URL: одна переменная указывает внутрь сети (крипто-шлюз), вторая — наружу. Похоже на незавершённый перевод Приора на шлюз: проверьте, что через шлюз идёт именно то, что должно, а остальное осталось на публичном хосте осознанно.')
  }
  const priorApiBaseOk = !!normalizeBankApiBase(priorApiBase)
  if (priorApiBase && !priorApiBaseOk) {
    warnings.push('PRIOR_OAUTH_API_BASE непригоден: нужен https:// либо http:// на ВНУТРЕННИЙ адрес (localhost / имя docker-сервиса / приватная сеть) — так работает крипто-шлюз. http:// на публичный хост отправил бы токен открытым текстом.')
  }
  const priorAuthorizeBase = (env.PRIOR_OAUTH_AUTHORIZE_BASE ?? '').trim()
  if (priorAuthorizeBase && !normalizeAuthorizeBase(priorAuthorizeBase)) {
    warnings.push('PRIOR_OAUTH_AUTHORIZE_BASE непригоден: это публичный адрес банка, который открывает БРАУЗЕР администратора — нужен https:// и не внутренний хост.')
  }
  // Gated on a VALID api base: a broken one already got its own (accurate) warning above, and
  // saying «указывает на внутренний адрес» about `http://api.priorbank.by` or about garbage would
  // send the operator looking for a gateway that isn't there. Once the base IS valid, the only way
  // it can fail as an authorize origin is that it points inside our network — so the wording holds.
  if (!priorAuthorizeBase && priorApiBaseOk && !normalizeAuthorizeBase(priorApiBase)) {
    warnings.push('PRIOR_OAUTH_API_BASE указывает на внутренний адрес, а PRIOR_OAUTH_AUTHORIZE_BASE не задан — подключение Приора отключено: страницу авторизации браузеру открыть будет негде.')
  }

  // --- Telegram alert channel (#426). Not configured = OFF, and that is a normal deployment,
  //     so silence. But a channel that was ATTEMPTED and does not parse is the dangerous state:
  //     the operator believes they are being watched while every alert is dropped — precisely the
  //     failure this channel exists to prevent. Hence: warn only when they clearly meant to. ---
  if (telegramConfigAttempted(env) && !resolveTelegramConfig(env)) {
    const bad = [
      (env.TELEGRAM_ALERT_BOT_TOKEN ?? '').trim() ? null : 'TELEGRAM_ALERT_BOT_TOKEN пуст',
      (env.TELEGRAM_ALERT_CHAT_ID ?? '').trim() ? null : 'TELEGRAM_ALERT_CHAT_ID пуст'
    ].filter(Boolean)
    warnings.push(`Телеграм-канал оповещений задан частично или неверно (${bad.length ? bad.join('; ') : 'значения не проходят проверку формата'}) — канал ВЫКЛЮЧЕН, аварии очередей уйдут только в лог и на /queues. Токен бота: «<цифры>:<строка>», chat id: число (у группы отрицательное) или @имя_канала.`)
  }

  return { errors, warnings }
}
