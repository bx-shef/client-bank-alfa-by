import { describe, expect, it } from 'vitest'
import { resolveFeedbackConfig } from '../server/utils/feedbackConfig'

describe('resolveFeedbackConfig', () => {
  it('returns null when the token is missing (channel OFF, fail-closed)', () => {
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_REPO: 'org/private' })).toBeNull()
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: '   ', GITHUB_FEEDBACK_REPO: 'org/private' })).toBeNull()
  })

  it('returns null when the repo is missing or malformed (never defaults)', () => {
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: 'tok' })).toBeNull()
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: 'tok', GITHUB_FEEDBACK_REPO: 'no-slash' })).toBeNull()
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: 'tok', GITHUB_FEEDBACK_REPO: 'a/b/c' })).toBeNull()
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: 'tok', GITHUB_FEEDBACK_REPO: 'org/re po' })).toBeNull()
  })

  it('resolves a trimmed token + valid owner/repo', () => {
    expect(resolveFeedbackConfig({ GITHUB_FEEDBACK_TOKEN: '  tok  ', GITHUB_FEEDBACK_REPO: '  bx-shef/cb-feedback  ' }))
      .toEqual({ token: 'tok', repo: 'bx-shef/cb-feedback' })
  })
})
