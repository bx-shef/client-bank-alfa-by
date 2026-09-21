// Извлечение позиционированного текста из PDF (#737) — тонкий адаптер над pdf.js.
//
// ⚠ Здесь НЕТ ни одного правила разбора выписки: адаптер отвечает ровно на вопрос «какие обрывки
// текста и где стоят». Раскладку строит `pdfTextLayout.ts`, смысл — парсеры банков. Разделение не
// косметическое: pdf.js в тест не затащить дёшево (он тянет воркер, шрифты и WASM), поэтому всё,
// что можно проверить без него, обязано жить снаружи.
//
// ⚠ Загрузчик ИНЪЕКТИРУЕТСЯ. Кроме тестируемости у этого есть прод-причина: разбор идёт в ДВУХ
// средах — в браузере (предпросмотр на `/import` и демо лендинга) и в воркере на сервере, — а
// сборки pdf.js и способ поднять его воркер там разные. Одного статического импорта, который
// устроил бы обе, не существует.

import type { PdfPage, PdfTextItem } from '~/utils/pdfTextLayout'

/** Минимум контракта pdf.js, который нам нужен, — чтобы не тянуть его типы в чистый слой. */
export interface PdfDocumentLike {
  numPages: number
  getPage: (n: number) => Promise<PdfPageLike>
}

export interface PdfPageLike {
  getViewport: (opts: { scale: number }) => { width: number, height: number }
  getTextContent: () => Promise<{ items: unknown[] }>
}

/** Поднять документ из байтов файла. В проде — динамический импорт pdf.js. */
export type PdfLoader = (data: Uint8Array) => Promise<PdfDocumentLike>

/**
 * Сколько страниц читаем максимум.
 *
 * ⚠ Это DoS-гард той же природы, что `MAX_CLIENT_BANK_CHARS`, и он тут НУЖНЕЕ: размер файла
 * (`MAX_UPLOAD_BYTES`) про число страниц не говорит ничего — сжатый PDF на пару мегабайт
 * разворачивается в тысячи страниц, и разбор каждой стоит процессорного времени в браузере
 * человека и в нашем воркере. Выписка за период в такой потолок укладывается с запасом.
 */
export const MAX_PDF_PAGES = 200

/** Признак PDF в первых байтах файла. */
const PDF_MAGIC = '%PDF-'

/**
 * Это PDF?
 *
 * ⚠ Смотрим В СОДЕРЖИМОЕ, а не на расширение — ровно по тому же правилу, по которому формат
 * выписки выбирается по содержимому, а `.txt`/`.csv` остаются дешёвым фильтром (#707). Человек
 * переименовывает файлы, а цена ошибки здесь — попытка прочитать бинарный PDF как текст, то есть
 * «формат не распознан» вместо понятного разбора.
 */
export function looksLikePdf(buffer: ArrayBuffer | Uint8Array): boolean {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const head = bytes.subarray(0, PDF_MAGIC.length)
  return String.fromCharCode(...head) === PDF_MAGIC
}

/** Обрывок текста, как его отдаёт pdf.js: строка плюс матрица преобразования. */
interface TextItemLike {
  str?: unknown
  transform?: unknown
}

/** Координаты обрывка: `transform[4]`/`transform[5]` — сдвиг, то есть левый нижний угол. */
function toTextItem(raw: unknown): PdfTextItem | null {
  const it = raw as TextItemLike
  if (typeof it?.str !== 'string') return null
  const t = it.transform
  if (!Array.isArray(t) || t.length < 6) return null
  const x = t[4]
  const y = t[5]
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y, text: it.str }
}

/**
 * Прочитать PDF в страницы с позиционированным текстом.
 *
 * ⚠ Обрывок без читаемых координат ОТБРАСЫВАЕТСЯ, а не кладётся в начало страницы: без `x`/`y` он
 * не привязан ни к какой колонке, и вставленный «куда-нибудь» он смещает соседей — сумма уезжает
 * в чужую колонку. Потеря такого обрывка видна человеку (пустое поле), подмена колонки — нет.
 */
export async function extractPdfPages(
  data: Uint8Array,
  load: PdfLoader
): Promise<PdfPage[]> {
  const doc = await load(data)
  const pages: PdfPage[] = []
  const count = Math.min(doc.numPages, MAX_PDF_PAGES)
  for (let n = 1; n <= count; n++) {
    const page = await doc.getPage(n)
    const vp = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    const items: PdfTextItem[] = []
    for (const raw of content.items) {
      const item = toTextItem(raw)
      if (item) items.push(item)
    }
    pages.push({ width: vp.width, height: vp.height, items })
  }
  return pages
}
