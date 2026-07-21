import { describe, expect, it } from 'vitest'
import {
  SETTINGS_RELOAD_COMMAND,
  buildSettingsReloadEvent,
  isSettingsReloadCommand
} from '../app/utils/settingsSync'

describe('settingsSync core', () => {
  it('builds a pull.application.event.add payload with the reload command', () => {
    const ev = buildSettingsReloadEvent('shef.bankimport')
    expect(ev.COMMAND).toBe(SETTINGS_RELOAD_COMMAND)
    expect(ev.MODULE_ID).toBe('shef.bankimport')
    expect(ev.PARAMS).toEqual({ from: 'app.options' })
  })

  it('carries a custom `from` marker', () => {
    expect(buildSettingsReloadEvent('m', 'chat.settings').PARAMS).toEqual({ from: 'chat.settings' })
  })

  it('recognises the reload command and rejects others', () => {
    expect(isSettingsReloadCommand(SETTINGS_RELOAD_COMMAND)).toBe(true)
    expect(isSettingsReloadCommand('reload.options')).toBe(true)
    expect(isSettingsReloadCommand('other')).toBe(false)
    expect(isSettingsReloadCommand('')).toBe(false)
    expect(isSettingsReloadCommand(undefined)).toBe(false)
    expect(isSettingsReloadCommand(null)).toBe(false)
  })
})
