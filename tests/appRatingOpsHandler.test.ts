import { describe, expect, it, vi } from 'vitest'
import { handleAppRatingOp } from '../server/utils/appRatingOpsHandler'

const OK_ID = 'a1b2c3d4e5f6'

function deps() {
  return { markReviewed: vi.fn(async () => {}), reset: vi.fn(async () => {}) }
}

describe('handleAppRatingOp', () => {
  it('rejects a non-hex memberId (before any write)', async () => {
    const d = deps()
    const r = await handleAppRatingOp('../etc', 'reviewed', d)
    expect(r.status).toBe(400)
    expect(d.markReviewed).not.toHaveBeenCalled()
    expect(d.reset).not.toHaveBeenCalled()
  })

  it('rejects an unknown action', async () => {
    const d = deps()
    const r = await handleAppRatingOp(OK_ID, 'delete', d)
    expect(r.status).toBe(400)
    expect(d.markReviewed).not.toHaveBeenCalled()
  })

  it('dispatches reviewed → markReviewed', async () => {
    const d = deps()
    const r = await handleAppRatingOp(OK_ID, 'reviewed', d)
    expect(r).toEqual({ status: 200, body: { ok: true, action: 'reviewed' } })
    expect(d.markReviewed).toHaveBeenCalledWith(OK_ID)
    expect(d.reset).not.toHaveBeenCalled()
  })

  it('dispatches reset → reset', async () => {
    const d = deps()
    const r = await handleAppRatingOp(`  ${OK_ID}  `, 'reset', d)
    expect(r.status).toBe(200)
    expect(d.reset).toHaveBeenCalledWith(OK_ID) // trimmed
    expect(d.markReviewed).not.toHaveBeenCalled()
  })
})
