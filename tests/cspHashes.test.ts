import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The build script exports its pure helpers for testing; the CLI part is guarded
// so importing it here does not run/exit.
import { collectHashes } from '../scripts/csp-hashes.mjs'

const sha = (body: string) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'csp-hashes-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('collectHashes', () => {
  it('hashes the body of an executable inline script', () => {
    const body = 'console.log(1)'
    writeFileSync(join(dir, 'index.html'), `<html><head><script>${body}</script></head></html>`)
    expect(collectHashes(dir)).toEqual([sha(body)])
  })

  it('ignores scripts with a src (external, not inline)', () => {
    writeFileSync(join(dir, 'index.html'), '<script src="/_nuxt/app.js"></script>')
    expect(collectHashes(dir)).toEqual([])
  })

  it('ignores non-executable JSON data islands (Nuxt __NUXT_DATA__)', () => {
    writeFileSync(
      join(dir, 'index.html'),
      '<script type="application/json" id="__NUXT_DATA__">[1,2,3]</script>'
    )
    expect(collectHashes(dir)).toEqual([])
  })

  it('ignores importmap blocks', () => {
    writeFileSync(join(dir, 'index.html'), '<script type="importmap">{"imports":{}}</script>')
    expect(collectHashes(dir)).toEqual([])
  })

  it('skips empty-bodied scripts', () => {
    writeFileSync(join(dir, 'index.html'), '<script type="module"></script>')
    expect(collectHashes(dir)).toEqual([])
  })

  it('deduplicates identical scripts across files and recurses into subdirs', () => {
    const body = 'window.__NUXT__=1'
    writeFileSync(join(dir, 'index.html'), `<script>${body}</script>`)
    mkdirSync(join(dir, 'app'))
    writeFileSync(join(dir, 'app', 'index.html'), `<script>${body}</script>`)
    expect(collectHashes(dir)).toEqual([sha(body)])
  })

  it('keeps a theme-init script and a window.__NUXT__ config script as two hashes', () => {
    const themeInit = '(function(){document.documentElement.classList.add("dark")})()'
    const config = 'window.__NUXT__={config:{app:{buildId:"abc"}}}'
    writeFileSync(
      join(dir, 'index.html'),
      `<script data-hid="theme-init">${themeInit}</script>`
      + '<script type="application/json" id="__NUXT_DATA__">[]</script>'
      + `<script>${config}</script>`
    )
    expect(collectHashes(dir).sort()).toEqual([sha(themeInit), sha(config)].sort())
  })
})
