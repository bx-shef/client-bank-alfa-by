import { describe, expect, it } from 'vitest'
import { useImportStatus } from '~/composables/useImportStatus'

// Демо-мок статуса удалён (#415): вне портала нет фрейм-токена, а выдуманные цифры на месте
// реального импорта — худший из возможных ответов (выглядят как работающий импорт).

describe('useImportStatus', () => {
  it('без фрейм-токена остаётся пустым, а НЕ показывает выдуманный успешный прогон', async () => {
    const { status, refresh } = useImportStatus()
    expect(status.value.state).toBe('never')

    await refresh()

    expect(status.value.state).toBe('never')
    expect(status.value.operations).toBe(0)
    expect(status.value.lastSyncAt).toBeNull()
  })
})
