/**
 * The Web Push channel of `vesta-notify`: the three cookie-authenticated
 * routes a browser uses to subscribe, and the fan-out that delivers one
 * notification to every subscribed device.
 */
import { parseSubscription, sendPush } from './push.ts'
import type { PushOutcome, PushSubscriptionRecord } from './push.ts'
import type { PushStore } from './push-store.ts'

/** Returns the VAPID public key the browser subscribes with (404 when the channel is off). */
export const PUSH_KEY_PATH = '/api/vesta/notify/push/key'
/** Stores a `PushSubscription.toJSON()` body. */
export const PUSH_SUBSCRIBE_PATH = '/api/vesta/notify/push/subscribe'
/** Forgets a subscription by `{ endpoint }`. */
export const PUSH_UNSUBSCRIBE_PATH = '/api/vesta/notify/push/unsubscribe'

/** A subscription is about 400 bytes of JSON; anything larger is not one. */
const MAX_BODY_CHARS = 4096
const MAX_TITLE_CHARS = 100
const MAX_BODY_TEXT_CHARS = 240

/** Settings of the channel, resolved from the plugin config. */
export interface PushChannelConfig {
  /** VAPID contact URL (`https:` or `mailto:`). */
  readonly subject: string
  /** Host suffixes subscription endpoints may use. */
  readonly allowedHosts: readonly string[]
  /** Seconds a push service may hold a message for an offline device. */
  readonly ttlSeconds: number
}

/** One notification as the service worker receives it. */
export interface PushMessage {
  readonly title: string
  readonly body: string
  /** Where a tap should lead; empty means the app's own start page. */
  readonly url: string
  /** Notifications with the same tag replace each other on the device. */
  readonly tag: string
}

/** Delivery counts of one fan-out. */
export interface PushResult {
  readonly sent: number
  readonly gone: number
  readonly failed: number
}

/** Collaborators a test may replace. */
export interface PushChannelDeps {
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

/**
 * The VAPID subject for a config: the explicit value, else `linkBase` when that is an https URL.
 * Apple refuses a push whose `sub` claim is neither `mailto:` nor `https:`.
 * @param subject - the configured subject, possibly empty.
 * @param linkBase - the harness URL, possibly empty.
 * @returns the subject, or undefined when none can be derived.
 */
export function resolveSubject(subject: string, linkBase: string): string | undefined {
  const explicit = subject.trim()
  if (explicit !== '') return /^(https:\/\/|mailto:)\S+$/.test(explicit) ? explicit : undefined
  const derived = linkBase.trim()
  return /^https:\/\/\S+$/.test(derived) ? derived : undefined
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Subscribe routes and delivery over one {@link PushStore}. */
export class PushChannel {
  private readonly store: PushStore
  private readonly config: PushChannelConfig
  private readonly deps: PushChannelDeps

  /**
   * @param store - key pair and subscriptions.
   * @param config - subject, allowed hosts and message lifetime.
   * @param deps - replaceable transport and clock.
   */
  constructor(store: PushStore, config: PushChannelConfig, deps: PushChannelDeps = {}) {
    this.store = store
    this.config = config
    this.deps = deps
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private async opened(): Promise<Response | undefined> {
    try {
      await this.store.ready()
      return undefined
    } catch {
      return Response.json({ ok: false, error: 'push store unavailable' }, { status: 503 })
    }
  }

  /** `GET` the public key the browser passes to `pushManager.subscribe`. */
  async keyResponse(): Promise<Response> {
    const failure = await this.opened()
    if (failure !== undefined) return failure
    return Response.json({ enabled: true, publicKey: this.store.vapid.publicKey })
  }

  private async body(request: Request): Promise<unknown> {
    const text = await request.text()
    if (text.length > MAX_BODY_CHARS) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  }

  /** `POST` a browser's subscription. */
  async subscribeResponse(request: Request): Promise<Response> {
    const failure = await this.opened()
    if (failure !== undefined) return failure
    const parsed = parseSubscription(await this.body(request), this.config.allowedHosts, this.now())
    if (!parsed.ok) return Response.json({ ok: false, error: parsed.error }, { status: 400 })
    await this.store.add(parsed.subscription)
    return Response.json({ ok: true, devices: this.store.list().length })
  }

  /** `POST` `{ endpoint }` to forget a subscription. */
  async unsubscribeResponse(request: Request): Promise<Response> {
    const failure = await this.opened()
    if (failure !== undefined) return failure
    const value = await this.body(request) as { endpoint?: unknown } | undefined
    if (typeof value?.endpoint !== 'string') return Response.json({ ok: false, error: 'the endpoint is missing' }, { status: 400 })
    await this.store.remove(value.endpoint)
    return Response.json({ ok: true, devices: this.store.list().length })
  }

  private async deliver(subscription: PushSubscriptionRecord, payload: Uint8Array): Promise<PushOutcome> {
    try {
      return await sendPush({
        subscription,
        payload,
        subject: this.config.subject,
        keys: this.store.vapid,
        ttlSeconds: this.config.ttlSeconds,
        ...(this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch }),
        nowMs: this.now(),
      })
    } catch {
      // A transport error or an oversized payload: the device stays subscribed and the next notification tries again.
      return 'failed'
    }
  }

  /**
   * Deliver one notification to every subscribed device; devices the push service reports gone are forgotten.
   * @param message - what to show.
   * @returns how many devices accepted, dropped and failed it.
   */
  async send(message: PushMessage): Promise<PushResult> {
    await this.store.ready()
    const payload = Buffer.from(JSON.stringify({
      title: truncate(message.title, MAX_TITLE_CHARS),
      body: truncate(message.body, MAX_BODY_TEXT_CHARS),
      url: message.url,
      tag: message.tag,
    }))
    const devices = [...this.store.list()]
    const outcomes = await Promise.all(devices.map(device => this.deliver(device, payload)))
    const dead = devices.filter((_, index) => outcomes[index] === 'gone')
    for (const device of dead) await this.store.remove(device.endpoint)
    return {
      sent: outcomes.filter(outcome => outcome === 'sent').length,
      gone: dead.length,
      failed: outcomes.filter(outcome => outcome === 'failed').length,
    }
  }
}
