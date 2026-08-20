import { B24Frame, Result, initializeB24Frame } from '@bitrix24/b24jssdk'
import { B24_REQUIRED_SCOPES } from '~/config/b24'
import { placeFromOptions, placeFromQuery } from '~/utils/placementOptions'
import { useLogger } from '~/utils/logger'

// Module-level singleton: the SDK keeps one B24Frame per page (the portal opens
// one iframe). Safe under SSG — only ever set on the client, inside the frame.
let $b24: undefined | B24Frame = undefined
const type = ref<'undefined' | 'B24Frame'>('undefined')
// Идущее рукопожатие: параллельные вызовы `init()` ждут его, а не создают второй `B24Frame`.
let inFlight: undefined | Promise<Result> = undefined

export const useB24 = () => {
  function get() {
    return $b24
  }

  /** Returns the live B24Frame or throws — call only after `isInit()` is true. */
  function getOrThrow(): B24Frame {
    if (!$b24) throw new Error('B24Frame is not initialised')
    return $b24
  }

  function set(newValue: B24Frame | undefined): Result {
    if (newValue instanceof B24Frame) {
      if (!$b24) {
        $b24 = newValue
        nextTick(() => {
          type.value = 'B24Frame'
        })
      }
    } else {
      $b24 = undefined
      nextTick(() => {
        type.value = 'undefined'
      })
    }
    return new Result()
  }

  async function init(): Promise<Result> {
    // Already initialised (e.g. the install page's retry button) — don't
    // re-create the SDK singleton, which would leak a second B24Frame.
    if ($b24) return new Result()
    // Инициализация УЖЕ идёт — ждём её, а не запускаем вторую. Проверки `$b24` мало: она
    // защищает только от повторного вызова после завершения. `InPortalGate` (#414) зовёт `init()`
    // из onMounted ребёнка, страница — из своего, то есть пока первый handshake в полёте, второй
    // создавал бы ЛИШНИЙ `B24Frame` со своими postMessage-слушателями, который `set()` затем
    // молча выбрасывал бы, не освобождая.
    if (inFlight) return inFlight
    // The B24 portal sets `window.name = "domain|protocol|appSid"` on the iframe.
    // When it's absent we're standalone — no-op so callers fall back to mock mode.
    // `initializeB24Frame` does its own parsing/handshake; we only gate on presence.
    if (typeof window === 'undefined' || !window.name) return new Result()
    inFlight = (async () => {
      try {
        const b24 = await initializeB24Frame({})
        return set(b24)
      } catch {
        // Thrown when not genuinely inside a portal — swallow, stay standalone.
      }
      return new Result()
    })()
    try {
      return await inFlight
    } finally {
      inFlight = undefined
    }
  }

  function isInit() {
    return type.value !== 'undefined'
  }

  function targetOrigin() {
    return get()?.getTargetOrigin() || '?'
  }

  /** The scopes this app needs, for the install diagnostics panel (not an OAuth
   *  request — grants come from the app registration). See `app/config/b24.ts`. */
  function getRequiredRights(): string[] {
    return [...B24_REQUIRED_SCOPES]
  }

  /** `place`, с которым открыт ЭТОТ фрейм (`openSliderAppPage({ place })` → PLACEMENT_OPTIONS).
   *  У обычно открытой страницы приложения его нет. По нему глобальный мидлвар уводит свежий
   *  фрейм слайдера на нужный маршрут. */
  function placementPlace(): string | undefined {
    // ⚠ Через `placeFromOptions`, а не `options.place` напрямую: портал волен прислать
    // PLACEMENT_OPTIONS JSON-строкой, и тогда наивное чтение молча даёт undefined — слайдер
    // открывается главным экраном, потому что вести его оказалось не по чему (#537).
    // ⚠ ДВА источника, и второй не запасной «на всякий случай»: на живом портале фрейм слайдера
    // пришёл с ПУСТЫМ PLACEMENT_OPTIONS (не было даже `IFRAME`, по которому SDK определяет
    // слайдер). Читать оттуда там нечего, а приложение открывается по своему адресу — значит
    // параметр может приехать строкой запроса.
    return placeFromOptions(get()?.placement?.options)
      ?? (typeof window !== 'undefined' ? placeFromQuery(window.location.search) : undefined)
  }

  /** Открыть СВОЙ вторичный экран настоящим слайдером портала. Возвращает `false`, когда мы вне
   *  фрейма или портал отказал, — вызывающий тогда уходит обычной навигацией, и экран всё равно
   *  открывается.
   *
   *  ⚠ `width` обязателен намеренно: под 640 px (брейкпоинт `sm`) десктопный слайдер молча
   *  получает мобильную вёрстку, поэтому ширина выбирает КЛАСС РАСКЛАДКИ, а не просто размер.
   *  Забытый аргумент не должен принимать это решение за нас. */
  async function openAppSlider(
    place: string,
    opts: { width: number, title?: string }
  ): Promise<boolean> {
    await init()
    const f = get()
    if (!f) return false
    // Первая половина разговора с порталом: ЧТО мы отправили. Вторая — что получил открывшийся
    // фрейм (мидлвар). Только по обеим отличимо «мы не передали» от «портал не донёс» (#537).
    useLogger('slider').info('просим портал открыть слайдер', { place, width: opts.width })
    try {
      await f.slider.openSliderAppPage({
        place,
        bx24_width: opts.width,
        ...(opts.title ? { bx24_title: opts.title } : {})
      })
      return true
    } catch {
      return false
    }
  }

  /** Закрыть слайдер, в котором мы сами открыты. Вне фрейма — тихий no-op. */
  async function closeSlider(): Promise<void> {
    await init()
    try {
      await get()?.parent.closeApplication()
    } catch { /* не во фрейме — закрывать нечего */ }
  }

  return {
    init,
    get,
    getOrThrow,
    set,
    isInit,
    targetOrigin,
    getRequiredRights,
    placementPlace,
    openAppSlider,
    closeSlider
  }
}
