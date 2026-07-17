import { describe, expect, it } from 'vitest'
import { signConnectState, verifyConnectState, type BankConnectState } from '../server/utils/bankConnectState'
import { signSession, verifySession } from '../server/utils/session'

const SECRET = 'test-secret-key'
const now = 1_700_000_000_000
const state: BankConnectState = {
  memberId: 'M1', provider: 'alfa-by', accountKey: 'BY13ALFA', nonce: 'abc123', exp: now + 600_000
}

describe('signConnectState / verifyConnectState', () => {
  it('round-trips a valid state (sign → verify returns the same payload)', () => {
    const signed = signConnectState(state, SECRET)
    expect(signed).toMatch(/^[\w-]+\.[\w-]+$/) // <body>.<sig>
    expect(verifyConnectState(signed, SECRET, now)).toEqual(state)
  })

  it('rejects a tampered body (signature no longer matches)', () => {
    const signed = signConnectState(state, SECRET)
    const [body, sig] = signed.split('.')
    // Flip the payload to another portal but keep the original signature.
    const forgedBody = Buffer.from(JSON.stringify({ ...state, memberId: 'ATTACKER' }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(verifyConnectState(`${forgedBody}.${sig}`, SECRET, now)).toBeNull()
    // Sanity: the untampered value still verifies.
    expect(verifyConnectState(`${body}.${sig}`, SECRET, now)).not.toBeNull()
  })

  it('rejects a state signed with a different secret', () => {
    const signed = signConnectState(state, 'other-secret')
    expect(verifyConnectState(signed, SECRET, now)).toBeNull()
  })

  it('rejects an expired state', () => {
    const signed = signConnectState({ ...state, exp: now - 1 }, SECRET)
    expect(verifyConnectState(signed, SECRET, now)).toBeNull()
    // Still valid one ms before expiry.
    const fresh = signConnectState({ ...state, exp: now + 1 }, SECRET)
    expect(verifyConnectState(fresh, SECRET, now)).not.toBeNull()
  })

  it('rejects malformed / missing values (never throws)', () => {
    expect(verifyConnectState(undefined, SECRET, now)).toBeNull()
    expect(verifyConnectState('', SECRET, now)).toBeNull()
    expect(verifyConnectState('no-dot', SECRET, now)).toBeNull()
    expect(verifyConnectState('.onlysig', SECRET, now)).toBeNull()
    expect(verifyConnectState('notbase64!.sig', SECRET, now)).toBeNull()
  })

  it('rejects a correctly-signed payload missing required fields (field guard, not signature)', () => {
    // Sign a genuinely incomplete state (no memberId) with the REAL secret — the signature is
    // valid, so ONLY the field-shape guard in verify can reject it.
    const incomplete = { provider: 'alfa-by', nonce: 'x', exp: now + 1000 } as unknown as BankConnectState
    const signed = signConnectState(incomplete, SECRET)
    expect(signed).not.toBe('') // it WAS signed (valid HMAC)
    expect(verifyConnectState(signed, SECRET, now)).toBeNull() // …but rejected on the missing memberId
  })

  it('round-trips a state WITHOUT the optional accountKey (banks that fill it only at callback)', () => {
    const { accountKey, ...noKey } = state
    void accountKey
    const back = verifyConnectState(signConnectState(noKey, SECRET), SECRET, now)
    expect(back).toEqual(noKey) // and no `accountKey: undefined` smuggled back in
  })

  it('rejects a state expiring exactly at now (exp <= now boundary, guards the <= vs <)', () => {
    expect(verifyConnectState(signConnectState({ ...state, exp: now }, SECRET), SECRET, now)).toBeNull()
  })

  it('rejects a correctly-signed payload whose exp is not a number (type guard)', () => {
    const badType = { ...state, exp: '9999999999999' } as unknown as BankConnectState
    const signed = signConnectState(badType, SECRET)
    expect(signed).not.toBe('') // validly signed …
    expect(verifyConnectState(signed, SECRET, now)).toBeNull() // … but rejected on exp type
  })

  it('does NOT enum-validate provider (by design — the exchange step picks the client); pin the intent', () => {
    // A future enum-guard here would be a conscious change, not an accident.
    const odd = signConnectState({ ...state, provider: 'zzz' as BankProviderId }, SECRET)
    expect(verifyConnectState(odd, SECRET, now)).not.toBeNull()
  })

  it('domain separation: a connect state does NOT verify as an operator session (same secret)', () => {
    // The headline threat: connect state travels in the authorize URL / Referer / bank logs (not
    // secret). Without domain separation it would verify as a `cba_sess` cookie (verifySession only
    // checks a numeric exp) → operator privilege escalation. The DOMAIN_TAG must block that.
    const signed = signConnectState(state, SECRET)
    expect(verifySession(signed, SECRET, now)).toBeNull() // state → session: rejected
    // …and the reverse: an operator session cookie must not verify as a connect state.
    const cookie = signSession({ sub: 'operator', exp: now + 600_000 }, SECRET)
    expect(verifyConnectState(cookie, SECRET, now)).toBeNull() // session → state: rejected
  })

  it('fail-closed: empty secret → sign returns "" and verify returns null', () => {
    expect(signConnectState(state, '')).toBe('')
    expect(verifyConnectState(signConnectState(state, SECRET), '', now)).toBeNull()
    expect(verifyConnectState('', '', now)).toBeNull()
  })
})
