// Чтение `place` из PLACEMENT_OPTIONS (#555).
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

/**
 * `place` из АДРЕСА фрейма — второй штатный источник того же параметра.
 *
 * ⚠ Это не догадка «на всякий случай»: живой прогон показал фрейм слайдера, у которого
 * PLACEMENT_OPTIONS пуст ЦЕЛИКОМ — нет ни `place`, ни `IFRAME` (по последнему SDK определяет
 * `isSliderMode`, и он тоже был false). То есть портал в этом случае не кладёт параметры в
 * init-данные, и читать их оттуда бесполезно. Приложение открывается по СВОЕМУ адресу, поэтому
 * второй возможный носитель — строка запроса.
 *
 * Имя ключа ищем и в нашем виде (`place`), и с префиксом портала (`bx24_place`): префикс — то,
 * как платформа переименовывает служебные параметры окна (`bx24_width`, `bx24_title`).
 */
export function placeFromQuery(search: string): string | undefined {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  } catch {
    return undefined
  }
  for (const [key, value] of params.entries()) {
    const k = key.toLowerCase()
    if (k !== 'place' && k !== 'bx24_place') continue
    const v = value.trim()
    if (v) return v
  }
  return undefined
}
