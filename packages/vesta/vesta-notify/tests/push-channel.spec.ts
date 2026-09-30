import { createDecipheriv, createECDH, createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ALLOWED_HOSTS, toBase64Url } from '../src/push.ts'
import { PushChannel, resolveSubject } from '../src/push-channel.ts'
import { PushStore } from '../src/push-store.ts'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vesta-push-channel-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface Device {
  readonly body: { endpoint: string; keys: { p256dh: string; auth: string } }
  readonly privateKey: Buffer
  readonly publicKey: Buffer
  readonly auth: Buffer
}

function device(name: string): Device {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = Buffer.from('0123456789abcdef')
  return {
    body: {
      endpoint: `https://web.push.apple.com/${name}`,
      keys: { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(auth) },
    },
    privateKey: ecdh.getPrivateKey(),
    publicKey: ecdh.getPublicKey(),
    auth,
  }
}

/** Receiver side of RFC 8291, enough to read what the channel sent. */
function open(body: Uint8Array, target: Device): string {
  const packet = Buffer.from(body)
  const salt = packet.subarray(0, 16)
  const senderPublic = packet.subarray(21, 86)
  const sealed = packet.subarray(86)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(target.privateKey)
  const shared = ecdh.computeSecret(senderPublic)
  const derive = (saltBytes: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer => {
    const prk = createHmac('sha256', saltBytes).update(ikm).digest()
    return createHmac('sha256', prk).update(info).update(Buffer.from([1])).digest().subarray(0, length)
  }
  const ikm = derive(target.auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), target.publicKey, senderPublic]), 32)
  const decipher = createDecipheriv('aes-128-gcm', derive(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), derive(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12))
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
  return padded.subarray(0, padded.length - 1).toString('utf8')
}

