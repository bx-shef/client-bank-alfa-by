import { vi } from 'vitest'
import type { B24Frame, Result } from '@bitrix24/b24jssdk'
import type { useB24 } from '~/composables/useB24'

export interface MockB24Options {
  /** Whether a B24 frame is present (default true). `false` = standalone mode. */
  isInit?: () => boolean
  /** Whether the current portal user is an admin (`$b24.auth.isAdmin`, default true). */
  isAdmin?: boolean
  /** Stable spy for `$b24.installFinish()` (so a test can assert it was called). */
  installFinish?: ReturnType<typeof vi.fn>
  /** Stable spy for `$b24.parent.setTitle()`. */
  setTitle?: ReturnType<typeof vi.fn>
  /** Lets a test make `$b24.actions.v2.batch.make()` reject (error/retry path). */
  batchMake?: ReturnType<typeof vi.fn>
  /** Stable spy for `$b24.actions.v2.call.make()` (single REST call, e.g. the
   *  automation-trigger registration on install, #79). */
  callMake?: ReturnType<typeof vi.fn>
  /** Стабильный спай для `$b24.slider.openPath()`. */
  openPath?: ReturnType<typeof vi.fn>
  /** Стабильный спай для `$b24.slider.openSliderAppPage()` — открытие своего экрана слайдером. */
  openSliderAppPage?: ReturnType<typeof vi.fn>
  /** PLACEMENT_OPTIONS фрейма. `{ place: 'app-options' }` = мы сами открыты слайдером настроек. */
  placementOptions?: Record<string, unknown>
  /** Стабильный спай для `openAppSlider()` — чем страница открывает вторичный экран. */
  openAppSlider?: ReturnType<typeof vi.fn>
  /** Стабильный спай для `closeSlider()` — чем вторичный экран закрывает себя. */
  closeSlider?: ReturnType<typeof vi.fn>
  /** Права, которые приложение ЗАПРАШИВАЕТ (`getRequiredRights`). Нужны тесту вердикта установки:
   *  «недовыданное право» вычисляется как запрошенное минус выданное порталом. */
  requiredRights?: string[]
}

/**
 * Typed fake of `useB24()`'s return for component tests, which can't load the
 * real Bitrix24 SDK. The `ReturnType<typeof useB24>` annotation makes TypeScript
 * fail here if the composable's surface changes — so the mock can't drift from
 * the real API silently.
 */
export function makeMockB24(opts: MockB24Options = {}): ReturnType<typeof useB24> {
  const ok = { isSuccess: true } as unknown as Result
  // Minimal B24Frame fake — only what install.vue / the in-portal pages touch.
  const frame = {
    // ⚠ Намеренно БЕЗ `access_token`: `frameAuth()` тогда отдаёт null, и проверка серверной части
    // на установке (#413) выходит до `$fetch`. Добавишь токен — install.nuxt.test.ts начнёт реально
    // ходить в сеть под фейковыми таймерами; тогда сначала замокай `$fetch` в том файле.
    auth: { getAuthData: () => ({ domain: 'example.bitrix24.by' }), isAdmin: opts.isAdmin ?? true },
    parent: { setTitle: opts.setTitle ?? vi.fn(async () => {}), fitWindow: vi.fn(async () => {}) },
    actions: { v2: {
      batch: { make: opts.batchMake ?? vi.fn(async () => ({ getData: () => ({}) })) },
      call: { make: opts.callMake ?? vi.fn(async () => ({ isSuccess: true, getData: () => ({ result: true }), getErrorMessages: () => [] as string[] })) }
    } },
    installFinish: opts.installFinish ?? vi.fn(async () => {}),
    // `getUrl` строит АБСОЛЮТНЫЙ адрес портала — относительный путь резолвился бы на домен
    // приложения и вёл в 404 (живая находка). Мок повторяет это поведение, чтобы тест ловил регресс.
    slider: {
      getUrl: (path = '/') => new URL(path, 'https://example.bitrix24.by'),
      openPath: opts.openPath ?? vi.fn(async () => ({})),
      openSliderAppPage: opts.openSliderAppPage ?? vi.fn(async () => ({}))
    },
    // `place`, с которым портал открыл фрейм. По умолчанию пусто — обычная страница приложения.
    placement: { options: opts.placementOptions ?? {} }
  } as unknown as B24Frame
  const inFrame = () => opts.isInit?.() ?? true
  return {
    init: vi.fn(async () => ok),
    // `get()` обязан следовать за `isInit()`: в реальном `useB24` синглтон и реактивный флаг
    // описывают одно и то же состояние. Мок, возвращающий фрейм «снаружи», делал бы standalone-
    // ветки непроверяемыми — а `InPortalGate` читает именно `get()` (флаг выставляется в nextTick).
    get: () => (inFrame() ? frame : undefined),
    getOrThrow: () => frame,
    placementPlace: () => {
      const p = (opts.placementOptions ?? {}).place
      return typeof p === 'string' && p ? p : undefined
    },
    openAppSlider: (opts.openAppSlider ?? vi.fn(async () => true)) as unknown as ReturnType<typeof useB24>['openAppSlider'],
    closeSlider: (opts.closeSlider ?? vi.fn(async () => {})) as unknown as ReturnType<typeof useB24>['closeSlider'],
    set: () => ok,
    isInit: inFrame,
    targetOrigin: () => 'https://example.bitrix24.by',
    // Пусто по умолчанию (большинству тестов права не важны). Тест вердикта установки ЗАДАЁТ их
    // явно: с пустым списком «недовыданных прав» не бывает, и degraded-ветка не проверялась бы.
    getRequiredRights: () => opts.requiredRights ?? []
  }
}
