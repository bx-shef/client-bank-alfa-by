// Wires the pure app-settings handler to real I/O (Postgres token store + B24
// REST). Kept separate so routes share one factory and the handler stays pure.

import { dbQuery } from '../db/client'
import { callRest } from './b24Rest'
import { ensureAccessToken } from './ensureAccessToken'
import { getToken } from './tokenStore'
import type { AppSettingsDeps } from './appSettings'

export function liveAppSettingsDeps(): AppSettingsDeps {
  return {
    loadToken: memberId => getToken(dbQuery, memberId),
    ensureFresh: token => ensureAccessToken(dbQuery, token),
    callRest
  }
}
