import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOKEN_EXCHANGE_TIMEOUT_MS } from '../server/utils/bankConnectCallback'

// Guard for a drift that is invisible in both directions on its own (#482).
//
// The bank callback waits `TOKEN_EXCHANGE_TIMEOUT_MS` for the code→token exchange. That number is
// only real if every proxy in front of it waits longer. The shared backend snippet sets
// `proxy_read_timeout 30s` — sized for the fast routes it was written for — and an exact-match
// location inherits it silently. So raising the constant alone changes NOTHING in production: nginx
// still cuts at 30s, the account holder gets a bare `504` instead of our page, and the backend keeps
// running and may save the token seconds AFTER they were told it failed and went to retry.
//
// Neither half is wrong by itself, and neither file mentions the other, which is exactly why this
// belongs in a test rather than in a comment. Three reviewers found it by reading; nothing would
// have caught it the next time.
//
// ⚠ Not tested here: the SHARED edge proxy (nginx-proxy) in front of this container. Its default is
// nginx's own 60s and this repository does not configure it — hence the upper bound below, which
// keeps our timeout the one that fires.

const ROOT = join(import.meta.dirname, '..')
const NGINX = readFileSync(join(ROOT, 'nginx.conf'), 'utf8')
const SNIPPET = readFileSync(join(ROOT, 'snippets', 'proxy-backend.conf'), 'utf8')

/** Seconds from the `proxy_read_timeout` inside an exact-match location block, or null. */
function locationReadTimeoutSec(path: string): number | null {
  const start = NGINX.indexOf(`location = ${path} {`)
  if (start < 0) return null
  const end = NGINX.indexOf('\n    }', start)
  const block = NGINX.slice(start, end < 0 ? undefined : end)
  return Number(/proxy_read_timeout\s+(\d+)s\s*;/.exec(block)?.[1] ?? '') || null
}

/** The edge proxy is not ours to configure; nginx's compiled-in default is what we must fit under. */
const EDGE_DEFAULT_SEC = 60

describe('таймауты банковских маршрутов согласованы между кодом и nginx (#482)', () => {
  const sharedSec = Number(/proxy_read_timeout\s+(\d+)s\s*;/.exec(SNIPPET)?.[1] ?? '')

  it('общий сниппет действительно короче — иначе переопределение ниже ничего не значит', () => {
    expect(sharedSec).toBeGreaterThan(0)
    expect(sharedSec * 1000).toBeLessThan(TOKEN_EXCHANGE_TIMEOUT_MS)
  })

  it.each(['/api/bank/callback', '/api/bank/connect'])(
    '%s переопределяет общий таймаут и ждёт дольше, чем ждёт наш код',
    (path) => {
      const sec = locationReadTimeoutSec(path)
      expect(sec).not.toBeNull()
      expect(sec!).toBeGreaterThan(sharedSec)
      expect(sec! * 1000).toBeGreaterThan(TOKEN_EXCHANGE_TIMEOUT_MS)
    }
  )

  it('но не длиннее чужого edge-прокси — иначе отказ придёт от сервера, который мы не объясним', () => {
    for (const path of ['/api/bank/callback', '/api/bank/connect']) {
      expect(locationReadTimeoutSec(path)!).toBeLessThanOrEqual(EDGE_DEFAULT_SEC)
    }
    expect(TOKEN_EXCHANGE_TIMEOUT_MS).toBeLessThan(EDGE_DEFAULT_SEC * 1000)
  })
})