function post(path: string, body: unknown): Request {
  return new Request(`http://vesta.test${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
}

async function channel(responses: Record<string, number | 'throw'> = {}): Promise<{ channel: PushChannel; store: PushStore; posted: Map<string, Uint8Array> }> {
  const store = new PushStore(join(dir, 'vesta-push.json'))
  const posted = new Map<string, Uint8Array>()
  const transport = ((url: string, init: RequestInit) => {
    posted.set(url, init.body as Uint8Array)
    const behaviour = responses[url] ?? 201
    if (behaviour === 'throw') return Promise.reject(new Error('network down'))
    return Promise.resolve(new Response(null, { status: behaviour }))
  }) as unknown as typeof fetch
  return {
    channel: new PushChannel(store, { subject: 'https://vesta.test/harness/', allowedHosts: DEFAULT_ALLOWED_HOSTS, ttlSeconds: 600 }, { fetch: transport, now: () => 1_800_000_000_000 }),
    store,
    posted,
  }
}

describe('resolveSubject', () => {
  it('prefers a valid explicit subject and falls back to an https link base', () => {
    expect(resolveSubject('mailto:ops@example.com', 'https://a.example/')).toBe('mailto:ops@example.com')
    expect(resolveSubject('https://b.example/', '')).toBe('https://b.example/')
    expect(resolveSubject('', 'https://vesta.test/harness/')).toBe('https://vesta.test/harness/')
  })

  it('returns nothing rather than a subject Apple would refuse', () => {
    expect(resolveSubject('ops@example.com', 'https://a.example/')).toBeUndefined()
    expect(resolveSubject('http://b.example/', '')).toBeUndefined()
    expect(resolveSubject('', 'http://vesta.test/')).toBeUndefined()
    expect(resolveSubject('', '')).toBeUndefined()
  })
})

describe('routes', () => {
  it('serves the public key', async () => {
    const { channel: push, store } = await channel()
    const response = await push.keyResponse()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled: true, publicKey: store.vapid.publicKey })
  })

  it('stores a subscription and counts the devices', async () => {
    const { channel: push, store } = await channel()
    const response = await push.subscribeResponse(post('/x', device('phone').body))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, devices: 1 })
    expect(store.list()).toHaveLength(1)
  })

  it('refuses bodies that are not valid subscriptions', async () => {
    const { channel: push, store } = await channel()
    for (const body of ['{not json', '"text"', { endpoint: 'https://attacker.example/x', keys: device('x').body.keys }, 'x'.repeat(5000)]) {
      const response = await push.subscribeResponse(post('/x', body))
      expect(response.status).toBe(400)
    }
    expect(store.list()).toHaveLength(0)
  })

  it('forgets a subscription and refuses a body without an endpoint', async () => {
    const { channel: push, store } = await channel()
    const phone = device('phone')
    await push.subscribeResponse(post('/x', phone.body))
    expect((await push.unsubscribeResponse(post('/x', {}))).status).toBe(400)
    expect((await push.unsubscribeResponse(post('/x', '{bad'))).status).toBe(400)
    const response = await push.unsubscribeResponse(post('/x', { endpoint: phone.body.endpoint }))
    expect(await response.json()).toEqual({ ok: true, devices: 0 })
    expect(store.list()).toHaveLength(0)
  })

  it('answers 503 instead of throwing when the store file is damaged', async () => {
    await writeFile(join(dir, 'vesta-push.json'), '{broken')
    const { channel: push } = await channel()
    expect((await push.keyResponse()).status).toBe(503)
    expect((await push.subscribeResponse(post('/x', device('p').body))).status).toBe(503)
    expect((await push.unsubscribeResponse(post('/x', { endpoint: 'https://web.push.apple.com/p' }))).status).toBe(503)
  })
})

describe('send', () => {
  it('delivers the notification encrypted to every device', async () => {
    const { channel: push, posted } = await channel()
    const phone = device('phone')
    const tablet = device('tablet')
    await push.subscribeResponse(post('/x', phone.body))
    await push.subscribeResponse(post('/x', tablet.body))
    const result = await push.send({ title: 'Vesta · build', body: 'Turn finished after 130 s.', url: 'https://vesta.test/harness/', tag: 'session-1:turn' })
    expect(result).toEqual({ sent: 2, gone: 0, failed: 0 })
    const message = JSON.parse(open(posted.get(phone.body.endpoint) as Uint8Array, phone)) as Record<string, string>
    expect(message).toEqual({ title: 'Vesta · build', body: 'Turn finished after 130 s.', url: 'https://vesta.test/harness/', tag: 'session-1:turn' })
    expect(JSON.parse(open(posted.get(tablet.body.endpoint) as Uint8Array, tablet)) as Record<string, string>).toEqual(message)
  })

  it('forgets devices the push service reports gone and keeps devices that merely failed', async () => {
    const phone = device('phone')
    const tablet = device('tablet')
    const laptop = device('laptop')
    const { channel: push, store } = await channel({
      [phone.body.endpoint]: 410,
      [tablet.body.endpoint]: 'throw',
      [laptop.body.endpoint]: 201,
    })
    for (const target of [phone, tablet, laptop]) await push.subscribeResponse(post('/x', target.body))
    const result = await push.send({ title: 't', body: 'b', url: '', tag: 'k' })
    expect(result).toEqual({ sent: 1, gone: 1, failed: 1 })
    expect(store.list().map(item => item.endpoint)).toEqual([tablet.body.endpoint, laptop.body.endpoint])
  })

  it('shortens an over-long title and body to what a lock screen shows', async () => {
    const { channel: push, posted } = await channel()
    const phone = device('phone')
    await push.subscribeResponse(post('/x', phone.body))
    await push.send({ title: 'T'.repeat(500), body: 'B'.repeat(2000), url: '', tag: 'k' })
    const message = JSON.parse(open(posted.get(phone.body.endpoint) as Uint8Array, phone)) as { title: string; body: string }
    expect(message.title).toHaveLength(100)
    expect(message.body).toHaveLength(240)
    expect(message.title.endsWith('…')).toBe(true)
  })

  it('does nothing when nobody is subscribed', async () => {
    const { channel: push, posted } = await channel()
    expect(await push.send({ title: 't', body: 'b', url: '', tag: 'k' })).toEqual({ sent: 0, gone: 0, failed: 0 })
    expect(posted.size).toBe(0)
  })
})
