import { describe, expect, it } from 'vitest'
import { DEDUPE_MS, STALE_AFTER_MS, shouldReconnect, watchResume } from '../src/client/resume.ts'
import type { ResumeHost } from '../src/client/resume.ts'

type State = 'connected' | 'disconnected' | 'connecting' | undefined

describe('shouldReconnect', () => {
  it('replaces a connection that is retrying or down, whatever the time hidden', () => {
    for (const state of ['connecting', 'disconnected'] as const) {
      expect(shouldReconnect({ state, hiddenMs: 0, online: true })).toBe(true)
    }
  })

  it('replaces a connected socket only after the tab was hidden long enough to have killed it', () => {
    expect(shouldReconnect({ state: 'connected', hiddenMs: STALE_AFTER_MS, online: true })).toBe(true)
    expect(shouldReconnect({ state: 'connected', hiddenMs: 10 * STALE_AFTER_MS, online: true })).toBe(true)
    expect(shouldReconnect({ state: 'connected', hiddenMs: STALE_AFTER_MS - 1, online: true })).toBe(false)
    expect(shouldReconnect({ state: 'connected', hiddenMs: 0, online: true })).toBe(false)
  })

  it('leaves a loop with no outcome yet alone', () => {
    expect(shouldReconnect({ state: undefined, hiddenMs: 10 * STALE_AFTER_MS, online: true })).toBe(false)
  })

  it('does nothing while the browser reports no network: the online event restarts the loop', () => {
    for (const state of ['connected', 'connecting', 'disconnected', undefined] as const) {
      expect(shouldReconnect({ state, hiddenMs: 10 * STALE_AFTER_MS, online: false })).toBe(false)
    }
  })
})

function fakePage(initial: { state?: State; online?: boolean } = {}) {
  const listeners = new Map<string, Set<(event: { persisted: boolean }) => void>>()
  const page = {
    visibility: 'visible',
    time: 1_000_000,
    state: 'state' in initial ? initial.state : ('connected' as State),
    online: initial.online ?? true,
    reconnects: 0,
  }
  const add = (type: string, listener: (event: { persisted: boolean }) => void) => {
    listeners.set(type, (listeners.get(type) ?? new Set()).add(listener))
  }
  const remove = (type: string, listener: (event: { persisted: boolean }) => void) => {
    listeners.get(type)?.delete(listener)
  }
  const host: ResumeHost = {
    document: {
      get visibilityState() { return page.visibility },
      addEventListener: (type, listener) => { add(type, listener) },
      removeEventListener: (type, listener) => { remove(type, listener) },
    },
    window: { addEventListener: add, removeEventListener: remove },
    now: () => page.time,
    online: () => page.online,
    state: () => page.state,
    reconnect: () => { page.reconnects += 1 },
  }
  const fire = (type: string, event = { persisted: false }) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
  }
  /** Hide the tab, let time pass, show it again. */
  const background = (ms: number) => {
    page.visibility = 'hidden'
    fire('visibilitychange')
    page.time += ms
    page.visibility = 'visible'
    fire('visibilitychange')
  }
  const listenerCount = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0)
  return { host, page, fire, background, listenerCount }
}

describe('watchResume', () => {
  it('reconnects a socket that read connected when the tab was away long enough', () => {
    const { host, page, background } = fakePage()
    watchResume(host)
    background(STALE_AFTER_MS + 1)
    expect(page.reconnects).toBe(1)
  })

  it('leaves a healthy connection alone after a short look away', () => {
    const { host, page, background } = fakePage()
    watchResume(host)
    background(2_000)
    expect(page.reconnects).toBe(0)
  })

  it('goes straight to a retry when the connection was not healthy, even after a short look away', () => {
    const { host, page, background } = fakePage({ state: 'disconnected' })
    watchResume(host)
    background(500)
    expect(page.reconnects).toBe(1)
  })

  it('counts a restore from the back-forward cache, and only that, from pageshow', () => {
    const { host, page, fire } = fakePage({ state: 'connecting' })
    watchResume(host)
    fire('pageshow', { persisted: false })
    expect(page.reconnects).toBe(0)
    fire('pageshow', { persisted: true })
    expect(page.reconnects).toBe(1)
  })

  it('treats visibilitychange and pageshow arriving together as one resume', () => {
    const { host, page, fire } = fakePage({ state: 'connecting' })
    watchResume(host)
    fire('pagehide')
    page.time += 60_000
    page.visibility = 'visible'
    fire('visibilitychange')
    fire('pageshow', { persisted: true })
    expect(page.reconnects).toBe(1)
    // A later, separate resume is handled again.
    page.time += DEDUPE_MS + 1
    fire('pageshow', { persisted: true })
    expect(page.reconnects).toBe(2)
  })

  it('measures the time hidden from the first hide signal', () => {
    const { host, page, fire } = fakePage()
    watchResume(host)
    page.visibility = 'hidden'
    fire('visibilitychange')
    page.time += STALE_AFTER_MS - 1_000
    fire('pagehide')
    page.time += 2_000
    page.visibility = 'visible'
    fire('visibilitychange')
    expect(page.reconnects).toBe(1)
  })

  it('does not reconnect while offline', () => {
    const { host, page, background } = fakePage({ online: false })
    watchResume(host)
    background(10 * STALE_AFTER_MS)
    expect(page.reconnects).toBe(0)
  })

  it('stops listening when stopped', () => {
    const { host, page, background, listenerCount } = fakePage()
    const stop = watchResume(host)
    expect(listenerCount()).toBe(3)
    stop()
    expect(listenerCount()).toBe(0)
    background(10 * STALE_AFTER_MS)
    expect(page.reconnects).toBe(0)
  })
})
