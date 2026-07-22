import { describe, expect, it, vi } from 'vitest'
import { handleFeedbackPostJob, type FeedbackPostJobDeps } from '../server/utils/feedbackPostJob'
import type { FeedbackPostJob } from '../server/queue/topology'
import type { PostIssueResult } from '../server/utils/feedbackGithub'

const job: FeedbackPostJob = {
  memberId: 'M',
  kind: 'down',
  payload: { title: 't', body: 'b', labels: ['user-feedback', 'feedback:down'] },
  contentHash: 'h'
}

function deps(post: PostIssueResult, over: Partial<FeedbackPostJobDeps> = {}): FeedbackPostJobDeps {
  return { postIssue: vi.fn(async () => post), recordMetric: vi.fn(async () => {}), ...over }
}

describe('handleFeedbackPostJob (durable outbox worker)', () => {
  it('on success: records the metric and acks (resolves)', async () => {
    const d = deps({ ok: true, status: 201, retryable: false, number: 9 })
    await expect(handleFeedbackPostJob(job, d)).resolves.toBeUndefined()
    expect(d.postIssue).toHaveBeenCalledWith(job.payload)
    expect(d.recordMetric).toHaveBeenCalledWith('M', 'down')
  })

  it('a throwing recordMetric does not fail an already-created issue', async () => {
    const failingMetric = async (): Promise<void> => {
      throw new Error('db')
    }
    const d = deps({ ok: true, status: 201, retryable: false }, { recordMetric: failingMetric })
    await expect(handleFeedbackPostJob(job, d)).resolves.toBeUndefined()
  })

  it('transient failure THROWS so BullMQ retries (no metric)', async () => {
    const d = deps({ ok: false, status: 503, retryable: true })
    await expect(handleFeedbackPostJob(job, d)).rejects.toThrow(/503/)
    expect(d.recordMetric).not.toHaveBeenCalled()
  })

  it('permanent 4xx failure acks (dropped, no retry, no metric)', async () => {
    const d = deps({ ok: false, status: 422, retryable: false })
    await expect(handleFeedbackPostJob(job, d)).resolves.toBeUndefined()
    expect(d.recordMetric).not.toHaveBeenCalled()
  })

  it('the error message carries only the numeric status (no GitHub body/URL/token)', async () => {
    const d = deps({ ok: false, status: 500, retryable: true })
    await expect(handleFeedbackPostJob(job, d)).rejects.toThrow('feedback issue post failed (status 500) — retry')
  })
})
