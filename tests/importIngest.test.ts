import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  handleImportUpload,
  parseManualFileBase64,
  type IngestDeps
} from '../server/utils/importIngest'
import type { ParseJob } from '../server/queue/topology'

function fixtureB64(rel: string): string {
  const bytes = readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)))
  return bytes.toString('base64')
}

/** Deps that succeed by default; override per test. Captures the enqueued job. */
function fakeDeps(over: Partial<IngestDeps> = {}): { deps: IngestDeps, enqueued: ParseJob[] } {
  const enqueued: ParseJob[] = []
  const deps: IngestDeps = {
    validateFrame: async () => 'user-42',
    memberIdByDomain: async () => 'MEMBER-1',
    enqueueParse: async (job) => {
      enqueued.push(job)
      return true
    },
    hash: () => 'HASH',
    ...over
  }
  return { deps, enqueued }
}

const bytes = new TextEncoder().encode('some file bytes')
const input = { accessToken: 'tok', domain: 'p.bitrix24.by', fileName: 'export.txt', bytes }

describe('handleImportUpload', () => {
  it('accepts a valid upload → 202, enqueues a scoped manual parse job', async () => {
    const { deps, enqueued } = fakeDeps()
    const r = await handleImportUpload(deps, input)
    expect(r.status).toBe(202)
    expect(r.body).toMatchObject({ accepted: true, batchId: 'HASH' })
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({
      memberId: 'MEMBER-1', providerId: 'manual', fileName: 'export.txt', fileHash: 'HASH', userId: 'user-42'
    })
    // The file rides in the packet, base64-encoded (no separate store).
    expect(Buffer.from(enqueued[0]!.contentBase64, 'base64').toString()).toBe('some file bytes')
  })

  it('rejects missing frame auth → 400', async () => {
    const { deps } = fakeDeps()
    expect((await handleImportUpload(deps, { ...input, accessToken: '' })).status).toBe(400)
    expect((await handleImportUpload(deps, { ...input, domain: '' })).status).toBe(400)
  })

  it('rejects a bad extension / oversize before any I/O → 400', async () => {
    const { deps, enqueued } = fakeDeps()
    expect((await handleImportUpload(deps, { ...input, fileName: 'scan.pdf' })).status).toBe(400)
    expect((await handleImportUpload(deps, { ...input, bytes: new Uint8Array(0) })).status).toBe(400)
    expect(enqueued).toHaveLength(0)
  })

  it('rejects when the portal is not installed (no key) → 409, no enqueue', async () => {
    const validateFrame = vi.fn()
    const { deps, enqueued } = fakeDeps({ memberIdByDomain: async () => null, validateFrame })
    const r = await handleImportUpload(deps, input)
    expect(r.status).toBe(409)
    expect(enqueued).toHaveLength(0)
    // We reject on the missing key BEFORE spending a REST validation call.
    expect(validateFrame).not.toHaveBeenCalled()
  })

  it('rejects a frame token that is not valid for this portal → 403', async () => {
    const boom = async () => {
      throw new Error('B24 REST profile failed')
    }
    const { deps, enqueued } = fakeDeps({ validateFrame: boom })
    const r = await handleImportUpload(deps, input)
    expect(r.status).toBe(403)
    expect(enqueued).toHaveLength(0)
  })

  it('surfaces an unavailable queue → 503', async () => {
    const { deps } = fakeDeps({ enqueueParse: async () => false })
    expect((await handleImportUpload(deps, input)).status).toBe(503)
  })
})

describe('parseManualFileBase64 (real fixtures, windows-1251)', () => {
  it('parses a client-bank text export carried as base64', () => {
    const items = parseManualFileBase64(fixtureB64('client-bank/demo-prior-byn.txt'))
    expect(items.length).toBeGreaterThan(0)
    expect(items[0]).toHaveProperty('direction')
  })

  it('parses a 1CClientBankExchange export carried as base64', () => {
    const items = parseManualFileBase64(fixtureB64('1c-exchange/demo-1c.txt'))
    expect(items.length).toBeGreaterThan(0)
  })

  it('throws on an unrecognized format', () => {
    const b64 = Buffer.from('not a statement').toString('base64')
    expect(() => parseManualFileBase64(b64)).toThrow(/Неизвестный формат/)
  })
})
