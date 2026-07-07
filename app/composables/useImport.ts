import { frameAuth, frameAuthHeaders, frameFetchError } from '~/composables/useFrameAuth'
import { pluralRu } from '~/utils/importStatus'

// Submit manually-uploaded statement files to the backend for async import
// (POST /api/import, one request per file, RAW file — the server re-parses
// authoritatively). Auth = the B24 frame token (Bearer + X-B24-Domain), same model
// as the settings composables. Fire-and-forget: the endpoint returns 202 and the
// worker writes to CRM in the background; we report the operation count the browser
// already computed for the preview. See docs/PROCESSING.md §0.

export interface ImportOutcome {
  ok: boolean
  message: string
}

export function useImport() {
  /** POST each file; `opCount` is the preview's operation count (for the message). */
  async function submitFiles(files: File[], opCount: number): Promise<ImportOutcome> {
    if (!files.length) return { ok: false, message: 'Нет файлов для записи.' }
    const auth = frameAuth()
    if (!auth) {
      return { ok: false, message: 'Запись в CRM доступна только внутри портала Bitrix24.' }
    }
    let accepted = 0
    for (const file of files) {
      const form = new FormData()
      form.append('file', file, file.name)
      try {
        await $fetch('/api/import', { method: 'POST', headers: frameAuthHeaders(auth), body: form })
        accepted++
      } catch (e) {
        // Note already-accepted files so the user knows a retry only resends the rest
        // (crm-sync dedups by account|docId, so a resend is harmless anyway).
        const tail = accepted ? ` (до этого принято: ${accepted})` : ''
        return { ok: false, message: frameFetchError(e, `Не удалось отправить «${file.name}»${tail}`) }
      }
    }
    const opsWord = pluralRu(opCount, ['операция', 'операции', 'операций'])
    return {
      ok: true,
      message: `Принято в обработку: ${accepted} файл(ов), ${opCount} ${opsWord}. Запись в CRM идёт в фоне.`
    }
  }

  return { submitFiles }
}
