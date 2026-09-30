import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

/** The shipped worker script, run against a fake service-worker global. */
const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
const SCOPE = 'https://vesta.test/harness/'

interface Shown { readonly title: string; readonly options: Record<string, unknown> }
interface FakeClient { readonly url: string; focused: boolean; focus?: () => Promise<void> }

function fakeWorker(config: { badging?: 'works' | 'absent' | 'throws'; windows?: FakeClient[] } = {}) {
  const listeners = new Map<string, (event: unknown) => void>()
  const shown: Shown[] = []
  const badge: (number | 'clear')[] = []
  const opened: string[] = []
  const flags = { skipWaiting: false, claimed: false }
  const closed: boolean[] = []
  const badging = config.badging ?? 'works'
  const self = {
    registration: {
      scope: SCOPE,
      showNotification(title: string, options: Record<string, unknown>) {
        shown.push({ title, options })
        return Promise.resolve()
      },
      getNotifications: () => Promise.resolve(shown.map(() => ({}))),
    },
    navigator: badging === 'absent'
      ? {}
      : {
          setAppBadge(count: number) {
            if (badging === 'throws') return Promise.reject(new Error('refused'))
            badge.push(count)
            return Promise.resolve()
          },
          clearAppBadge() {
            badge.push('clear')
            return Promise.resolve()
          },
        },
    clients: {
      claim() {
        flags.claimed = true
        return Promise.resolve()
      },
      matchAll: () => Promise.resolve(config.windows ?? []),
      openWindow(url: string) {
        opened.push(url)
        return Promise.resolve()
      },
    },
    skipWaiting() {
      flags.skipWaiting = true
      return Promise.resolve()
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, listener)
    },
  }
  runInContext(SOURCE, createContext({ self, URL }))

  /** Fire an event and wait for everything it passed to waitUntil. */
  async function dispatch(type: string, event: Record<string, unknown> = {}): Promise<void> {
    const pending: Promise<unknown>[] = []
    const listener = listeners.get(type)
    if (listener === undefined) throw new Error(`no ${type} listener`)
    listener({ ...event, waitUntil: (work: Promise<unknown>) => { pending.push(work) } })
    await Promise.all(pending)
  }

  function push(payload: unknown): Promise<void> {
    const data = typeof payload === 'string'
      ? { json: () => { throw new SyntaxError('not json') }, text: () => payload }
      : { json: () => payload, text: () => JSON.stringify(payload) }
    return dispatch('push', { data })
  }

  function click(url: unknown): Promise<void> {
    return dispatch('notificationclick', { notification: { data: url === undefined ? undefined : { url }, close: () => { closed.push(true) } } })
  }

  return { listeners, shown, badge, opened, flags, closed, dispatch, push, click }
}

describe('vesta service worker', () => {
  it('takes over at once and registers no fetch handler', async () => {
    const worker = fakeWorker()
    await worker.dispatch('install')
    await worker.dispatch('activate')
    expect(worker.flags).toEqual({ skipWaiting: true, claimed: true })
    expect([...worker.listeners.keys()].sort()).toEqual(['activate', 'install', 'notificationclick', 'push'])
  })

  it('shows the pushed notification and puts the count on the app icon', async () => {
    const worker = fakeWorker()
    await worker.push({ title: 'Vesta · build', body: 'Turn finished after 130 s.', url: SCOPE, tag: 'session-1:turn' })
    expect(worker.shown).toEqual([{
      title: 'Vesta · build',
      options: { body: 'Turn finished after 130 s.', icon: `${SCOPE}apple-touch-icon.png`, data: { url: SCOPE }, tag: 'session-1:turn' },
    }])
    expect(worker.badge).toEqual([1])
  })

  it('still shows something for an empty or malformed push, as iOS requires', async () => {
    const worker = fakeWorker()
    await worker.push('plain text, not JSON')
    await worker.push({})
    await worker.dispatch('push')
    expect(worker.shown.map(item => item.title)).toEqual(['vesta', 'vesta', 'vesta'])
    expect(worker.shown[0]?.options.body).toBe('plain text, not JSON')
    expect(worker.shown[1]?.options.tag).toBeUndefined()
  })

  it('shows the notification when the platform has no badge API or refuses it', async () => {
    const absent = fakeWorker({ badging: 'absent' })
    await absent.push({ title: 'a' })
    expect(absent.shown).toHaveLength(1)
    const refusing = fakeWorker({ badging: 'throws' })
    await refusing.push({ title: 'b' })
    expect(refusing.shown).toHaveLength(1)
  })

  it('opens the app when a tap finds no open window, staying inside the app scope', async () => {
    const worker = fakeWorker()
    await worker.click(`${SCOPE}?session=1`)
    await worker.click('https://attacker.example/phish')
    await worker.click('')
    await worker.click(undefined)
    await worker.click('relative/page')
    await worker.click('http://[bad')
    expect(worker.opened).toEqual([`${SCOPE}?session=1`, SCOPE, SCOPE, SCOPE, `${SCOPE}relative/page`, SCOPE])
    expect(worker.closed).toHaveLength(6)
  })

  it('focuses a window that is already open instead of opening a second one', async () => {
    const existing: FakeClient = { url: `${SCOPE}`, focused: false }
    existing.focus = () => {
      existing.focused = true
      return Promise.resolve()
    }
    const worker = fakeWorker({ windows: [{ url: 'https://other.example/', focused: false }, existing] })
    await worker.click(SCOPE)
    expect(existing.focused).toBe(true)
    expect(worker.opened).toEqual([])
  })

  it('opens a window when the only match cannot be focused', async () => {
    const worker = fakeWorker({ windows: [{ url: SCOPE, focused: false }] })
    await worker.click(SCOPE)
    expect(worker.opened).toEqual([SCOPE])
  })
})
