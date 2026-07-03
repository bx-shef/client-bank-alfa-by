/**
 * Копирование текста в буфер обмена.
 * Clipboard API (требует HTTPS + жест — оба есть при клике) с fallback на
 * execCommand для старых WebView. Возвращает успех. Общий для визитки.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!import.meta.client) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // переходим к fallback
  }
  try {
    const ta = Object.assign(document.createElement('textarea'), { value: text })
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;'
    document.body.appendChild(ta)
    // finally гарантирует удаление textarea, даже если execCommand бросит.
    try {
      ta.select()
      return document.execCommand('copy')
    } finally {
      ta.remove()
    }
  } catch {
    return false
  }
}
