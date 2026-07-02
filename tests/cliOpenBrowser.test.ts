import { beforeEach, describe, expect, it, vi } from 'vitest'

// openBrowser (scripts/lib/cli.mjs) hands a URL to the OS opener. Its only real
// security logic is the URL gate: it must refuse anything that is not a plain
// http(s) URL before spawning (so a `javascript:`/`file:`/`data:` or a crafted
// non-URL can never reach `spawn`/`cmd.exe`). Issue #45.
const spawnMock = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const { openBrowser } = await import('../scripts/lib/cli.mjs')

describe('openBrowser URL gate (scripts/lib/cli.mjs, #45)', () => {
  beforeEach(() => spawnMock.mockClear())

  it('does NOT spawn for non-http(s) schemes or non-URL input', () => {
    for (const bad of [
      'java' + 'script:alert(1)', // avoid the literal scheme in source
      'file:///etc/passwd',
      'data:text/html,x',
      'ftp://host/x',
      'not a url',
      ''
    ]) {
      openBrowser(bad)
    }
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('spawns the OS opener exactly once for a valid http(s) URL, carrying the URL', () => {
    openBrowser('https://developerhub.alfabank.by:8273/authorize?response_type=code')
    expect(spawnMock).toHaveBeenCalledTimes(1)
    // The URL is passed as an argv entry (posix) or a quoted arg (win) — either way present.
    expect(JSON.stringify(spawnMock.mock.calls[0])).toContain('https://developerhub.alfabank.by:8273/authorize')
  })

  it('accepts plain http as well', () => {
    openBrowser('http://localhost:3000/oauth-callback')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('passes the normalized href — an embedded quote is percent-encoded, never raw (cmd.exe injection, #45)', () => {
    // A `"` in the URL must not survive into the spawn args: on Windows it would
    // break out of the `start "" "<url>"` quoting and inject `& calc & ...`.
    openBrowser('https://x.com/a"&calc.exe&"b')
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const args = spawnMock.mock.calls[0]![1] as string[]
    const joined = args.join(' ')
    expect(joined).not.toContain('a"') // the raw `a"…` injection sequence is gone
    expect(joined).toContain('%22') // the quote is percent-encoded instead
  })
})
