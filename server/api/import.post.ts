// POST /api/import — accept a manually-uploaded statement file for async import.
// Auth = the B24 frame access token (Authorization: Bearer) + X-B24-Domain, same
// model as /api/chat-settings. The RAW file is sent (multipart `file`) — the server
// is the single parse authority (it re-parses in the worker); the browser's own
// parse is only the on-screen preview. Thin I/O over the pure handler
// (server/utils/importIngest.ts). See docs/PROCESSING.md §0.

import { createHash } from 'node:crypto'
import { handleImportUpload, type IngestDeps } from '../utils/importIngest'
import { bearerToken } from '../utils/settingsHandler'
import { callRest } from '../utils/b24Rest'
import { getMemberIdByDomain } from '../utils/tokenStore'
import { enqueueParse } from '../queue/producers'
import { dbQuery } from '../db/client'

/** Live wiring: validate the frame token via `profile`, resolve the portal by domain,
 *  enqueue, hash. Built per request (cheap). */
function liveIngestDeps(): IngestDeps {
  return {
    validateFrame: async (domain, accessToken) => {
      // A valid token for THIS portal succeeds; a token from another portal throws
      // (callRest surfaces B24 errors). The result carries the current user id.
      const res = await callRest(domain, accessToken, 'profile', {})
      const id = (res?.result as { ID?: unknown } | undefined)?.ID
      return id != null ? String(id) : ''
    },
    memberIdByDomain: domain => getMemberIdByDomain(dbQuery, domain),
    enqueueParse,
    hash: bytes => createHash('sha256').update(bytes).digest('hex')
  }
}

export default defineEventHandler(async (event) => {
  const token = bearerToken(getHeader(event, 'authorization'))
  const domain = (getHeader(event, 'x-b24-domain') || '').trim()

  const parts = await readMultipartFormData(event).catch(() => null)
  const file = parts?.find(p => p.name === 'file' && p.filename)
  if (!file || !file.filename) {
    setResponseStatus(event, 400)
    return { error: 'multipart field "file" required' }
  }

  const { status, body } = await handleImportUpload(liveIngestDeps(), {
    accessToken: token,
    domain,
    fileName: file.filename,
    bytes: new Uint8Array(file.data)
  })
  setResponseStatus(event, status)
  return body
})
