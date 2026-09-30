import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALLOWED_HOSTS,
  MAX_PLAINTEXT_BYTES,
  encryptPayload,
  fromBase64Url,
  generateVapidKeys,
  isVapidKeys,
  parseSubscription,
  sendPush,
  toBase64Url,
  vapidHeader,
} from '../src/push.ts'
import type { PushSubscriptionRecord } from '../src/push.ts'

/** RFC 8291 section 5 example values. */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  senderPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

function bytes(text: string): Buffer {
  const decoded = fromBase64Url(text)
  if (decoded === undefined) throw new Error(`not base64url: ${text}`)
  return decoded
}

/** The receiver side of RFC 8291: what a browser does with a received body. */
function decrypt(body: Buffer, receiverPrivate: Buffer, receiverPublic: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16)
  const idLength = body.readUInt8(20)
  const senderPublic = body.subarray(21, 21 + idLength)
  const sealed = body.subarray(21 + idLength)
  const receiver = createECDH('prime256v1')
  receiver.setPrivateKey(receiverPrivate)
  const shared = receiver.computeSecret(senderPublic)
  const derive = (saltBytes: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer => {
    const prk = createHmac('sha256', saltBytes).update(ikm).digest()
    return createHmac('sha256', prk).update(info).update(Buffer.from([1])).digest().subarray(0, length)
  }
  const ikm = derive(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic]), 32)
  const key = derive(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = derive(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12)
  const decipher = createDecipheriv('aes-128-gcm', key, nonce)
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
  expect(padded[padded.length - 1]).toBe(2)
  return padded.subarray(0, padded.length - 1).toString('utf8')
}

function newReceiver(): { privateKey: Buffer; publicKey: Buffer; auth: Buffer; record: PushSubscriptionRecord } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16)))
  return {
    privateKey: ecdh.getPrivateKey(),
    publicKey: ecdh.getPublicKey(),
    auth,
    record: {
      endpoint: 'https://web.push.apple.com/abc123',
      keys: { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(auth) },
      createdAt: 1,
    },
  }
}

describe('encryptPayload', () => {
  it('reproduces the RFC 8291 section 5 message byte for byte', () => {
    const body = encryptPayload({
      plaintext: Buffer.from(RFC.plaintext),
      receiverPublicKey: bytes(RFC.receiverPublic),
      authSecret: bytes(RFC.auth),
      salt: bytes(RFC.salt),
      senderPrivateKey: bytes(RFC.senderPrivate),
    })
    expect(toBase64Url(body)).toBe(RFC.body)
    expect(toBase64Url(body.subarray(21, 86))).toBe(RFC.senderPublic)
  })

  it('round-trips through an independent receiver implementation', () => {
    const receiver = newReceiver()
    const body = encryptPayload({
      plaintext: Buffer.from('{"title":"Vesta · build","body":"done ✓"}'),
      receiverPublicKey: receiver.publicKey,
      authSecret: receiver.auth,
    })
    expect(decrypt(body, receiver.privateKey, receiver.publicKey, receiver.auth)).toBe('{"title":"Vesta · build","body":"done ✓"}')
  })

  it('uses a fresh salt and sender key for every message', () => {
    const receiver = newReceiver()
    const input = { plaintext: Buffer.from('same'), receiverPublicKey: receiver.publicKey, authSecret: receiver.auth }
    expect(encryptPayload(input).equals(encryptPayload(input))).toBe(false)
  })

  it('refuses a message that would exceed one push record', () => {
    const receiver = newReceiver()
    const fits = Buffer.alloc(MAX_PLAINTEXT_BYTES, 0x61)
    expect(encryptPayload({ plaintext: fits, receiverPublicKey: receiver.publicKey, authSecret: receiver.auth }).length).toBe(4096)
    const over = Buffer.alloc(MAX_PLAINTEXT_BYTES + 1, 0x61)
    expect(() => encryptPayload({ plaintext: over, receiverPublicKey: receiver.publicKey, authSecret: receiver.auth })).toThrow('exceeds')
  })

  it('refuses malformed subscription keys', () => {
    const receiver = newReceiver()
    expect(() => encryptPayload({ plaintext: Buffer.from('x'), receiverPublicKey: Buffer.alloc(65), authSecret: receiver.auth })).toThrow('uncompressed')
    expect(() => encryptPayload({ plaintext: Buffer.from('x'), receiverPublicKey: receiver.publicKey, authSecret: Buffer.alloc(8) })).toThrow('16 bytes')
    expect(() => encryptPayload({ plaintext: Buffer.from('x'), receiverPublicKey: receiver.publicKey, authSecret: receiver.auth, salt: Buffer.alloc(3) })).toThrow('salt')
  })
})

