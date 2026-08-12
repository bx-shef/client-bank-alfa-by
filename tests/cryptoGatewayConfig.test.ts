// Guards the crypto gateway's config wiring (#460) — the parts that are pure text and
// therefore testable without Docker, OpenSSL or a bank.
//
// WHY THIS FILE EXISTS. `nginx.conf.template` is rendered by `entrypoint.sh` through
// `envsubst` with an EXPLICIT variable allowlist. That allowlist is a hand-maintained
// copy of the placeholders in the template, and nothing enforces the two stay in sync:
// `envsubst` silently leaves a non-allowlisted `${GW_NEW}` in the output as literal text,
// so the mistake surfaces as `nginx -t` failing at CONTAINER START — on the deploy server,
// during a release — instead of on the pull request. Everything else about the image is
// checked by build gates inside the Dockerfile; this one gap is checkable here, so it is.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '..')
const template = readFileSync(resolve(root, 'deploy/crypto-gateway/nginx.conf.template'), 'utf8')
const entrypoint = readFileSync(resolve(root, 'deploy/crypto-gateway/entrypoint.sh'), 'utf8')

/** Every `${GW_*}` placeholder the template expects envsubst to fill. */
function templatePlaceholders(): Set<string> {
  return new Set(Array.from(template.matchAll(/\$\{(GW_[A-Z0-9_]+)\}/g), m => m[1]!))
}

/** The allowlist actually passed to envsubst — the SHELL-FORMAT argument of that call. */
function envsubstAllowlist(): Set<string> {
  const call = /envsubst\s+'([^']+)'/.exec(entrypoint)
  if (!call) throw new Error('entrypoint.sh: envsubst call with a quoted allowlist not found')
  return new Set(Array.from(call[1]!.matchAll(/\$\{([A-Z0-9_]+)\}/g), m => m[1]!))
}

describe('crypto gateway config wiring', () => {
  it('every template placeholder is in the envsubst allowlist', () => {
    const missing = [...templatePlaceholders()].filter(v => !envsubstAllowlist().has(v)).sort()
    // A miss leaves the literal `${GW_…}` in the rendered config and nginx refuses to start.
    expect(missing).toEqual([])
  })

  it('the envsubst allowlist has no entries the template never uses', () => {
    const unused = [...envsubstAllowlist()].filter(v => !templatePlaceholders().has(v)).sort()
    // Harmless at runtime, but it means a variable was dropped from the template and the
    // operator-facing docs still promise it does something.
    expect(unused).toEqual([])
  })

  it('every substituted variable has a default or is required explicitly', () => {
    // Otherwise `set -u` in entrypoint.sh aborts the container on an unset variable — with
    // a bare "unbound variable" instead of the intended message.
    const declared = new Set([
      ...Array.from(entrypoint.matchAll(/:\s*"\$\{(GW_[A-Z0-9_]+):=/g), m => m[1]!),
      ...Array.from(entrypoint.matchAll(/\[\[ -n "\$\{(GW_[A-Z0-9_]+):-\}" \]\]/g), m => m[1]!)
    ])
    const undeclared = [...templatePlaceholders()].filter(v => !declared.has(v)).sort()
    expect(undeclared).toEqual([])
  })

  it('nginx variables are not accidentally exposed to envsubst', () => {
    // envsubst replaces EVERY listed name. If an nginx runtime variable (`$status`,
    // `$binary_remote_addr`, …) were ever added to the allowlist it would be replaced with
    // an empty string and the log format / rate limiter would silently break.
    const nginxOwned = [...envsubstAllowlist()].filter(v => !v.startsWith('GW_'))
    expect(nginxOwned).toEqual([])
  })

  it('the access log format carries no request path', () => {
    // The account number travels in the URL (/open-banking/v1.0/accounts/<IBAN>/statements).
    // docs/PRIVACY.md — financial identifiers must not be scattered into log aggregation.
    const format = /log_format\s+gw\s+([\s\S]*?);/.exec(template)
    expect(format, 'log_format gw not found').not.toBeNull()
    // Whole names only: $request_method and $request_time are fine (no path in them) and
    // both contain "$request" as a substring, so a plain `toContain` would reject them.
    for (const forbidden of ['request', 'uri', 'args', 'request_uri', 'document_uri']) {
      expect(format![1], `log_format must not carry $${forbidden}`)
        .not.toMatch(new RegExp(`\\$${forbidden}(?![a-z_])`))
    }
  })

  it('upstream TLS verification is on and pinned to a bundle', () => {
    // An encrypted channel to an unverified peer is not the goal — losing any of these
    // three turns the gateway into something that talks to whoever answers on that IP.
    expect(template).toMatch(/proxy_ssl_verify\s+on;/)
    expect(template).toMatch(/proxy_ssl_trusted_certificate\s+\$\{GW_CA_BUNDLE\};/)
    expect(template).toMatch(/proxy_ssl_name\s+\$\{GW_UPSTREAM_HOST\};/)
  })

  it('forward-secret ciphers are offered before key-transport ones', () => {
    // DHT-BIGN is key transport: compromising the bank's long-term key later decrypts
    // recorded sessions. DHE-BIGN is ephemeral. We can only state a preference (the server
    // may enforce its own), but the preference must be this way round.
    const ciphers = /proxy_ssl_ciphers\s+([^;]+);/.exec(template)
    expect(ciphers, 'proxy_ssl_ciphers not found').not.toBeNull()
    const list = ciphers![1]!.split(':')
    const firstDhe = list.findIndex(c => c.startsWith('DHE-BIGN'))
    const firstDht = list.findIndex(c => c.startsWith('DHT-BIGN'))
    expect(firstDhe).toBeGreaterThanOrEqual(0)
    expect(firstDht).toBeGreaterThanOrEqual(0)
    expect(firstDhe).toBeLessThan(firstDht)
  })

  it('only the two used API prefixes are proxied, everything else is refused', () => {
    // The gateway authenticates nobody; the allowlist IS the boundary. A `location /`
    // that proxied instead of refusing would turn it into an open relay to a bank.
    // Comments stripped first — they discuss locations in prose, and directives are what
    // is being asserted. Then split on `location` rather than brace-matching: the bodies
    // contain `${GW_BURST}`, so a `[^}]*` scan stops at the wrong brace.
    const directives = template.replace(/^\s*#.*$/gm, '')
    const blocks = directives.split(/\blocation\s+/).slice(1)
    const proxied = blocks
      .filter(b => /proxy_pass/.test(b.slice(0, b.search(/\blocation\b/) === -1 ? b.length : b.search(/\blocation\b/))))
      .map(b => /^(?:=\s+)?(\S+)/.exec(b)![1]!)
    expect(proxied.sort()).toEqual([
      '/open-banking-authorize/v1.0/oauth2/token',
      '/open-banking/v1.0/'
    ])
    expect(directives).toMatch(/location\s+\/\s*\{[^}]*return 404;/)
  })
})
