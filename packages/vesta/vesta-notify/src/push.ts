/**
 * Web Push for `vesta-notify`: the two protocols a push service requires, on
 * Node's built-in `crypto` only.
 *
 *   - RFC 8291 message encryption (`aes128gcm`, one record): the payload
 *     reaches the browser encrypted to the subscription's own keys, so the
 *     push service (Apple, Google, Mozilla) relays ciphertext.
 *   - RFC 8292 VAPID: an ES256 JWT naming the sender, sent in `Authorization`.
 *
 * There is no dependency on purpose: the workspace lockfile is not regenerated
 * for this plugin. Swapping in the `web-push` package later only replaces
 * `sendPush`, `encryptPayload` and `vapidHeader`; the store and routes stay.
 */
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

/** A browser's push subscription as the server keeps it. */
export interface PushSubscriptionRecord {
  /** Push-service URL the encrypted message is POSTed to. */
  readonly endpoint: string
  readonly keys: {
    /** The browser's ECDH public key (uncompressed P-256 point), base64url. */
    readonly p256dh: string
    /** The browser's 16-byte authentication secret, base64url. */
    readonly auth: string
  }
  /** Epoch milliseconds the server stored it. */
  readonly createdAt: number
}

/** The server's VAPID key pair. */
export interface VapidKeys {
  /** Uncompressed P-256 public key (65 bytes), base64url: the `applicationServerKey` the browser subscribes with. */
  readonly publicKey: string
  /** P-256 private scalar (32 bytes), base64url. */
  readonly privateKey: string
}

/** Outcome of one delivery attempt. */
export type PushOutcome = 'sent' | 'gone' | 'failed'

/** Push services the server accepts subscription endpoints from. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  'push.apple.com',
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
]

/** One 4096-byte record holds the whole message; the push services cap a message at 4096 bytes. */
const RECORD_SIZE = 4096
const SALT_BYTES = 16
const AUTH_BYTES = 16
const PUBLIC_KEY_BYTES = 65
const PRIVATE_KEY_BYTES = 32
const AEAD_TAG_BYTES = 16
/** Header: salt, record size (uint32), key id length (uint8), sender public key. */
const HEADER_BYTES = SALT_BYTES + 4 + 1 + PUBLIC_KEY_BYTES
/** Largest plaintext that still yields a message of at most RECORD_SIZE bytes (one delimiter byte, one tag). */
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - HEADER_BYTES - 1 - AEAD_TAG_BYTES
/** VAPID claims may live at most 24 h; twelve is the customary margin. */
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60
const BASE64URL = /^[A-Za-z0-9_-]*$/

/**
 * Encode bytes as unpadded base64url.
 * @param bytes - the bytes to encode.
 * @returns the base64url text.
 */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Decode canonical unpadded base64url.
 * @param text - base64url text.
 * @returns the bytes, or undefined when the text is not canonical base64url.
 */
export function fromBase64Url(text: string): Buffer | undefined {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return undefined
  const bytes = Buffer.from(text, 'base64url')
  return bytes.toString('base64url') === text ? bytes : undefined
}

/**
 * Generate the server's VAPID key pair.
 * @returns a fresh P-256 pair in the wire encodings browsers and services expect.
 */
export function generateVapidKeys(): VapidKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  const point = publicKey.export({ format: 'jwk' })
  if (jwk.d === undefined || point.x === undefined || point.y === undefined) {
    throw new Error('vesta-notify: the EC key export lacks its parameters')
  }
  const uncompressed = Buffer.concat([Buffer.from([0x04]), Buffer.from(point.x, 'base64url'), Buffer.from(point.y, 'base64url')])
  return { publicKey: toBase64Url(uncompressed), privateKey: jwk.d }
}

/**
 * Whether a stored key pair is well formed.
 * @param value - parsed JSON.
 * @returns true when both halves decode to the expected lengths and the public key is an uncompressed point.
 */
