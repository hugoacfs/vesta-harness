import { describe, expect, it } from 'vitest'
import { decodeKey, disable, enable, readState } from '../src/client/push-client.ts'
import type { PushEnv, PushManagerLike, SubscriptionLike } from '../src/client/push-client.ts'

const BASE = 'https://vesta.test/harness/'
/** base64url of bytes 4, 251, 255, 254: exercises both url-safe characters. */
const KEY = 'BPv__g'
const KEY_BYTES = [4, 251, 255, 254]

interface Fake {
  readonly env: PushEnv
  readonly calls: string[]
  readonly posts: { url: string; body: unknown; credentials: unknown }[]
  readonly subscription: { endpoint: string; unsubscribed: boolean }
  readonly manager: { subscribeFailures: number; held: SubscriptionLike | null }
}

function fake(options: {
  server?: 'ok' | 404 | 'disabled' | 'throws'
  subscribeResponse?: { status: number; body?: unknown }
  permission?: string
  requested?: string
  supported?: boolean
  ios?: boolean
  standalone?: boolean
  held?: 'same-key' | 'other-key' | 'no-options' | 'none'
  subscribeFailures?: number
  hasRegistration?: boolean
} = {}): Fake {
  const calls: string[] = []
  const posts: Fake['posts'] = []
  const subscription = { endpoint: 'https://web.push.apple.com/device', unsubscribed: false }
  const make = (applicationServerKey?: ArrayBuffer | null): SubscriptionLike => ({
    endpoint: subscription.endpoint,
    ...(applicationServerKey === undefined ? {} : { options: { applicationServerKey } }),
    toJSON: () => ({ endpoint: subscription.endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: () => {
      calls.push('unsubscribe')
      subscription.unsubscribed = true
      return Promise.resolve(true)
    },
  })
  const heldKind = options.held ?? 'none'
  const state = {
    subscribeFailures: options.subscribeFailures ?? 0,
    held: heldKind === 'none'
      ? null
      : heldKind === 'no-options'
        ? make()
        : make(new Uint8Array(heldKind === 'same-key' ? KEY_BYTES : [9, 9, 9, 9]).buffer),
  }
  const manager: PushManagerLike = {
    getSubscription: () => Promise.resolve(state.held),
    subscribe: () => {
      calls.push('subscribe')
      if (state.subscribeFailures > 0) {
        state.subscribeFailures -= 1
        return Promise.reject(new Error('InvalidStateError'))
      }
      state.held = make(new Uint8Array(KEY_BYTES).buffer)
      return Promise.resolve(state.held)
    },
  }
  const registration = { pushManager: manager }
  const server = options.server ?? 'ok'
  const env: PushEnv = {
    base: BASE,
    fetch: (input, init) => {
      if (input.endsWith('/push/key')) {
        calls.push('fetch key')
        if (server === 'throws') return Promise.reject(new Error('offline'))
        if (server === 404) return Promise.resolve(new Response(null, { status: 404 }))
        return Promise.resolve(Response.json(server === 'disabled' ? { enabled: false } : { enabled: true, publicKey: KEY }))
      }
      calls.push(`post ${input.slice(BASE.length)}`)
      const raw = init?.body
      posts.push({ url: input, body: JSON.parse(typeof raw === 'string' ? raw : '{}') as unknown, credentials: init?.credentials })
      const answer = options.subscribeResponse ?? { status: 200 }
      const response = answer.body === undefined
        ? new Response(null, { status: answer.status })
        : Response.json(answer.body, { status: answer.status })
      return Promise.resolve(response)
    },
    serviceWorker: options.supported === false
      ? undefined
      : {
        register: (script, registerOptions) => {
          calls.push(`register ${script} ${registerOptions.scope}`)
          return Promise.resolve(registration)
        },
        getRegistration: () => Promise.resolve(options.hasRegistration === false ? undefined : registration),
        // A getter, so 'ready' is logged when the flow actually waits for the worker.
        get ready() {
          calls.push('ready')
          return Promise.resolve(registration)
        },
      },
    notification: options.supported === false
      ? undefined
      : {
        permission: options.permission ?? 'default',
        requestPermission: () => {
          calls.push('requestPermission')
          return Promise.resolve(options.requested ?? 'granted')
        },
      },
    pushManager: options.supported !== false,
    standalone: options.standalone ?? true,
    ios: options.ios ?? false,
  }
  return { env, calls, posts, subscription, manager: state }
}

describe('decodeKey', () => {
  it('decodes unpadded base64url, including the url-safe characters', () => {
    expect([...decodeKey(KEY)]).toEqual(KEY_BYTES)
    expect([...decodeKey('AQID')]).toEqual([1, 2, 3])
    expect([...decodeKey('AQI')]).toEqual([1, 2])
  })
})

describe('readState', () => {
  it('shows nothing when the Host runs without the push channel or cannot be reached', async () => {
    expect(await readState(fake({ server: 404 }).env)).toBe('unavailable')
    expect(await readState(fake({ server: 'disabled' }).env)).toBe('unavailable')
    expect(await readState(fake({ server: 'throws' }).env)).toBe('unavailable')
    expect(await readState(fake({ server: 404, ios: true, supported: false, standalone: false }).env)).toBe('unavailable')
  })

  it('asks an iPhone in a browser tab to install the app first', async () => {
    expect(await readState(fake({ supported: false, ios: true, standalone: false }).env)).toBe('needs-install')
  })

  it('shows nothing in a browser without Web Push that is not an iPhone', async () => {
    expect(await readState(fake({ supported: false }).env)).toBe('unsupported')
    expect(await readState(fake({ supported: false, ios: true, standalone: true }).env)).toBe('unsupported')
  })

  it('reports blocked when notifications were refused in the system settings', async () => {
    expect(await readState(fake({ permission: 'denied' }).env)).toBe('blocked')
  })

  it('is on only while this browser holds a subscription made with the Host current key', async () => {
    expect(await readState(fake({ held: 'same-key' }).env)).toBe('on')
    expect(await readState(fake({ held: 'no-options' }).env)).toBe('on')
    expect(await readState(fake({ held: 'other-key' }).env)).toBe('off')
    expect(await readState(fake({ held: 'none' }).env)).toBe('off')
    expect(await readState(fake({ hasRegistration: false }).env)).toBe('off')
  })
})

describe('enable', () => {
  it('asks permission before any other step, then registers, waits for the worker, subscribes and tells the Host', async () => {
    const { env, calls, posts } = fake()
    expect(await enable(env)).toBe('on')
    expect(calls).toEqual([
      'requestPermission',
      'fetch key',
      'register https://vesta.test/harness/sw.js /harness/',
      'ready',
      'subscribe',
      'post api/vesta/notify/push/subscribe',
    ])
    expect(posts).toEqual([{
      url: 'https://vesta.test/harness/api/vesta/notify/push/subscribe',
      body: { endpoint: 'https://web.push.apple.com/device', keys: { p256dh: 'p', auth: 'a' } },
      credentials: 'same-origin',
    }])
  })

  it('does nothing further when permission is refused or dismissed', async () => {
    const denied = fake({ requested: 'denied' })
    expect(await enable(denied.env)).toBe('blocked')
    expect(denied.calls).toEqual(['requestPermission'])
    const dismissed = fake({ requested: 'default' })
    expect(await enable(dismissed.env)).toBe('off')
    expect(dismissed.calls).toEqual(['requestPermission'])
  })

  it('replaces a subscription made with an earlier server key', async () => {
    const { env, calls, manager } = fake({ held: 'other-key', subscribeFailures: 1 })
    expect(await enable(env)).toBe('on')
    expect(calls.filter(call => call === 'subscribe')).toHaveLength(2)
    expect(calls).toContain('unsubscribe')
    expect(manager.held).toBeDefined()
  })

  it('gives up when subscribing fails and nothing is held', async () => {
    const { env } = fake({ subscribeFailures: 1 })
    await expect(enable(env)).rejects.toThrow('InvalidStateError')
  })

  it('removes the browser-side subscription and reports the Host reason when the Host refuses it', async () => {
    const { env, subscription } = fake({ subscribeResponse: { status: 400, body: { ok: false, error: 'the endpoint host x is not an allowed push service' } } })
    await expect(enable(env)).rejects.toThrow('not an allowed push service')
    expect(subscription.unsubscribed).toBe(true)
  })

  it('names the status when the Host answers without a reason', async () => {
    const { env } = fake({ subscribeResponse: { status: 502 } })
    await expect(enable(env)).rejects.toThrow('502')
  })

  it('fails clearly when the Host turns out not to offer push', async () => {
    const { env } = fake({ server: 404 })
    await expect(enable(env)).rejects.toThrow('not enabled')
  })

  it('falls back to reading the state when the browser lacks the APIs', async () => {
    expect(await enable(fake({ supported: false, ios: true, standalone: false }).env)).toBe('needs-install')
  })
})

describe('disable', () => {
  it('tells the Host and then drops the subscription', async () => {
    const { env, calls, posts, subscription } = fake({ held: 'same-key' })
    expect(await disable(env)).toBe('off')
    expect(posts).toEqual([{
      url: 'https://vesta.test/harness/api/vesta/notify/push/unsubscribe',
      body: { endpoint: 'https://web.push.apple.com/device' },
      credentials: 'same-origin',
    }])
    expect(calls).toEqual(['post api/vesta/notify/push/unsubscribe', 'unsubscribe'])
    expect(subscription.unsubscribed).toBe(true)
  })

  it('still unsubscribes locally when the Host cannot be reached', async () => {
    const fakeEnv = fake({ held: 'same-key' })
    const failing: PushEnv = { ...fakeEnv.env, fetch: () => Promise.reject(new Error('offline')) }
    expect(await disable(failing)).toBe('off')
    expect(fakeEnv.subscription.unsubscribed).toBe(true)
  })

  it('does nothing when this browser has no subscription', async () => {
    expect(await disable(fake({ held: 'none' }).env)).toBe('off')
    expect(await disable(fake({ hasRegistration: false }).env)).toBe('off')
    expect(await disable(fake({ supported: false }).env)).toBe('off')
  })
})
