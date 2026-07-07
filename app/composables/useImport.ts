import { frameAuth, frameAuthHeaders, frameFetchError } from '~/composables/useFrameAuth'

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
        return { ok: false, message: frameFetchError(e, `Не удалось отправить «${file.name}»`) }
      }
    }
    const opsWord = pluralOps(opCount)
    return {
      ok: true,
      message: `Принято в обработку: ${accepted} файл(ов), ${opCount} ${opsWord}. Запись в CRM идёт в фоне.`
    }
  }

  return { submitFiles }
}

function pluralOps(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'операция'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'операции'
  return 'операций'
}
