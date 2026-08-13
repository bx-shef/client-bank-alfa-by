import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Architectural guard for #461, the same shape as `priorAuthSingleChokePoint` (#444).
//
// The bank REJECTS every Open Banking resource call that is missing `x-fapi-interaction-id`, and
// every WRITE that is missing `x-idempotency-key` — both with `400 BY.NBRB.Header.Missing`, checked
// BEFORE the body is even looked at. That class of bug already shipped twice in a row here, because
// the headers are assembled at four separate call sites in two modules.
//
// `priorResourceHeaders` / `priorWriteHeaders` are the single choke point. Types make a write
// unbuildable without an idempotency key — but types CANNOT stop a call site from bypassing the
// helpers and hand-rolling the headers again, and that is exactly the failure mode. Unit tests of
// the helpers don't see it either: verified by mutation — stripping the headers out of the live
// transports in `priorFetch.ts` / `connect.post.ts` leaves the whole suite green.
//
// So this scans the sources instead: any file that talks to Prior's resource API must obtain its
// headers from the choke point rather than писать their names itself.

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

const CORE = join('app', 'utils', 'priorOauth.ts')

describe('Prior resource headers have a single choke point (#461)', () => {
  const files = [...sourceFiles(join(ROOT, 'app')), ...sourceFiles(join(ROOT, 'server'))]

  it('only the core spells the mandatory header names', () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return /['"`]x-fapi-interaction-id|['"`]x-idempotency-key/.test(src)
    }).map(f => f.slice(ROOT.length + 1))

    // Anything else means a call site started assembling FAPI headers on its own — route it через
    // priorResourceHeaders/priorWriteHeaders instead, or the next forgotten header is a live 400.
    expect(offenders).toEqual([CORE])
  })

  // Pinned rather than inferred, deliberately. «Every file that talks to the resource API must use
  // the helpers» cannot be recognised by regex without false positives (`priorConnectStart.ts`
  // BUILDS the consent URL but delegates the request through an injected transport). Pinning the
  // set fails on the mutation that matters — a transport quietly dropping the helper disappears
  // from this list — and equally on a NEW transport appearing without review.
  const EXPECTED_USERS = [
    join('server', 'api', 'bank', 'connect.post.ts'), // consent, in the connect preamble
    join('server', 'utils', 'priorFetch.ts') // create + list + poll, in the poller
  ].sort()

  it('exactly the known transports use the header helpers', () => {
    const users = files
      .map(f => f.slice(ROOT.length + 1))
      .filter(rel => rel !== CORE)
      .filter(rel => /priorResourceHeaders|priorWriteHeaders/.test(readFileSync(join(ROOT, rel), 'utf8')))
      .sort()

    expect(users).toEqual(EXPECTED_USERS)
  })
})
