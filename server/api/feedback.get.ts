import { resolveFeedbackConfig } from '../utils/feedbackConfig'

// GET /api/feedback — whether the feedback channel is enabled, so the UI shows/hides the 👍/👎
// widget. Returns only a boolean (no token, no repo) — nothing sensitive, so no auth needed.
export default defineEventHandler(() => ({ enabled: !!resolveFeedbackConfig() }))
