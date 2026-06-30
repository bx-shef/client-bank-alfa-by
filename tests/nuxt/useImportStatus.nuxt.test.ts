import { describe, expect, it } from 'vitest'
import { useImportStatus } from '~/composables/useImportStatus'
import { MOCK_STATEMENT } from '~/utils/mockStatement'

describe('useImportStatus', () => {
  it('starts "never", then becomes "ok" with statement-derived counts after refresh', async () => {
    const { status, refresh } = useImportStatus()
    expect(status.value.state).toBe('never')
    expect(status.value.lastSyncAt).toBeNull()

    await refresh()

    expect(status.value.state).toBe('ok')
    expect(status.value.operations).toBe(MOCK_STATEMENT.items.length)
    const credits = MOCK_STATEMENT.items.filter(i => i.direction === 'credit').length
    expect(status.value.chatNotified).toBe(credits)
    expect(status.value.lastSyncAt).not.toBeNull()
  })
})