describe('VAPID', () => {
  it('generates a pair of the documented shape', () => {
    const keys = generateVapidKeys()
    expect(isVapidKeys(keys)).toBe(true)
    expect(bytes(keys.publicKey).length).toBe(65)
    expect(bytes(keys.privateKey).length).toBe(32)
    expect(isVapidKeys({ publicKey: 'AAAA', privateKey: keys.privateKey })).toBe(false)
    expect(isVapidKeys(null)).toBe(false)
    expect(isVapidKeys({ publicKey: 1, privateKey: 2 })).toBe(false)
  })

  it('signs an ES256 JWT with the right claims that verifies against the public key', () => {
    const keys = generateVapidKeys()
    const now = 1_800_000_000_000
    const header = vapidHeader('https://web.push.apple.com/some/path?x=1', 'https://vesta.example/harness/', keys, now)
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)
    expect(match).toBeTruthy()
    const [, head, claims, signature, publicKey] = match as RegExpExecArray
    expect(publicKey).toBe(keys.publicKey)
    expect(JSON.parse(bytes(head as string).toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    const parsed = JSON.parse(bytes(claims as string).toString()) as { aud: string; exp: number; sub: string }
    expect(parsed.aud).toBe('https://web.push.apple.com')
    expect(parsed.sub).toBe('https://vesta.example/harness/')
    expect(parsed.exp).toBe(1_800_000_000 + 12 * 3600)
    const point = bytes(keys.publicKey)
    const publicObject = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: toBase64Url(point.subarray(1, 33)), y: toBase64Url(point.subarray(33, 65)) },
      format: 'jwk',
    })
    const ok = verify('sha256', Buffer.from(`${head as string}.${claims as string}`), { key: publicObject, dsaEncoding: 'ieee-p1363' }, bytes(signature as string))
    expect(ok).toBe(true)
  })

  it('rejects a public key that is not base64url', () => {
    expect(() => vapidHeader('https://web.push.apple.com/x', 'https://a.example/', { publicKey: '***', privateKey: 'x' }, 0)).toThrow('base64url')
  })
})

