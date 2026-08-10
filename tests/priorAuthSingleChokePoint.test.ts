import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Architectural guard for #444.
//
// The bank registers ONE client-authentication method per application, so every call to Prior's
// token endpoint must authenticate the same way. The design keeps that honest by funnelling all of
// them through the pure `priorTokenRequest`; the danger is a FIFTH call site added later that
// hand-rolls `Authorization: Basic` again — unit tests of the existing four wouldn't notice, and
// the miss surfaces only as a 401 from the bank.
//
// This scans the server/app sources for hand-built Basic headers and pins the single legitimate
// place. It is the same shape of check as `mdReviewStamp` / `reconScriptsSmoke`: cheap, and it
// fails on the drift no other test can see.

const ROOT = join(import.meta.dirname, '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.nuxt' || entry === '.output') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|mjs|vue)$/.test(entry)) out.push(full)
  }
  return out
}

describe('Prior token-endpoint auth has a single choke point (#444)', () => {
  const files = [...sourceFiles(join(ROOT, 'app')), ...sourceFiles(join(ROOT, 'server'))]

  it('only `buildBasicAuthHeader` builds a Basic credential', () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8')
      // A hand-rolled Basic credential: base64 of "id:secret" or a literal `Basic ` prefix.
      const handRolled = /Buffer\.from\([^)]*:\s*\$\{|toString\(['"]base64['"]\)/.test(src) && /[Bb]asic/.test(src)
      const literalBasic = /['"`]Basic \$\{|['"`]Basic '/.test(src)
      return handRolled || literalBasic
    }).map(f => f.slice(ROOT.length + 1))

    // `buildBasicAuthHeader` (app/utils/priorOauth.ts) is the ONE allowed producer. Anything else
    // means a call site started authenticating on its own — route it through `priorTokenRequest`.
    expect(offenders).toEqual(['app/utils/priorOauth.ts'])
  })

  it('every Prior token-endpoint POST goes through `priorTokenRequest`', () => {
    const callers = files.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return /oauth2\/token|buildPriorRefreshBody|buildCodeExchangeBody|buildClientCredentialsBody/.test(src)
        && !f.endsWith(join('app', 'utils', 'priorOauth.ts')) // the core defines the bodies
    })

    for (const f of callers) {
      const src = readFileSync(f, 'utf8')
      const rel = f.slice(ROOT.length + 1)
      // Type-only re-exports and the Alfa path don't send Prior token requests; require the choke
      // point only where a Prior request body is actually built.
      const buildsPriorBody = /buildPriorRefreshBody|buildCodeExchangeBody|buildClientCredentialsBody/.test(src)
      if (!buildsPriorBody) continue
      expect(src, `${rel} builds a Prior token body but never calls priorTokenRequest`)
        .toContain('priorTokenRequest')
    }
  })
})
