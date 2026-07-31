import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// `otel-preload-package.json` обещает в своём же description «EXACT versions, kept equal to the
// resolved pnpm-lock.yaml» — но до этого теста обещание держалось на честном слове и молча
// разъехалось (preload пинил 0.62.2/0.205.0, lock резолвил 0.78.0/0.220.0). Backend-образ ставит
// этот файл через `npm install` БЕЗ lock-файла, то есть дрейф означает: в проде работает другой,
// не проверенный CI набор OTel. Dependabot файл с нестандартным именем не сканирует — без теста
// версии гнили бы бесконечно.

const root = fileURLToPath(new URL('..', import.meta.url))
const preload = JSON.parse(readFileSync(`${root}/otel-preload-package.json`, 'utf8')) as {
  dependencies: Record<string, string>
}
const lock = readFileSync(`${root}/pnpm-lock.yaml`, 'utf8')

describe('otel-preload-package.json ↔ pnpm-lock.yaml', () => {
  it('каждый пин preload-файла существует в lock ровно этой версией', () => {
    const drifted: string[] = []
    for (const [name, version] of Object.entries(preload.dependencies)) {
      // Точный пин обязателен: caret вернул бы невоспроизводимый слой образа.
      expect(version, `${name} должен быть точной версией, не диапазоном`).toMatch(/^\d+\.\d+\.\d+$/)
      if (!lock.includes(`'${name}@${version}'`)) drifted.push(`${name}@${version}`)
    }
    // Сообщение подсказывает механическую починку — то, что и было сделано при первом дрейфе.
    expect(drifted, `Пины разошлись с pnpm-lock.yaml: ${drifted.join(', ')}. `
    + 'Обновите otel-preload-package.json до версий, которые резолвит lock '
    + '(grep "@opentelemetry/<имя>@" pnpm-lock.yaml).').toEqual([])
  })
})
