// GET /api/chat-search?q=<phrase>&offset=<n> — search the CALLER'S portal chats
// for the chat picker (notification / error target). Auth = the Bitrix24 frame
// access token (Authorization: Bearer) + portal domain (X-B24-Domain), same model
// as /api/settings: B24 scopes that token to the caller's portal, so there's no
// member_id to trust and no cross-portal reach. The search therefore runs with the
// operator's identity — see docs/REST_METHODS.md for the identity note (the async
// sender uses the stored portal token; a configurer≠installer mismatch is possible,
// tracked as a follow-up: post as a registered bot / store the sender identity).

import { callRest } from '../utils/b24Rest'
import { bearerToken } from '../utils/settingsHandler'
import { searchChats } from '../utils/chatSearch'
import type { RestCall } from '../utils/companyLookup'

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()
  if (!token || !domain) {
    setResponseStatus(event, 400)
    return { error: 'frame auth (Bearer token + domain) required' }
  }
  const query = getQuery(event)
  const q = typeof query.q === 'string' ? query.q : ''
  const offset = Number(query.offset) || 0

  // Bind the portal transport to the caller's frame token + domain.
  const call: RestCall = (method, params) => callRest(domain, token, method, params)
  try {
    const page = await searchChats(call, q, offset)
    return page
  } catch {
    setResponseStatus(event, 502)
    return { error: 'upstream error' }
  }
})
