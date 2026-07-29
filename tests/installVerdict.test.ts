import { describe, expect, it } from 'vitest'
import { installVerdict, mapProbeStatus } from '~/utils/installVerdict'

// Вердикт установки (#410). Смысл модели — развести «установилось» и «работает»: раньше портал с
// недовыданными правами показывал «Готово», а проблема лежала в свёрнутой диагностике мелкими
// бейджами. Поэтому тесты проверяют не формулировки вообще, а что degraded не выдаётся за ok и что
// у каждой проблемы есть действие.

const base = { finished: true, missingScopes: [] as string[], trigger: 'ok' }

describe('installVerdict', () => {
  it('всё выдано → ok без единой проблемы', () => {
    const v = installVerdict(base)
    expect(v.level).toBe('ok')
    expect(v.issues).toEqual([])
  })

  it('не дошли до installFinish → failed, а не «установлено»', () => {
    const v = installVerdict({ ...base, finished: false })
    expect(v.level).toBe('failed')
    expect(v.issues).toHaveLength(1)
  })

  it('недовыданные права → degraded с перечислением и требованием переустановки', () => {
    const v = installVerdict({ ...base, missingScopes: ['userfieldconfig', 'sale'] })
    expect(v.level).toBe('degraded')
    expect(v.issues[0]!.title).toContain('userfieldconfig')
    expect(v.issues[0]!.title).toContain('sale')
    // Права выдаются только при согласии на установку — из настроек это не чинится.
    expect(v.issues[0]!.action).toContain('Переустановите')
  })

  it('провалившийся триггер → degraded, но честно сказано, что остальное работает', () => {
    const v = installVerdict({ ...base, trigger: 'ERROR_METHOD_NOT_FOUND' })
    expect(v.level).toBe('degraded')
    expect(v.issues[0]!.action).toContain('Остальное')
  })

  it('триггер не пытались регистрировать (пустая строка) — это не проблема', () => {
    expect(installVerdict({ ...base, trigger: '' }).level).toBe('ok')
  })

  it('две беды сразу перечисляются обе, а не только первая', () => {
    const v = installVerdict({ finished: true, missingScopes: ['im'], trigger: 'boom' })
    expect(v.level).toBe('degraded')
    expect(v.issues).toHaveLength(2)
  })

  it('провал установки перекрывает всё остальное — сначала установиться', () => {
    const v = installVerdict({ finished: false, missingScopes: ['im'], trigger: 'boom' })
    expect(v.level).toBe('failed')
    expect(v.issues).toHaveLength(1)
  })

  it('backend не подтвердил установку → degraded, но БЕЗ приказа переустановить (#413)', () => {
    // Событие установки идёт мимо iframe, поэтому «портал установлен» ничего не говорит о том,
    // получила ли его серверная часть. При этом запись делает фоновый воркер после сетевой
    // проверки, так что задержка — норма: приказ переустановить на здоровой установке был бы
    // хуже молчания.
    const v = installVerdict({ ...base, backend: 'portal-missing' })
    expect(v.level).toBe('degraded')
    expect(v.issues[0]!.title).toContain('пока не подтвердила')
    expect(v.issues[0]!.action).not.toContain('Переустановите')
    expect(v.issues[0]!.action).toContain('Обновите')
  })

  it('backend недоступен → degraded, и сказано, что это не настройки портала', () => {
    const v = installVerdict({ ...base, backend: 'down' })
    expect(v.level).toBe('degraded')
    expect(v.issues[0]!.action).toContain('владельца приложения')
  })

  it('backend увиден или проверить не удалось → молчим, а не пугаем', () => {
    expect(installVerdict({ ...base, backend: 'ok' }).level).toBe('ok')
    expect(installVerdict({ ...base, backend: 'unknown' }).level).toBe('ok')
    expect(installVerdict(base).level).toBe('ok') // поле вообще не задано
  })

  it('у каждой проблемы есть действие — иначе сообщение бесполезно', () => {
    for (const outcome of [
      { finished: false, missingScopes: [], trigger: 'ok' },
      { finished: true, missingScopes: ['crm'], trigger: 'ok' },
      { finished: true, missingScopes: [], trigger: 'err' }
    ]) {
      for (const issue of installVerdict(outcome).issues) {
        expect(issue.action.length).toBeGreaterThan(0)
      }
    }
  })
})

// Отображение кода зонда в состояние серверной части (#413). Свитч критичен для UX: перепутанные
// 409/403 дали бы ложное «переустановите приложение» на здоровой установке.
describe('mapProbeStatus', () => {
  it('200 и 403 — портал серверной части ИЗВЕСТЕН', () => {
    // 403 достижим только после успешного поиска портала по домену, значит портал найден.
    expect(mapProbeStatus(200)).toBe('ok')
    expect(mapProbeStatus(403)).toBe('ok')
  })

  it('409 — строки портала нет', () => {
    expect(mapProbeStatus(409)).toBe('portal-missing')
  })

  it('0 и 5xx — недоступна сама серверная часть', () => {
    expect(mapProbeStatus(0)).toBe('down')
    expect(mapProbeStatus(500)).toBe('down')
    expect(mapProbeStatus(502)).toBe('down')
  })

  it('прочие коды — не судим', () => {
    expect(mapProbeStatus(400)).toBe('unknown')
    expect(mapProbeStatus(401)).toBe('unknown')
  })
})
