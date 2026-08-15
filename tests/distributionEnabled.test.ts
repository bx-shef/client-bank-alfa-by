import { describe, expect, it } from 'vitest'
import { distributionEnabled } from '../server/utils/distributionEnabled'

// Гейт распределения ВЫКЛЮЧЕН по умолчанию; включает его только явная `1`.
//
// ⚠ Раньше было наоборот, и тесты закрепляли ту сторону. Для стадии разработки, когда порталы были
// только наши, «включено по умолчанию» удобно; для портала клиента — нет: функция СОЗДАЁТ
// смарт-процессы в чужой CRM, а кнопка «Настроить смарт-процессы» висела в настройках у каждого,
// кто нас установил, ничего при этом не объясняя. Выключение было пунктом чек-листа, а пункт
// чек-листа, который надо помнить для каждого стенда, — это дефект, ждущий единственного раза,
// когда его забудут.

describe('distributionEnabled', () => {
  it('ВЫКЛЮЧЕН, когда переменная не задана', () => {
    expect(distributionEnabled({} as NodeJS.ProcessEnv)).toBe(false)
  })

  it('включает только явная «1» — «true»/«yes»/пустая строка не считаются', () => {
    // Фича мутирует чужую CRM: «похоже на включено» тут недостаточно, нужно ровно то значение,
    // которое человек написал осознанно.
    for (const v of ['true', 'yes', 'on', '', '0', 'да']) {
      expect(distributionEnabled({ DISTRIBUTION_PROVISION_ENABLED: v } as unknown as NodeJS.ProcessEnv), v).toBe(false)
    }
    expect(distributionEnabled({ DISTRIBUTION_PROVISION_ENABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })

  it('умолчание совпадает с остальными мутирующими переключателями проекта', () => {
    // `autoDistribute`, `CRON_REAL_POLL`, `MANUAL_POLL_ENABLED` — все opt-in. Функция, меняющая
    // CRM клиента, не должна быть единственным исключением.
    expect(distributionEnabled({} as NodeJS.ProcessEnv)).toBe(false)
  })
})
