import { describe, expect, it } from 'vitest'
import { SLIDER_INTENT_TTL_MS, decodeSliderIntent, encodeSliderIntent } from '~/utils/sliderIntent'

// Второй признак «куда вести слайдер», когда `place` от портала не доехал (#537).
// Цена ошибки несимметрична: не прочитать метку — человек увидит главный экран (как сейчас);
// прочитать лишнюю — обычный вход в приложение уедет в настройки. Поэтому все сомнительные
// случаи обязаны давать null.

const NOW = 1_700_000_000_000

describe('sliderIntent', () => {
  it('свежая метка читается', () => {
    expect(decodeSliderIntent(encodeSliderIntent('app-options', NOW), NOW + 1000)).toBe('app-options')
  })

  it('метка старше окна не читается — иначе она увела бы обычный вход в приложение', () => {
    const raw = encodeSliderIntent('app-options', NOW)
    expect(decodeSliderIntent(raw, NOW + SLIDER_INTENT_TTL_MS + 1)).toBeNull()
  })

  it('метка «из будущего» не читается: часам, уехавшим назад, верить нельзя', () => {
    expect(decodeSliderIntent(encodeSliderIntent('app-options', NOW + 60_000), NOW)).toBeNull()
  })

  it('пусто, мусор и чужая форма дают null, а не бросают', () => {
    expect(decodeSliderIntent(null, NOW)).toBeNull()
    expect(decodeSliderIntent('', NOW)).toBeNull()
    expect(decodeSliderIntent('{не json', NOW)).toBeNull()
    expect(decodeSliderIntent(JSON.stringify({ place: '', at: NOW }), NOW)).toBeNull()
    expect(decodeSliderIntent(JSON.stringify({ place: 'app-options' }), NOW)).toBeNull()
    expect(decodeSliderIntent(JSON.stringify({ at: NOW }), NOW)).toBeNull()
  })
})
