import { createECDH } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { DEFAULT_ALLOWED_HOSTS, toBase64Url } from '../src/push.ts'

type Route = { path: string; methods: readonly string[]; fetch: (request: Request) => Promise<Response> }
type Listener = (...args: unknown[]) => unknown

let dir = ''
const realFetch = globalThis.fetch

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vesta-notify-'))
})

afterEach(async () => {
  globalThis.fetch = realFetch
  await rm(dir, { recursive: true, force: true })
})

function config(overrides: Partial<Config> = {}): Config {
  return {
    url: 'http://127.0.0.1:7335/mcp',
    tool: 'notify',
    minTurnSeconds: 0,
    approvalWaitSeconds: 60,
    cooldownSeconds: 0,
    awayAfterSeconds: 90,
    onlyWhenAway: true,
    excludePresets: ['vesta-incognito'],
    quietHours: '',
    silent: false,
    linkBase: 'https://vesta.test/harness/',
    channels: ['telegram'],
    push: { subject: '', storeFile: join(dir, 'vesta-push.json'), allowedHosts: [...DEFAULT_ALLOWED_HOSTS], ttlSeconds: 600 },
    ...overrides,
  }
}

/** A host context that records what the plugin registers. */
function host(): { ctx: never; routes: Route[]; listeners: Map<string, Listener>; warnings: unknown[] } {
  const routes: Route[] = []
  const listeners = new Map<string, Listener>()
  const warnings: unknown[] = []
  const ctx = {
    connection: {
      fetch: {
        register(route: Route) {
          routes.push(route)
          return () => Promise.resolve()
        },
      },
    },
    logger: { info() {}, warn(error: unknown) { warnings.push(error) } },
    effect(setup: () => unknown) { return setup() },
    on(event: string, listener: Listener) {
      listeners.set(event, listener)
      return () => undefined
    },
  }
  return { ctx: ctx as never, routes, listeners, warnings }
}

function finishedTurn(listeners: Map<string, Listener>): void {
  const session = { id: 'session-1', header: { agentPreset: 'vesta-ops' }, snapshotEvents: () => [] }
  const onEvent = listeners.get('session/event') as Listener
  onEvent(session, { type: 'turn/start' })
  onEvent(session, { type: 'turn/end' })
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
  expect(condition()).toBe(true)
}

describe('vesta-notify channels', () => {
  it('registers only the presence route and never pushes with the default configuration', () => {
    const { ctx, routes } = host()
    apply(ctx, config())
    expect(routes.map(route => route.path)).toEqual(['/api/vesta/notify/presence'])
  })

  it('registers the three push routes when the push channel is on', () => {
    const { ctx, routes } = host()
    apply(ctx, config({ channels: ['telegram', 'push'] }))
    expect(routes.map(route => `${route.methods.join()} ${route.path}`)).toEqual([
      'POST /api/vesta/notify/presence',
      'GET /api/vesta/notify/push/key',
      'POST /api/vesta/notify/push/subscribe',
      'POST /api/vesta/notify/push/unsubscribe',
    ])
  })

  it('fails loudly at load on an unknown channel', () => {
    expect(() =>{  apply(host().ctx, config({ channels: ['telegram', 'sms'] })) }).toThrow('unknown channel sms')
  })

  it('fails loudly at load when push has no usable VAPID subject', () => {
    expect(() =>{  apply(host().ctx, config({ channels: ['push'], linkBase: 'http://lan.test/' })) }).toThrow('push.subject')
    expect(() =>{  apply(host().ctx, config({ channels: ['push'], linkBase: '', push: { ...config().push, subject: 'nobody@example.com' } })) }).toThrow('push.subject')
  })

  it('takes the VAPID subject from an https linkBase', () => {
    expect(() =>{  apply(host().ctx, config({ channels: ['push'] })) }).not.toThrow()
  })
})

describe('vesta-notify delivery', () => {
  it('sends Telegram only, and only while away, on the default channel list', async () => {
    const calls: string[] = []
    globalThis.fetch = ((url: string) => {
      calls.push(url)
      return Promise.resolve(Response.json({ result: {} }))
    }) as unknown as typeof fetch
    const { ctx, listeners, routes } = host()
    apply(ctx, config())
    finishedTurn(listeners)
    await until(() => calls.length === 1)
    expect(calls).toEqual(['http://127.0.0.1:7335/mcp'])

    // A visible tab heartbeat silences it.
    const presence = routes.find(route => route.path.endsWith('/presence')) as Route
    await presence.fetch(new Request('http://vesta.test/x', { method: 'POST', body: JSON.stringify({ visible: true }) }))
    finishedTurn(listeners)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(calls).toHaveLength(1)
  })

  it('pushes to a subscribed device and skips Telegram when only push is configured', async () => {
    const calls: string[] = []
    globalThis.fetch = ((url: string) => {
      calls.push(url)
      return Promise.resolve(new Response(null, { status: 201 }))
    }) as unknown as typeof fetch
    const { ctx, listeners, routes } = host()
    apply(ctx, config({ channels: ['push'] }))
    const subscribe = routes.find(route => route.path.endsWith('/push/subscribe')) as Route
    const phone = createECDH('prime256v1')
    phone.generateKeys()
    const response = await subscribe.fetch(new Request('http://vesta.test/x', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: 'https://web.push.apple.com/phone',
        keys: { p256dh: toBase64Url(phone.getPublicKey()), auth: toBase64Url(Buffer.from('0123456789abcdef')) },
      }),
    }))
    expect(response.status).toBe(200)
    finishedTurn(listeners)
    await until(() => calls.length === 1)
    expect(calls).toEqual(['https://web.push.apple.com/phone'])
  })

  it('does not suppress push because of Telegram failures, and reports them', async () => {
    const calls: string[] = []
    globalThis.fetch = ((url: string) => {
      calls.push(url)
      return url.includes('7335')
        ? Promise.resolve(new Response('no', { status: 500 }))
        : Promise.resolve(new Response(null, { status: 201 }))
    }) as unknown as typeof fetch
    const { ctx, listeners, routes, warnings } = host()
    apply(ctx, config({ channels: ['telegram', 'push'] }))
    const subscribe = routes.find(route => route.path.endsWith('/push/subscribe')) as Route
    const phone = createECDH('prime256v1')
    phone.generateKeys()
    await subscribe.fetch(new Request('http://vesta.test/x', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: 'https://web.push.apple.com/phone',
        keys: { p256dh: toBase64Url(phone.getPublicKey()), auth: toBase64Url(Buffer.from('0123456789abcdef')) },
      }),
    }))
    finishedTurn(listeners)
    await until(() => calls.length === 2 && warnings.length === 1)
    expect(calls.sort()).toEqual(['http://127.0.0.1:7335/mcp', 'https://web.push.apple.com/phone'])
  })
})
