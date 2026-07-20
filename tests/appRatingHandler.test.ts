import { describe, expect, it, vi } from 'vitest'
import {
  handleAppRatingReport,
  handleAppRatingShow,
  type AppRatingReportDeps,
  type AppRatingShowDeps
} from '../server/utils/appRatingHandler'

const NOW = new Date('2026-07-19T12:00:00Z')

function showDeps(over: Partial<AppRatingShowDeps> = {}): AppRatingShowDeps {
  return {
    memberIdByDomain: async () => 'M',
    validateFrame: async () => 'user-7',
    getState: async () => null, // no row → shouldPrompt = true
    now: () => NOW,
    ...over
  }
}

function reportDeps(over: Partial<AppRatingReportDeps> = {}): AppRatingReportDeps {
  return {
    memberIdByDomain: async () => 'M',
    validateFrame: async () => 'user-7',
    markPrompted: vi.fn(async () => {}),
    markOpened: vi.fn(async () => {}),
    ...over
  }
}

const AUTH = { accessToken: 'tok', domain: 'x.bitrix24.by' }

describe('handleAppRatingShow', () => {
  it('shows when framed, installed, valid token and no row yet', async () => {
    const r = await handleAppRatingShow(showDeps(), AUTH)
    expect(r).toEqual({ status: 200, body: { show: true } })
  })

  it('silent (show:false) without token/domain — never nags, never errors', async () => {
    expect(await handleAppRatingShow(showDeps(), { accessToken: '', domain: '' })).toEqual({ status: 200, body: { show: false } })
  })

  it('silent when the app is not installed for the domain', async () => {
    const r = await handleAppRatingShow(showDeps({ memberIdByDomain: async () => null }), AUTH)
    expect(r.body).toEqual({ show: false })
  })

  it('silent when the frame token is invalid / foreign (throws or empty)', async () => {
    const boom = async (): Promise<string> => {
      throw new Error('bad')
    }
    const thrown = await handleAppRatingShow(showDeps({ validateFrame: boom }), AUTH)
    expect(thrown.body).toEqual({ show: false })
    const empty = await handleAppRatingShow(showDeps({ validateFrame: async () => '' }), AUTH)
    expect(empty.body).toEqual({ show: false })
  })

  it('does not prompt a reviewed portal', async () => {
    const r = await handleAppRatingShow(showDeps({
      getState: async () => ({ promptedAt: null, openedAt: null, reviewed: true })
    }), AUTH)
    expect(r.body).toEqual({ show: false })
  })
})

describe('handleAppRatingReport', () => {
  it('401 without token/domain', async () => {
    const r = await handleAppRatingReport(reportDeps(), { accessToken: '', domain: '', action: 'prompted' })
    expect(r.status).toBe(401)
  })

  it('400 on an unknown action (before any REST/DB)', async () => {
    const d = reportDeps()
    const r = await handleAppRatingReport(d, { ...AUTH, action: 'delete' })
    expect(r.status).toBe(400)
    expect(d.memberIdByDomain).toBeDefined()
    expect(d.markPrompted).not.toHaveBeenCalled()
    expect(d.markOpened).not.toHaveBeenCalled()
  })

  it('409 when the portal is not installed', async () => {
    const r = await handleAppRatingReport(reportDeps({ memberIdByDomain: async () => null }), { ...AUTH, action: 'prompted' })
    expect(r.status).toBe(409)
  })

  it('403 on an invalid frame token', async () => {
    const r = await handleAppRatingReport(reportDeps({ validateFrame: async () => '' }), { ...AUTH, action: 'opened' })
    expect(r.status).toBe(403)
  })

  it('prompted → markPrompted', async () => {
    const d = reportDeps()
    const r = await handleAppRatingReport(d, { ...AUTH, action: 'prompted' })
    expect(r).toEqual({ status: 200, body: { ok: true } })
    expect(d.markPrompted).toHaveBeenCalledWith('M')
    expect(d.markOpened).not.toHaveBeenCalled()
  })

  it('opened → markOpened', async () => {
    const d = reportDeps()
    const r = await handleAppRatingReport(d, { ...AUTH, action: 'opened' })
    expect(r.status).toBe(200)
    expect(d.markOpened).toHaveBeenCalledWith('M')
    expect(d.markPrompted).not.toHaveBeenCalled()
  })
})
