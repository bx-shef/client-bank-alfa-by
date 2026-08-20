// Чтение `place` из PLACEMENT_OPTIONS (#537).
//
// `openSliderAppPage({ place })` отправляет параметры порталу, портал возвращает их фрейму в
// PLACEMENT_OPTIONS — это штатный путь, и другого способа сказать открывшемуся фрейму «ты
// настройки, а не главный экран» у приложения нет.
//
// ⚠ Форма того, что приходит, НЕ зафиксирована: SDK кладёт `data.PLACEMENT_OPTIONS` как есть
// (`placement.mjs`), а портал по дороге сериализует параметры. Поэтому наивное `options.place`
// молча даёт `undefined`, когда пришла JSON-строка, — и слайдер показывает главный экран, потому
// что вести его оказалось не по чему. Симптом при этом выглядит как «слайдер сломан», хотя
// параметр доехал.
//
// ⚠ Регистр ключа тоже не наш: остальные поля init-данных портал шлёт заглавными
// (`PLACEMENT`, `LANG`, `IS_ADMIN`), поэтому `PLACE` наравне с `place` — не перестраховка.

/** Разобрать PLACEMENT_OPTIONS в объект: он приходит объектом либо JSON-строкой. */
export function parsePlacementOptions(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
}

/** `place`, с которым открыт фрейм, — или undefined. Ключ ищем без учёта регистра. */
export function placeFromOptions(raw: unknown): string | undefined {
  const opts = parsePlacementOptions(raw)
  for (const [key, value] of Object.entries(opts)) {
    if (key.toLowerCase() !== 'place') continue
    const v = typeof value === 'string' ? value.trim() : ''
    return v || undefined
  }
  return undefined
}
