import { describe, expect, it, vi } from 'vitest'
import { notifyDeletionErrorViaRest } from '../server/utils/deletionErrorNotify'

// Deletion error-chat transport (#109 §9.2): im.message.add to the error chat. DI over a fake call.

describe('notifyDeletionErrorViaRest', () => {
  it('posts to the error dialog with URL_PREVIEW=N and returns the message id', async () => {
    const call = vi.fn(async () => ({ result: 555 }))
    const id = await notifyDeletionErrorViaRest('company', '7', 'chat123', call)
    expect(id).toBe('555')
    const [method, params] = call.mock.calls[0]!
    expect(method).toBe('im.message.add')
    expect((params as Record<string, unknown>).DIALOG_ID).toBe('chat123')
    expect((params as Record<string, unknown>).URL_PREVIEW).toBe('N')
    expect(String((params as Record<string, unknown>).MESSAGE)).toContain('#7')
  })

  it('includes the freed count for a target deletion', async () => {
    const call = vi.fn(async () => ({ result: 1 }))
    await notifyDeletionErrorViaRest('invoice', '39', 'c', call, { freed: 3 })
    expect(String((call.mock.calls[0]![1] as Record<string, unknown>).MESSAGE)).toContain('Освобождено распределений: 3')
  })

  it('propagates a transport error (worker swallows it)', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('im down')
    }
    await expect(notifyDeletionErrorViaRest('company', '7', 'c', vi.fn(boom))).rejects.toThrow(/im down/)
  })
})
