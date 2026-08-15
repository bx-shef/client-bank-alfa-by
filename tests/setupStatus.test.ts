import { describe, expect, it } from 'vitest'
import { handleSetupStatus, type SetupStatusDeps } from '../server/utils/setupStatus'

// Server half of the setup checklist (#409/#405). Same gate as the bank routes — the answer
// describes the portal's configuration posture, which is admin business.

function deps(over: Partial<SetupStatusDeps> = {}): SetupStatusDeps {
  return {
    memberIdByDomain: async () => 'M1',
    validateFrame: async () => ({ userId: '7', isAdmin: true }),
    countAccounts: async () => ({ connected: 2, pending: 0 }),
    pollEnabled: true,
    pollIntervalMin: 5,
    lastRunMs: async () => 1_700_000_000_000,
    ...over
  }
}

const input = { accessToken: 't', domain: 'p.bitrix24.by' }

describe('handleSetupStatus', () => {
  it('returns only what the browser cannot know', async () => {
    const res = await handleSetupStatus(deps(), input)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      connectedAccounts: 2,
      pendingAccounts: 0,
      // Сколько подключений приложение уже считает нерабочими (#504) — браузер этого знать не
      // может, а без этого «Банк подключён» горит зелёным на сломанном подключении.
      unhealthyAccounts: 0,
      pollEnabled: true,
      pollIntervalMin: 5,
      lastRunMs: 1_700_000_000_000
    })
    // Portal settings stay with the client — a server copy could disagree with the open form.
    expect(JSON.stringify(res.body)).not.toContain('dialogId')
  })

  it('reports a never-polled portal as lastRunMs: null rather than inventing a time', async () => {
    const res = await handleSetupStatus(deps({ lastRunMs: async () => null }), input)
    expect(res.body.lastRunMs).toBeNull()
  })

  it('reports the poll gate honestly when it is off', async () => {
    const res = await handleSetupStatus(deps({ pollEnabled: false }), input)
    expect(res.body.pollEnabled).toBe(false)
  })

  it('отдаёт счётчик незавершённых подключений отдельно (#407)', () => {
    // Считать их «подключёнными счетами» нельзя (с них ничего не забрать), молчать о них — тоже.
    return handleSetupStatus(deps({ countAccounts: async () => ({ connected: 1, pending: 2 }) }), input)
      .then((res) => {
        expect(res.body.connectedAccounts).toBe(1)
        expect(res.body.pendingAccounts).toBe(2)
      })
  })

  it('is 400 without frame auth, 409 for an unknown portal', async () => {
    expect((await handleSetupStatus(deps(), { accessToken: '', domain: '' })).status).toBe(400)
    expect((await handleSetupStatus(deps({ memberIdByDomain: async () => null }), input)).status).toBe(409)
  })

  it('is 403 on a token that is not this portal (domain spoofing)', async () => {
    const d = deps({
      validateFrame: async () => {
        throw new Error('nope')
      }
    })
    expect((await handleSetupStatus(d, input)).status).toBe(403)
  })

  it('is 403 for a non-admin — and reads nothing', async () => {
    let read = false
    const d = deps({
      validateFrame: async () => ({ userId: '9', isAdmin: false }),
      countAccounts: async () => {
        read = true
        return { connected: 1, pending: 0 }
      }
    })
    expect((await handleSetupStatus(d, input)).status).toBe(403)
    expect(read).toBe(false)
  })
})
