import { describe, expect, it } from 'vitest'
import { installVerdict } from '~/utils/installVerdict'

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

  it('backend не увидел портал → degraded: импорт не заработает (#413)', () => {
    // Событие установки идёт мимо iframe, поэтому «портал установлен» ничего не говорит о том,
    // получила ли его серверная часть. Раньше это выглядело как полностью успешная установка.
    const v = installVerdict({ ...base, backend: 'portal-missing' })
    expect(v.level).toBe('degraded')
    expect(v.issues[0]!.title).toContain('не получила уведомление')
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
