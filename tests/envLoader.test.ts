import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDotEnv } from '../scripts/lib/env.mjs'

// Each test writes throwaway .env files to a temp dir and asserts process.env.
// Keys used here are unique to the suite so we can clean them up afterwards.
const KEYS = ['T_LOADER_A', 'T_LOADER_B', 'T_LOADER_PRESET']
const createdDirs: string[] = []

function tmp(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'envloader-'))
  createdDirs.push(dir)
  const file = join(dir, name)
  writeFileSync(file, body)
  return file
}

afterEach(() => {
  for (const k of KEYS) Reflect.deleteProperty(process.env, k)
  while (createdDirs.length) {
    try {
      rmSync(createdDirs.pop()!, { recursive: true, force: true })
    } catch { /* best-effort temp cleanup */ }
  }
})

describe('loadDotEnv', () => {
  it('loads the first readable file and sets new keys', () => {
    const file = tmp('.env', 'T_LOADER_A=one\nT_LOADER_B=two\n')
    const loaded = loadDotEnv([file])
    expect(loaded).toBe(file)
    expect(process.env.T_LOADER_A).toBe('one')
    expect(process.env.T_LOADER_B).toBe('two')
  })

  it('does NOT override a value already set in the environment', () => {
    process.env.T_LOADER_PRESET = 'from-env'
    const file = tmp('.env', 'T_LOADER_PRESET=from-file\n')
    loadDotEnv([file])
    expect(process.env.T_LOADER_PRESET).toBe('from-env')
  })

  it('skips a missing implicit candidate and falls through to the next', () => {
    const file = tmp('.env', 'T_LOADER_A=fallback\n')
    const loaded = loadDotEnv([join(tmpdir(), 'does-not-exist-xyz.env'), file])
    expect(loaded).toBe(file)
    expect(process.env.T_LOADER_A).toBe('fallback')
  })

  it('returns null when no implicit candidate exists', () => {
    expect(loadDotEnv([join(tmpdir(), 'nope-1.env'), join(tmpdir(), 'nope-2.env')])).toBeNull()
  })
})
