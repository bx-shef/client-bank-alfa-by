// Куда вести свежий фрейм слайдера, когда `place` из PLACEMENT_OPTIONS не доехал (#537).
//
// Основной признак — `place`: мы сами передаём его в `openSliderAppPage`, портал возвращает его
// в PLACEMENT_OPTIONS, мидлвар по нему уводит фрейм на нужный экран. На живом портале этот путь
// оказался НЕНАДЁЖНЫМ: слайдер открывается, но приходит без нашего `place`, и человек видит в нём
// главный экран вместо настроек — то есть кнопка выглядит сломанной, хотя сработала.
//
// ⚠ Второй признак нужен именно ПОТОМУ, что первый не в нашей власти: между «мы отправили params»
// и «фрейм их получил» стоит портал, чьё поведение мы не контролируем и не можем починить.
//
// Носитель — `sessionStorage`: слайдер открывает НАШ адрес, то есть тот же origin и та же вкладка,
// а значит хранилище у них общее. ⚠ Метка живёт СЕКУНДЫ и снимается при первом же чтении: она
// описывает одно конкретное нажатие кнопки, и «залипнув», увела бы в настройки обычный вход в
// приложение — то есть сломала бы ровно то, что чинит.

/** Ключ метки. Один на приложение: одновременно открывается один слайдер. */
export const SLIDER_INTENT_KEY = 'cba.sliderIntent'

/** Сколько метка считается свежей. Окно покрывает открытие фрейма порталом (сеть + старт Nuxt),
 *  но не переживает возвращение человека к приложению минутой позже. */
export const SLIDER_INTENT_TTL_MS = 20_000

export interface SliderIntent {
  /** `place`, с которым мы просили портал открыть слайдер. */
  place: string
  /** Когда попросили (стенные часы вызывающего). */
  at: number
}

/** Сериализовать намерение для хранилища. */
export function encodeSliderIntent(place: string, nowMs: number): string {
  return JSON.stringify({ place, at: nowMs } satisfies SliderIntent)
}

/**
 * Прочитать намерение, если оно ещё свежее.
 *
 * `null` на всё сомнительное: пусто, не разобралось, чужая форма, метка старше окна или из
 * будущего (переведённые часы). Ошибиться здесь — значит увести в настройки того, кто просто
 * открыл приложение, поэтому любое сомнение трактуем как «намерения не было».
 */
export function decodeSliderIntent(raw: string | null, nowMs: number, ttlMs = SLIDER_INTENT_TTL_MS): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<SliderIntent>
    const place = typeof parsed.place === 'string' ? parsed.place.trim() : ''
    const at = typeof parsed.at === 'number' ? parsed.at : Number.NaN
    if (!place || !Number.isFinite(at)) return null
    if (at > nowMs) return null // часы уехали назад — метке верить нельзя
    return nowMs - at <= ttlMs ? place : null
  } catch {
    return null
  }
}
