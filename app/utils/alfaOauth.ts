// Чистые помощники OAuth Альфа-Банка Беларусь (`partner.authorization 1.0.0`). Без ввода-вывода:
// собирают тела запросов к `${baseUrl}/token` и разбирают ответ. Транспорт и секреты — на сервере.
//
// ⚠ AUTHORIZATION CODE FLOW ЗДЕСЬ БОЛЬШЕ НЕТ (#488, решение владельца 2026-09-09). Он работал —
// но только для разработки. На проде измерено дважды: цепочка refresh живёт РОВНО 10 часов от
// авторизации и не продлевается ни своевременным обновлением (19 обменов по полчаса проходят,
// 20-й на 10 ч 03 мин отвергается), ни обращениями к API (те же 19 ступеней делали успешный
// вызов — граница не сдвинулась ни на минуту). То есть серверное приложение требовало живого
// входа владельца счёта в интернет-банк дважды в сутки, навсегда.
//
// Осталось два запроса, и оба живут без человека:
//   • `buildPasswordGrantBody` — обмен КЛЮЧА API на пару токенов (ключ бессрочный, его выдаёт
//     владелец счёта в своём кабинете под наш `client_id` и там же может отозвать);
//   • `buildRefreshBody` — обычное продление, пока цепочка жива.
// Умерла цепочка — пара переиздаётся ключом (`ensureBankToken`), а не человеком.
//
// ⚠ У Приора всё иначе и остаётся на OAuth: там Open Banking, и другого пути нет (`priorOauth.ts`).

/** Non-secret OAuth config (clientSecret is added only server-side at call time). */
export interface AlfaOAuthConfig {
  /** OAuth base, e.g. `https://developerhub.alfabank.by:8273` (sandbox) or
   * `https://ibapi2.alfabank.by:8273` (prod). No trailing slash. */
  baseUrl: string
  clientId: string
  /** Space-separated scopes; default `accounts`. */
  scope?: string
}

const DEFAULT_SCOPE = 'accounts'

/** Refresh-token lifetime per Alfa docs (~10 h). Not returned by the token
 * response — kept here so the documented value is greppable and verifiable;
 * confirm against the sandbox on the live run. */
export const ALFA_REFRESH_TOKEN_TTL_SEC = 36_000

/**
 * Тело запроса Password Grant — обмен КЛЮЧА API на пару токенов (#488).
 *
 * ⚠ Название типа авторизации вводит в заблуждение: пароля здесь нет. В `username` едет ключ API,
 * который ВЛАДЕЛЕЦ СЧЁТА генерирует у себя в кабинете Альфа Бизнес Онлайн под наш `client_id`
 * (Настройки → Open API), и он же может его заблокировать или отозвать. Логин от банка клиент нам
 * не отдаёт.
 *
 * ⚠ ЗАЧЕМ ЭТО ВМЕСТО OAUTH. Замерено дважды: у Code Grant цепочка refresh живёт РОВНО 10 часов от
 * авторизации, и продлить её нельзя ничем — ни своевременным обновлением (19 обменов по полчаса
 * прошли, 20-й на 10 ч 03 мин отвергнут), ни использованием токена (те же 19 ступеней делали
 * успешный запрос к API — граница не сдвинулась ни на минуту). То есть серверное приложение на
 * Code Grant требует живого входа владельца счёта в интернет-банк дважды в сутки, навсегда.
 * С постоянным ключом мёртвая цепочка лечится переизданием пары, без человека.
 *
 * ⚠ `scope` — только `accounts`: нам нужна выписка, а в документации банка список на десяток прав,
 * включая подпись документов. Просить больше, чем используешь, здесь стоило бы ровно ничего и
 * означало бы держать у себя доступ к чужим платежам.
 *
 * ⚠ Ключ API — секрет наравне с `client_secret` и БЕССРОЧНЫЙ, в отличие от refresh: он не
 * ротируется сам, поэтому утёкший однажды остаётся годным, пока клиент его не отзовёт. В логи,
 * в текст ошибки и в вывод не попадает никогда.
 */
export function buildPasswordGrantBody(
  config: Pick<AlfaOAuthConfig, 'clientId' | 'scope'>,
  apiKey: string,
  clientSecret: string
): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'password',
    username: apiKey,
    client_id: config.clientId,
    client_secret: clientSecret,
    scope: config.scope || DEFAULT_SCOPE
  })
}

/** Form body for refreshing tokens. Caller POSTs it to `${baseUrl}/token`.
 * Per RFC 6749 §6, `redirect_uri`/`scope` are omitted; if the Alfa sandbox
 * rejects refresh without them, add them here (verify on the BY server).
 * Contains `client_secret` — never log it. */
export function buildRefreshBody(
  config: Pick<AlfaOAuthConfig, 'clientId'>,
  refreshToken: string,
  clientSecret: string
): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: clientSecret
  })
}

/** Normalized token set returned by parseTokenResponse. */
export interface AlfaTokenSet {
  accessToken: string
  refreshToken: string
  tokenType: string
  /** Seconds the access token is valid for (Alfa: 3600). Pair with the receipt
   * timestamp (`Date.now()`) when persisting — see isAccessTokenExpired. */
  expiresIn: number
}

/** Raw `POST /token` JSON shape. */
interface RawTokenResponse {
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  error?: string
  error_description?: string
}

/**
 * Parse a `/token` JSON response into a typed token set. Throws with the OAuth
 * error description on an error payload or a missing access token.
 */
export function parseTokenResponse(raw: RawTokenResponse): AlfaTokenSet {
  if (raw.error) {
    throw new Error(`Alfa OAuth error: ${raw.error}${raw.error_description ? ` — ${raw.error_description}` : ''}`)
  }
  if (!raw.access_token || !raw.refresh_token) {
    throw new Error('Alfa OAuth: token response missing access_token/refresh_token')
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    tokenType: raw.token_type ?? 'Bearer',
    expiresIn: raw.expires_in ?? 3600
  }
}

/**
 * Whether an access token should be refreshed now. `issuedAtMs` is the wall
 * clock (`Date.now()`) captured by the caller when the token set was received
 * and persisted — the token store must save it alongside the AlfaTokenSet, or
 * this check is meaningless. `skewMs` (default 60s) refreshes early to avoid
 * using a token that expires mid-request.
 */
export function isAccessTokenExpired(issuedAtMs: number, expiresIn: number, nowMs: number, skewMs = 60_000): boolean {
  return nowMs >= issuedAtMs + expiresIn * 1000 - skewMs
}
