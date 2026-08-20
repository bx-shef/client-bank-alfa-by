import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Демо-набор операций на `/app` попадает и в коммитимые визуальные эталоны, и в публичный
// JS-чанк лендинг-хоста — то есть публикуется, независимо от гейта `?preview=1` (тот управляет
// рендером, а не доставкой файла). Один раз он уже приезжал туда реальной выпиской.
//
// ⚠ Проверка СТРУКТУРНАЯ, по исходнику: массив не экспортируется, а важна именно форма данных
// в файле — то, что увидит ревьюер и что уедет в бандл.
//
// ⚠ Инцидент, ради которого тест написан, был ВТОРЫМ заходом: в первый раз заменили только
// идентификаторы, а суммы, даты и номера договоров остались от живой выписки — контрагент
// опознавался по «акт + дата + сумма» без единого имени. Поэтому идентификаторов мало, и
// «похоже на синтетику» на глаз — не критерий.

const SOURCE = readFileSync(new URL('../app/pages/app.vue', import.meta.url), 'utf8')

function previewBlock(): string {
  const start = SOURCE.indexOf('const PREVIEW_ITEMS')
  const end = SOURCE.indexOf('const route = useRoute()')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return SOURCE.slice(start, end)
}

describe('демо-набор операций на /app', () => {
  it('счета только демонстрационные', () => {
    const block = previewBlock()
    const accounts = [...block.matchAll(/account: '([^']+)'/g)].map(m => m[1]!)
    expect(accounts.length).toBeGreaterThan(0)
    for (const acc of accounts) {
      // Настоящий белорусский счёт несёт BIC банка (ALFA/PJCB/AKBB…); демонстрационный — DEMO.
      expect(acc).toMatch(/^BY\d{2}DEMO\d+$/)
    }
  })

  it('УНП только из демонстрационного диапазона', () => {
    const unps = [...previewBlock().matchAll(/unp: '([^']+)'/g)].map(m => m[1]!)
    expect(unps.length).toBeGreaterThan(0)
    for (const unp of unps) expect(unp).toMatch(/^19000000\d$/)
  })

  it('в назначениях нет персональных данных', () => {
    const purposes = [...previewBlock().matchAll(/purpose: '([^']*)'/g)].map(m => m[1]!)
    expect(purposes.length).toBeGreaterThan(0)
    for (const p of purposes) {
      // Паспорт в назначении — то, что уже однажды уехало в публичный репозиторий.
      expect(p).not.toMatch(/ПАСПОРТ/i)
      // Чужой счёт, вписанный в текст назначения, мимо поля `account`.
      expect(p).not.toMatch(/BY\d{2}(?!DEMO)[A-Z]{4}/)
    }
  })

  it('БИК только демонстрационный', () => {
    const bics = [...previewBlock().matchAll(/bic: '([^']+)'/g)].map(m => m[1]!)
    expect(bics.length).toBeGreaterThan(0)
    for (const bic of bics) expect(bic).toBe('DEMOBY2X')
  })
})
