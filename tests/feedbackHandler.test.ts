import { describe, expect, it, vi } from 'vitest'
import { handleFeedbackSubmit, type FeedbackSubmitDeps } from '../server/utils/feedbackHandler'
import type { PostIssueResult } from '../server/utils/feedbackGithub'

const okPost: PostIssueResult = { ok: true, status: 201, retryable: false, number: 5 }

function deps(over: Partial<FeedbackSubmitDeps> = {}): FeedbackSubmitDeps {
  return {
    config: { token: 'tok', repo: 'org/private' },
    memberIdByDomain: async () => 'M',
    validateFrame: async () => 'user-7',
    postIssue: vi.fn(async () => okPost),
    ...over
  }
}

const IN = { accessToken: 'tok', domain: 'x.bitrix24.by', kind: 'up', comment: 'ok' }

describe('handleFeedbackSubmit', () => {
  it('503 when the channel is not configured (before any auth work)', async () => {
    const d = deps({ config: null })
    const r = await handleFeedbackSubmit(d, IN)
    expect(r.status).toBe(503)
    expect(d.memberIdByDomain).toBeDefined()
    expect(d.postIssue).not.toHaveBeenCalled()
  })

  it('401 without token/domain', async () => {
    expect((await handleFeedbackSubmit(deps(), { ...IN, accessToken: '' })).status).toBe(401)
    expect((await handleFeedbackSubmit(deps(), { ...IN, domain: '' })).status).toBe(401)
  })

  it('400 on an unknown kind (before REST/DB)', async () => {
    const d = deps()
    const r = await handleFeedbackSubmit(d, { ...IN, kind: 'meh' })
    expect(r.status).toBe(400)
    expect(d.postIssue).not.toHaveBeenCalled()
  })

  it('409 when the portal is not installed', async () => {
    const r = await handleFeedbackSubmit(deps({ memberIdByDomain: async () => null }), IN)
    expect(r.status).toBe(409)
  })

  it('403 on an invalid / foreign frame token (throws or empty)', async () => {
    const boom = async (): Promise<string> => {
      throw new Error('bad')
    }
    expect((await handleFeedbackSubmit(deps({ validateFrame: boom }), IN)).status).toBe(403)
    expect((await handleFeedbackSubmit(deps({ validateFrame: async () => '' }), IN)).status).toBe(403)
  })

  it('200 { ok, number } on a filed issue', async () => {
    const d = deps()
    const r = await handleFeedbackSubmit(d, IN)
    expect(r).toEqual({ status: 200, body: { ok: true, number: 5 } })
    expect(d.postIssue).toHaveBeenCalledWith('up', 'ok', {})
  })

  it('502 when the GitHub transport is retryable, 500 otherwise', async () => {
    const retry = await handleFeedbackSubmit(deps({ postIssue: async () => ({ ok: false, status: 503, retryable: true }) }), IN)
    expect(retry.status).toBe(502)
    const hard = await handleFeedbackSubmit(deps({ postIssue: async () => ({ ok: false, status: 422, retryable: false }) }), IN)
    expect(hard.status).toBe(500)
  })

  it('passes the context through to postIssue', async () => {
    const d = deps()
    await handleFeedbackSubmit(d, { ...IN, context: { fileName: 'вписка.txt' } })
    expect(d.postIssue).toHaveBeenCalledWith('up', 'ok', { fileName: 'вписка.txt' })
  })
})
