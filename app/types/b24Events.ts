// Domain model for Bitrix24 outgoing event webhooks the app must handle
// server-side: ONAPPINSTALL (capture auth + application_token) and
// ONAPPUNINSTALL (purge a portal's data). Pure types only — no runtime — so
// they are shared by the future backend that owns the HTTP transport and the
// token store. Shapes follow the official REST docs (common/events/on-app-*).

/** Event codes this app subscribes to. B24 sends them upper-cased on the wire. */
export type B24EventCode = 'ONAPPINSTALL' | 'ONAPPUNINSTALL'

/** App status of the subscriber, per B24: Local / Free-listed / Subscription. */
export type B24AppStatus = 'L' | 'F' | 'S'

/**
 * The `auth` block B24 attaches to every event POST. `application_token` is the
 * shared secret used to authenticate the webhook (see safe-event-handlers).
 * The OAuth token fields are present on ONAPPINSTALL (and updates), absent on
 * ONAPPUNINSTALL — the app is already removed, so its API rights are revoked.
 */
export interface B24EventAuth {
  /** Portal address, e.g. `some-domain.bitrix24.ru`. */
  domain: string
  /** Stable portal id — the token store's primary key. */
  member_id: string
  /** Shared secret authenticating the webhook call. Store it at install time. */
  application_token: string
  /** Base path for REST calls against the portal. */
  client_endpoint?: string
  /** Auth-server base used to refresh the access token. */
  server_endpoint?: string
  status?: B24AppStatus
  /** OAuth access token (present on install/update, not on uninstall). */
  access_token?: string
  /** OAuth refresh token (present on install/update, not on uninstall). */
  refresh_token?: string
  /** Access-token lifetime in seconds (B24: 3600). */
  expires_in?: number
  /** Space-separated granted scopes. */
  scope?: string
}

/** `data` payload of ONAPPINSTALL. `VERSION` arrives as a string on the wire. */
export interface B24InstallEventData {
  VERSION: string
  LANGUAGE_ID: string
  /** `Y`/`N` — app active flag. */
  ACTIVE?: string
  /** `Y` once the app is fully installed; events fire only after `installFinish`. */
  INSTALLED?: string
}

/** `data` payload of ONAPPUNINSTALL. */
export interface B24UninstallEventData {
  LANGUAGE_ID: string
  /** User's "clear app data" choice on uninstall: `1` = purge, `0` = keep. */
  CLEAN: number | string
}

/** Generic envelope of a B24 outgoing event POST. */
export interface B24Event<TData> {
  event: string
  data: TData
  /** Unix timestamp (string) when the event left the queue. */
  ts?: string
  auth: B24EventAuth
}

export type B24InstallEvent = B24Event<B24InstallEventData>
export type B24UninstallEvent = B24Event<B24UninstallEventData>

/**
 * Normalized per-portal credentials the backend persists at install time and
 * reads back to call the portal's REST API and to authenticate later events.
 * `issuedAtMs` pairs with `expiresIn` for refresh (see alfaOauth.isAccessTokenExpired
 * for the same pattern). Never log `applicationToken`/`refreshToken`/`accessToken`.
 */
export interface PortalCredentials {
  memberId: string
  domain: string
  applicationToken: string
  clientEndpoint?: string
  serverEndpoint?: string
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  scope?: string
}
