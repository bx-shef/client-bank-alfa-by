import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Структурные гарды витрины «Последние операции» (#42). Оба утверждения проверяются НЕ поведением,
// а формой кода — потому что оба ломаются молча и в будущем, а не в текущем пути.

const ROOT = join(import.meta.dirname, '..')

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** Все `.ts` под каталогом, рекурсивно. */
function tsFiles(rel: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
    const p = `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...tsFiles(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('период доезжает до реестра только проверенным', () => {
  /**
   * ⚠ `buildRecentOperationsListCall` принимает `DayRange` любого содержания — вся защита живёт в
   * хендлере (`isValidDayRange`). Поэтому второй вызывающий билдера (новый роут, воркер, скрипт)
   * молча отправил бы в `filter` непроверенную строку, и поведенческие тесты этого не заметили бы:
   * они ходят через хендлер, где проверка есть. Отсюда гард по ФОРМЕ, как у
   * `priorResourceHeadersChokePoint` и `paymentListParamsChokePoint`.
   */
  it('билдер списка зовут только оттуда, где период уже проверен', () => {
    const callers = [...tsFiles('server'), ...tsFiles('app')]
      .filter(f => read(f).includes('buildRecentOperationsListCall('))
      .filter(f => !f.endsWith('app/utils/recentOperations.ts')) // сам билдер

    expect(callers).toEqual(['server/api/import/operations.get.ts'])

    // Единственный вызывающий обязан идти через хендлер, который валидирует период.
    const route = read('server/api/import/operations.get.ts')
    expect(route).toContain('handleRecentOperations')
    expect(read('server/utils/recentOperationsHandler.ts')).toContain('isValidDayRange(input.range)')
  })

  /**
   * ⚠ Обрезку («показаны не все») считает СЕРВЕР по СЫРОЙ странице. Соблазн посчитать её на клиенте
   * сравнением `total` с длиной списка велик и выглядит естественно — но маппер отбрасывает
   * элементы без валидной суммы, и один испорченный руками элемент объявлял бы обрезку там, где её
   * нет, с советом «выберите срок короче», который не поможет никогда: строка отброшена маппером, а
   * не страницей. Мутация «вернуть расчёт на клиент» поведенческие тесты пройдёт зелёной.
   */
  it('обрезка считается до маппинга и не пересчитывается на клиенте', () => {
    const route = read('server/api/import/operations.get.ts')
    // Сравниваем с сырой страницей, а не с результатом маппинга.
    expect(route).toMatch(/truncated:\s*total !== null && total > raw\.length/)

    const page = read('app/pages/app.vue')
    const composable = read('app/composables/useRecentOperations.ts')
    // Клиент только ПЕРЕНОСИТ признак, своего вывода не делает.
    expect(composable).toContain('res?.truncated === true')
    for (const src of [page, composable]) {
      expect(src).not.toMatch(/total\.?(value)?\s*[><]\s*.*length/)
    }
  })

  /**
   * ⚠ Признак `?preview=1` на ПРЕРЕНДЕРЕННОЙ странице появляется ПОЗЖЕ монтирования: Nuxt
   * восстанавливает отложенный адрес на `app:suspense:resolve`, то есть после `onMounted` (#555).
   * Снятый один раз применённый период остаётся с НАСТОЯЩИМ днём, и на собранной статике выходит
   * июньский демо-список под августовской подписью — ровно та ложь, ради устранения которой задача
   * заведена, плюс визуальные эталоны, краснеющие каждые сутки.
   *
   * Воспроизвести это в `mountSuspended` нельзя (там маршрут задан сразу и отложенного адреса не
   * возникает), поэтому гард структурный — замерено на `.output/public`.
   */
  it('применённый период пересчитывается, когда признак превью доехал', () => {
    const page = read('app/pages/app.vue')
    expect(page).toMatch(/watch\(previewMode, \(\) => \{\s*appliedRange\.value = pickedRange\.value/)
  })
})
