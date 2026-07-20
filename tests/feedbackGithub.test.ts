import { describe, expect, it, vi } from 'vitest'
import { postFeedbackIssue, type FeedbackFetchFn } from '../server/utils/feedbackGithub'

const config = { token: 'secret-tok', repo: 'bx-shef/cb-feedback' }
const payload = { title: 't', body: 'b', labels: ['user-feedback', 'feedback:up'] }

function fakeFetch(status: number, json: unknown = {}): { fn: FeedbackFetchFn, calls: Array<{ url: string, init: { method: string, headers: Record<string, string>, body: string } }> } {
  const calls: Array<{ url: string, init: { method: string, headers: Record<string, string>, body: string } }> = []
  const fn: FeedbackFetchFn = async (url, init) => {
    calls.push({ url, init })
    return { status, json: async () => json }
  }
  return { fn, calls }
}

describe('postFeedbackIssue', () => {
  it('POSTs to the repo issues endpoint with auth + JSON body', async () => {
    const { fn, calls } = fakeFetch(201, { number: 7 })
    const r = await postFeedbackIssue(config, payload, fn)
    expect(r).toEqual({ ok: true, status: 201, retryable: false, number: 7 })
    expect(calls[0]!.url).toBe('https://api.github.com/repos/bx-shef/cb-feedback/issues')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer secret-tok')
    expect(JSON.parse(calls[0]!.init.body)).toEqual(payload)
  })

  it('success without a numeric issue number still reports ok', async () => {
    const { fn } = fakeFetch(201, {})
    const r = await postFeedbackIssue(config, payload, fn)
    expect(r.ok).toBe(true)
    expect(r.number).toBeUndefined()
  })

  it('5xx / 429 are retryable; 4xx are not', async () => {
    expect((await postFeedbackIssue(config, payload, fakeFetch(503).fn)).retryable).toBe(true)
    expect((await postFeedbackIssue(config, payload, fakeFetch(429).fn)).retryable).toBe(true)
    const notFound = await postFeedbackIssue(config, payload, fakeFetch(404).fn)
    expect(notFound).toMatchObject({ ok: false, status: 404, retryable: false })
    expect((await postFeedbackIssue(config, payload, fakeFetch(422).fn)).retryable).toBe(false)
  })

  it('a network throw → status 0, retryable', async () => {
    const fn: FeedbackFetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const r = await postFeedbackIssue(config, payload, fn)
    expect(r).toEqual({ ok: false, status: 0, retryable: true })
  })
})