describe('parseSubscription', () => {
  const receiver = newReceiver()
  const valid = { endpoint: 'https://web.push.apple.com/abc', keys: receiver.record.keys }

  it('accepts a well-formed subscription from an allowed service', () => {
    const result = parseSubscription(valid, DEFAULT_ALLOWED_HOSTS, 42)
    expect(result).toEqual({ ok: true, subscription: { endpoint: valid.endpoint, keys: valid.keys, createdAt: 42 } })
  })

  it('accepts subdomains of an allowed host and the host itself', () => {
    expect(parseSubscription({ ...valid, endpoint: 'https://fcm.googleapis.com/fcm/send/x' }, DEFAULT_ALLOWED_HOSTS, 1).ok).toBe(true)
    expect(parseSubscription({ ...valid, endpoint: 'https://push.apple.com/x' }, DEFAULT_ALLOWED_HOSTS, 1).ok).toBe(true)
    expect(parseSubscription({ ...valid, endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x' }, DEFAULT_ALLOWED_HOSTS, 1).ok).toBe(true)
  })

  it('refuses everything else with a reason', () => {
    const refuse = (value: unknown): string => {
      const result = parseSubscription(value, DEFAULT_ALLOWED_HOSTS, 1)
      return result.ok ? 'accepted' : result.error
    }
    expect(refuse(null)).toMatch(/not an object/)
    expect(refuse({ keys: valid.keys })).toMatch(/endpoint is missing/)
    expect(refuse({ ...valid, endpoint: 'not a url' })).toMatch(/not a URL/)
    expect(refuse({ ...valid, endpoint: 'http://web.push.apple.com/x' })).toMatch(/https/)
    expect(refuse({ ...valid, endpoint: 'https://internal.example/x' })).toMatch(/not an allowed push service/)
    expect(refuse({ ...valid, endpoint: 'https://evilpush.apple.com.attacker.example/x' })).toMatch(/not an allowed push service/)
    expect(refuse({ ...valid, endpoint: 'https://notpush.apple.com/x' })).toMatch(/not an allowed push service/)
    expect(refuse({ endpoint: valid.endpoint })).toMatch(/p256dh/)
    expect(refuse({ endpoint: valid.endpoint, keys: { p256dh: toBase64Url(Buffer.alloc(65)), auth: valid.keys.auth } })).toMatch(/p256dh/)
    expect(refuse({ endpoint: valid.endpoint, keys: { p256dh: valid.keys.p256dh, auth: 'AAAA' } })).toMatch(/auth/)
  })
})

describe('sendPush', () => {
  const vapid = generateVapidKeys()

  type Run = { outcome: string; request: { url: string; init: RequestInit }; receiver: ReturnType<typeof newReceiver> }
  function run(status: number): Promise<Run> {
    const receiver = newReceiver()
    let captured: { url: string; init: RequestInit } | undefined
    const transport = ((url: string, init: RequestInit) => {
      captured = { url, init }
      return Promise.resolve(new Response(null, { status }))
    }) as unknown as typeof fetch
    return sendPush({
      subscription: receiver.record,
      payload: Buffer.from('{"title":"t"}'),
      subject: 'https://vesta.example/harness/',
      keys: vapid,
      ttlSeconds: 900,
      fetch: transport,
      nowMs: 1_800_000_000_000,
    }).then(outcome => ({ outcome, request: captured as { url: string; init: RequestInit }, receiver }))
  }

  it('posts an encrypted body with the headers a push service requires', async () => {
    const { outcome, request, receiver } = await run(201)
    expect(outcome).toBe('sent')
    expect(request.url).toBe('https://web.push.apple.com/abc123')
    const headers = request.init.headers as Record<string, string>
    expect(headers['content-encoding']).toBe('aes128gcm')
    expect(headers.ttl).toBe('900')
    expect(headers.urgency).toBe('normal')
    expect(headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
    const body = Buffer.from(request.init.body as Uint8Array)
    expect(decrypt(body, receiver.privateKey, receiver.publicKey, receiver.auth)).toBe('{"title":"t"}')
  })

  it('reports a dead subscription so the caller can drop it', async () => {
    expect((await run(410)).outcome).toBe('gone')
    expect((await run(404)).outcome).toBe('gone')
  })

  it('treats other failures as failed and keeps the subscription', async () => {
    expect((await run(500)).outcome).toBe('failed')
    expect((await run(413)).outcome).toBe('failed')
  })

  it('fails without sending when the stored keys are damaged', async () => {
    let called = false
    const transport = (() => {
      called = true
      return Promise.resolve(new Response(null, { status: 201 }))
    }) as unknown as typeof fetch
    const outcome = await sendPush({
      subscription: { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: '***', auth: '***' }, createdAt: 1 },
      payload: Buffer.from('x'),
      subject: 'https://vesta.example/',
      keys: vapid,
      ttlSeconds: 60,
      fetch: transport,
    })
    expect(outcome).toBe('failed')
    expect(called).toBe(false)
  })
})

describe('key material helpers', () => {
  it('round-trips base64url and rejects non-canonical text', () => {
    expect(toBase64Url(Buffer.from([251, 255, 254]))).toBe('-__-')
    expect(fromBase64Url('-__-')?.equals(Buffer.from([251, 255, 254]))).toBe(true)
    expect(fromBase64Url('ab+/')).toBeUndefined()
    expect(fromBase64Url('a')).toBeUndefined()
    expect(fromBase64Url('AB')).toBeUndefined()
  })
})