export function isVapidKeys(value: unknown): value is VapidKeys {
  if (typeof value !== 'object' || value === null) return false
  const { publicKey, privateKey } = value as { publicKey?: unknown; privateKey?: unknown }
  if (typeof publicKey !== 'string' || typeof privateKey !== 'string') return false
  const point = fromBase64Url(publicKey)
  const scalar = fromBase64Url(privateKey)
  return point !== undefined && scalar !== undefined
    && point.length === PUBLIC_KEY_BYTES && point[0] === 0x04 && scalar.length === PRIVATE_KEY_BYTES
}

/**
 * Build the RFC 8292 `Authorization` value for one push service.
 * @param endpoint - the subscription endpoint; its origin becomes the `aud` claim.
 * @param subject - `mailto:` or `https:` contact URL for the `sub` claim (Apple rejects others).
 * @param keys - the server's VAPID pair.
 * @param nowMs - current epoch milliseconds (injectable for tests).
 * @returns `vapid t=<jwt>, k=<public key>`.
 */
export function vapidHeader(endpoint: string, subject: string, keys: VapidKeys, nowMs: number): string {
  const point = fromBase64Url(keys.publicKey)
  if (point === undefined) throw new Error('vesta-notify: the VAPID public key is not base64url')
  const header = toBase64Url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = toBase64Url(Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + VAPID_LIFETIME_SECONDS,
    sub: subject,
  })))
  const signingInput = `${header}.${claims}`
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: toBase64Url(point.subarray(1, 33)),
      y: toBase64Url(point.subarray(33, 65)),
      d: keys.privateKey,
    },
    format: 'jwk',
  })
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${signingInput}.${toBase64Url(signature)}, k=${keys.publicKey}`
}

/**
 * HKDF-SHA256 with a single output block (RFC 5869); every length used here is at most 32 bytes.
 * @param salt - extract salt.
 * @param ikm - input keying material.
 * @param info - expand context.
 * @param length - output bytes, at most 32.
 * @returns the derived key.
 */
function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest()
  return createHmac('sha256', prk).update(info).update(Buffer.from([0x01])).digest().subarray(0, length)
}

/** Inputs for {@link encryptPayload}. */
export interface EncryptInput {
  /** The message bytes. */
  readonly plaintext: Uint8Array
  /** The subscription's `keys.p256dh`, decoded (65 bytes). */
  readonly receiverPublicKey: Uint8Array
  /** The subscription's `keys.auth`, decoded (16 bytes). */
  readonly authSecret: Uint8Array
  /** 16 random bytes; injectable so the RFC test vector can be reproduced. */
  readonly salt?: Uint8Array
  /** Ephemeral sender private key (32 bytes); injectable for the same reason. */
  readonly senderPrivateKey?: Uint8Array
}

/**
 * Encrypt one message as an RFC 8291 `aes128gcm` body (a single record).
 * @param input - plaintext, the subscription's keys and optional fixed randomness.
 * @returns header plus ciphertext, ready to POST with `Content-Encoding: aes128gcm`.
 */
export function encryptPayload(input: EncryptInput): Buffer {
  if (input.receiverPublicKey.length !== PUBLIC_KEY_BYTES || input.receiverPublicKey[0] !== 0x04) {
    throw new Error('vesta-notify: the subscription public key is not an uncompressed P-256 point')
  }
  if (input.authSecret.length !== AUTH_BYTES) throw new Error('vesta-notify: the subscription auth secret must be 16 bytes')
  if (input.plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`vesta-notify: the push message exceeds ${String(MAX_PLAINTEXT_BYTES)} bytes`)
  }
  const salt = Buffer.from(input.salt ?? randomBytes(SALT_BYTES))
  if (salt.length !== SALT_BYTES) throw new Error('vesta-notify: the salt must be 16 bytes')

  const sender = createECDH('prime256v1')
  if (input.senderPrivateKey === undefined) sender.generateKeys()
  else sender.setPrivateKey(Buffer.from(input.senderPrivateKey))
  const senderPublicKey = sender.getPublicKey()
  const shared = sender.computeSecret(Buffer.from(input.receiverPublicKey))

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(input.receiverPublicKey), senderPublicKey])
  const ikm = hkdf(Buffer.from(input.authSecret), shared, keyInfo, 32)
  const contentKey = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12)

  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce)
  // 0x02 marks the last (here the only) record.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(input.plaintext), Buffer.from([0x02])])), cipher.final()])
  const header = Buffer.alloc(HEADER_BYTES)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES)
  header.writeUInt8(PUBLIC_KEY_BYTES, SALT_BYTES + 4)
  senderPublicKey.copy(header, SALT_BYTES + 5)
  return Buffer.concat([header, sealed, cipher.getAuthTag()])
}

/**
 * Validate a subscription a browser posted.
 * @param value - parsed JSON body (`PushSubscription.toJSON()` shape).
 * @param allowedHosts - host suffixes push endpoints may live under.
 * @param nowMs - the creation time to record.
 * @returns the record, or a one-line reason it was refused.
 */
export function parseSubscription(
  value: unknown,
  allowedHosts: readonly string[],
  nowMs: number,
): { readonly ok: true; readonly subscription: PushSubscriptionRecord } | { readonly ok: false; readonly error: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, error: 'the body is not an object' }
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null }
  if (typeof endpoint !== 'string') return { ok: false, error: 'the endpoint is missing' }
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return { ok: false, error: 'the endpoint is not a URL' }
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'the endpoint must be https' }
  const host = url.hostname.toLowerCase()
  if (!allowedHosts.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) {
    return { ok: false, error: `the endpoint host ${host} is not an allowed push service` }
  }
  const p256dh = typeof keys?.p256dh === 'string' ? fromBase64Url(keys.p256dh) : undefined
  const auth = typeof keys?.auth === 'string' ? fromBase64Url(keys.auth) : undefined
  if (p256dh === undefined || p256dh.length !== PUBLIC_KEY_BYTES || p256dh[0] !== 0x04) return { ok: false, error: 'keys.p256dh is not a P-256 point' }
  if (auth === undefined || auth.length !== AUTH_BYTES) return { ok: false, error: 'keys.auth must be 16 bytes' }
  return {
    ok: true,
    subscription: { endpoint, keys: { p256dh: toBase64Url(p256dh), auth: toBase64Url(auth) }, createdAt: nowMs },
  }
}

/** Inputs for {@link sendPush}. */
export interface SendInput {
  readonly subscription: PushSubscriptionRecord
  /** The message; UTF-8 JSON in this plugin. */
  readonly payload: Uint8Array
  /** VAPID contact URL (`mailto:` or `https:`). */
  readonly subject: string
  readonly keys: VapidKeys
  /** How long the service may hold the message while the device is offline. */
  readonly ttlSeconds: number
  /** Injectable transport. @default globalThis.fetch */
  readonly fetch?: typeof fetch
  /** Injectable clock, epoch ms. @default Date.now() */
  readonly nowMs?: number
}

/**
 * Deliver one message to one subscription.
 * @param input - subscription, payload, sender identity and lifetime.
 * @returns `sent` for 2xx; `gone` for 404 and 410 (the subscription is dead and should be dropped); `failed` otherwise.
 *   A network failure rejects; the caller treats that as `failed`.
 */
export async function sendPush(input: SendInput): Promise<PushOutcome> {
  const { subscription } = input
  const receiverPublicKey = fromBase64Url(subscription.keys.p256dh)
  const authSecret = fromBase64Url(subscription.keys.auth)
  if (receiverPublicKey === undefined || authSecret === undefined) return 'failed'
  const body = encryptPayload({ plaintext: input.payload, receiverPublicKey, authSecret })
  const response = await (input.fetch ?? fetch)(subscription.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidHeader(subscription.endpoint, input.subject, input.keys, input.nowMs ?? Date.now()),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(input.ttlSeconds),
      urgency: 'normal',
    },
    body: new Uint8Array(body),
  })
  if (response.status === 404 || response.status === 410) return 'gone'
  return response.ok ? 'sent' : 'failed'
}
