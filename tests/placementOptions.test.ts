import { describe, expect, it } from 'vitest'
import { parsePlacementOptions, placeFromOptions } from '~/utils/placementOptions'

// Чтение `place` из PLACEMENT_OPTIONS (#537). Форму того, что пришлёт портал, мы не выбираем,
// поэтому читаем ОБЕ известные (объект и JSON-строку) и не привязываемся к регистру ключа.

describe('placeFromOptions', () => {
  it('читает объект', () => {
    expect(placeFromOptions({ place: 'app-options' })).toBe('app-options')
  })

  it('читает JSON-строку — именно на ней наивное `options.place` молча давало undefined', () => {
    expect(placeFromOptions(JSON.stringify({ place: 'app-import' }))).toBe('app-import')
  })

  it('не привязан к регистру ключа: остальные поля init-данных портал шлёт заглавными', () => {
    expect(placeFromOptions({ PLACE: 'app-options' })).toBe('app-options')
  })

  it('обычное открытие приложения не даёт place', () => {
    expect(placeFromOptions(undefined)).toBeUndefined()
    expect(placeFromOptions({})).toBeUndefined()
    expect(placeFromOptions({ place: '   ' })).toBeUndefined()
    expect(placeFromOptions({ IFRAME: 'Y' })).toBeUndefined()
  })

  it('мусор не роняет разбор', () => {
    expect(parsePlacementOptions('{не json')).toEqual({})
    expect(parsePlacementOptions(42)).toEqual({})
    expect(placeFromOptions('[]')).toBeUndefined()
  })
})
