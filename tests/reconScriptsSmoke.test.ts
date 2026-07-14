import { Buffer } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Guard the recon scripts' WIRING (issue #103): the unit tests
// (tests/{alfa,prior}Oauth.test.ts) cover the pure OAuth builders, but NOT the
// glue that binds `cfg.*` into those cores. A typo'd cfg field or a renamed core
// export passes the unit tests and only breaks on a manual `--url-only` run.
//
// The scripts can't be import()-ed in-process (top-level parseArgs/die→process.exit
// would kill the Vitest worker), so we SPAWN each fully offline (network-free,
// secret-free) and assert a valid authorize URL + exit 0. A renamed export or a
// broken cfg binding then fails this CI check.
//
// HERMETIC: every cfg input that flows into the URL/claims is pinned via flags/spawn
// env (so a dev's local `.env.{alfabankby,priorbank}` can't change the output — file
// values never override an already-set env/flag), and we assert each pinned value
// appears where its cfg binding routes it. That turns "no crash" into "the specific
// cfg→core wiring produced the right value", closing the false-negative where a
// mis-bound field still yields a syntactically valid URL.

const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
const REPO_ROOT = process.cwd()

/** Spawn a script offline and return { status, out } (stdout+stderr merged). */
function runScript(scriptRelPath: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync('node', [...NODE_FLAGS, scriptRelPath, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000
  })
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

// A throwaway RSA key for the Prior authorize `request` JWT signing (no secrets).
const keyPath = join(tmpdir(), `prior-smoke-${randomUUID()}.pem`)
beforeAll(() => {
  writeFileSync(keyPath, generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)
})
afterAll(() => rmSync(keyPath, { force: true }))

describe('recon scripts — offline --url-only smoke (#103)', () => {
  it('alfa-oauth-test builds a valid authorize URL from cfg bindings and exits 0', () => {
    // Pin every URL input so the assertions are hermetic (immune to a local .env).
    const { status, out } = runScript('scripts/alfa-oauth-test.mjs', [
      '--url-only', '--client-id', 'c', '--base', 'https://alfa.example',
      '--redirect-uri', 'https://rd.example', '--scope', 'accounts', '--state', 'st123'
    ])
    expect(status).toBe(0)
    const url = out.match(/https:\/\/\S*authorize\?response_type=code\S*/)?.[0] ?? ''
    expect(url).toBeTruthy()
    // Each cfg.* field must reach its URL param (a mis-bound field would drop/undefine it).
    expect(url).toContain('client_id=c')
    expect(url).toContain('scope=accounts')
    expect(url).toContain('redirect_uri=https%3A%2F%2Frd.example')
    expect(url).toContain('state=st123')
    expect(url.startsWith('https://alfa.example/authorize?response_type=code')).toBe(true)
    expect(url).not.toContain('undefined') // no cfg field silently resolved to undefined
  }, 30_000)

  it('prior-oauth-test builds a signed authorize request with the right claims and exits 0', () => {
    const { status, out } = runScript(
      'scripts/prior-oauth-test.mjs',
      ['--url-only', '--consent', 'x', '--client-id', 'c', '--redirect-uri', 'https://rd.example'],
      { PRIOR_CLIENT_ID: 'c', PRIOR_CLIENT_SECRET: 's', PRIOR_PRIVATE_KEY: keyPath, PRIOR_BASE: 'https://prior.example' }
    )
    expect(status).toBe(0)
    const url = out.match(/https:\/\/\S*oauth2\/authorize\?response_type=code\S*/)?.[0] ?? ''
    expect(url).toBeTruthy()
    expect(url).toContain('client_id=c')
    // Decode the signed `request` JWT payload — a broken cfg→claims binding would still
    // sign SOME object, so proving the JWT exists isn't enough; assert the actual claims.
    const jwt = url.match(/request=([\w-]+)\.([\w-]+)\.([\w-]+)/)
    expect(jwt).toBeTruthy()
    const claims = JSON.parse(Buffer.from(jwt![2]!, 'base64url').toString('utf8'))
    expect(claims.client_id).toBe('c') // cfg.clientId → claims
    expect(claims.redirect_uri).toBe('https://rd.example') // cfg.redirectUri → claims
    // the --consent intent id flows into the essential openbanking_intent_id claim
    expect(claims.claims?.userinfo?.openbanking_intent_id?.value).toBe('x')
  }, 30_000)
})
