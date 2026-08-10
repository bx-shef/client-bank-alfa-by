import { useB24 } from '~/composables/useB24'

// Открыть портальный путь в слайдере Bitrix24 (тот же приём, что у попапа оценки приложения).
//
// Зачем не обычная ссылка: страница живёт в iframe портала, и `<a href>` увёл бы либо сам фрейм
// (пользователь потеряет настройки), либо новую вкладку мимо портала. `slider.openPath` открывает
// сущность поверх портала — пользователь посмотрел и вернулся в то же место.
//
// Вне фрейма (прямой заход) SDK недоступен, поэтому вызывающий оставляет и обычный `href` —
// клик тогда отработает штатно, а мы просто не перехватываем его.

export function usePortalSlider() {
  const b24 = useB24()

  /** Открыт ли мы внутри портала — только там имеет смысл перехватывать клик. */
  function inFrame(): boolean {
    return b24.isInit()
  }

  /**
   * Абсолютный адрес портала для пути (`/crm/type/1046/list/category/0/` →
   * `https://<портал>/crm/type/...`). Вне фрейма — `null`: домена портала мы не знаем, и
   * ОТНОСИТЕЛЬНЫЙ путь браузер отрезолвил бы на наш собственный домен, уводя пользователя в 404
   * (ровно так и вышло на живом прогоне).
   */
  function resolveUrl(path: string): string | null {
    const frame = b24.get()
    if (!frame) return null
    try {
      return frame.slider.getUrl(path).toString()
    } catch {
      return null
    }
  }

  /**
   * Открыть путь портала в слайдере. Возвращает `false`, если открыть не удалось (нет фрейма или
   * устройство не поддерживает слайдер) — тогда вызывающий должен дать браузеру обработать ссылку
   * обычным образом, а не оставлять пользователя ни с чем.
   */
  async function openPath(path: string): Promise<boolean> {
    const frame = b24.get()
    if (!frame) return false
    try {
      const url = frame.slider.getUrl(path)
      await frame.slider.openPath(url)
      return true
    } catch {
      // SDK сам падает на неподдерживаемых устройствах; там сработает штатный переход по ссылке.
      return false
    }
  }

  return { inFrame, resolveUrl, openPath }
}
