import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_METRIKA_ID } from '~/utils/metrika'

// Цели Метрики и локальный режим — на значениях конфига В ТОЙ ФОРМЕ, в какой их отдаёт сборка.
//
// ⚠ Оба дефекта жили именно в форме значения, поэтому подменять здесь `useLocalMode` целиком, как
// делает гейт промо (`localModeGate`), нельзя: тест прошёл бы при мёртвом флаге. Замерено на
// сборке 2026-09-27:
// - пустая переменная сборки приходит пустой строкой и перекрывает умолчание конфига — на проде
//   `metrikaId:""`, и с #701 не ушла ни одна цель при работающем счётчике;
// - `NUXT_PUBLIC_LOCAL_MODE=1` приходит через `destr` ЧИСЛОМ — `localMode:1`, и флаг не делал на
//   клоне ничего.

type WithYm = Window & { ym?: (...args: unknown[]) => void }

const pub = () => useRuntimeConfig().public as Record<string, unknown>
let saved: Record<string, unknown> = {}

function setConfig(values: Record<string, unknown>) {
  const p = pub()
  saved = { metrikaId: p.metrikaId, localMode: p.localMode }
  Object.assign(p, values)
}

afterEach(() => {
  Object.assign(pub(), saved)
  delete (window as WithYm).ym
})

describe('цели Метрики и локальный режим на значениях из сборки', () => {
  it('пустой metrikaId (так его отдаёт сборка на проде) — цель уходит на наш счётчик', () => {
    setConfig({ metrikaId: '', localMode: '' })
    const ym = vi.fn()
    ;(window as WithYm).ym = ym
    useMetrikaGoal().reachGoal('brief_submit')
    expect(ym).toHaveBeenCalledWith(Number(DEFAULT_METRIKA_ID), 'reachGoal', 'brief_submit')
  })

  it('localMode = 1 числом (NUXT_PUBLIC_LOCAL_MODE=1 после destr) — локальный режим включён', () => {
    setConfig({ metrikaId: '', localMode: 1 })
    expect(useLocalMode()).toBe(true)
    const ym = vi.fn()
    ;(window as WithYm).ym = ym
    useMetrikaGoal().reachGoal('brief_submit')
    expect(ym).not.toHaveBeenCalled()
  })

  it('заданный id числом из destr — цель уходит на него', () => {
    setConfig({ metrikaId: 12345, localMode: '' })
    const ym = vi.fn()
    ;(window as WithYm).ym = ym
    useMetrikaGoal().reachGoal('x')
    expect(ym).toHaveBeenCalledWith(12345, 'reachGoal', 'x')
  })
})
