// Alfa-Bank BY OAuth 2.0 endpoints and scopes (developerhub partner API).
// Pure config — no secrets, no runtime. The client_id/client_secret/redirect_uri
// are supplied at runtime (env on the backend), never committed here.
//
// Source: developerhub.alfabank.by "partner.authorization" guide. The OAuth
// gateway listens on the non-standard port 8273 — keep it in the URLs.

import type { OAuthEndpoints } from '~/utils/oauth'

/** Authorization Code Grant endpoints for the Alfa developerhub gateway. */
export const ALFA_OAUTH_ENDPOINTS: OAuthEndpoints = {
  authorizeUrl: 'https://developerhub.alfabank.by:8273/authorize',
  tokenUrl: 'https://developerhub.alfabank.by:8273/token'
}

/** Token lifetimes documented by Alfa (seconds). */
export const ALFA_TOKEN_LIFETIME = {
  /** access_token: 1 hour. */
  accessToken: 3600,
  /** refresh_token: 10 hours. */
  refreshToken: 36000
} as const

/**
 * OAuth scopes exposed by the Alfa partner API. `value` is the wire token,
 * `title` is a short Russian label for the settings UI.
 */
export const ALFA_SCOPES = [
  { value: 'profile', title: 'Информация о клиенте' },
  { value: 'accounts', title: 'Счета и остатки' },
  { value: 'read_documents', title: 'Документы и платежи (чтение)' },
  { value: 'create_documents', title: 'Документы и платежи (создание)' },
  { value: 'sign_documents', title: 'Документы и платежи (подпись)' },
  { value: 'cards', title: 'Корпоративные карты' },
  { value: 'read_currency', title: 'Покупка/продажа валюты (чтение)' },
  { value: 'create_currency', title: 'Покупка/продажа валюты (создание)' },
  { value: 'read_employees', title: 'Зарплатный проект (чтение)' },
  { value: 'create_employees', title: 'Зарплатный проект (создание)' },
  { value: 'read_acquiring_partner', title: 'Информация о терминалах (чтение)' }
] as const

/** Scopes needed to read statements — the first integration milestone. */
export const ALFA_STATEMENT_SCOPES = ['accounts', 'read_documents', 'profile'] as const
