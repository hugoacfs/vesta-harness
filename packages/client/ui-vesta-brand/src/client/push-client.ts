/**
 * Browser half of Vesta's Web Push: the subscribe / unsubscribe flow against
 * the routes `dsh-vesta-notify` serves. Everything the flow touches (fetch,
 * service worker, Notification) arrives through {@link PushEnv}, so the logic
 * runs under test without a browser.
 *
 * iOS shapes the order of the steps: the permission prompt only appears for a
 * call made during the tap, so {@link enable} asks for permission before any
 * other asynchronous work; and Web Push exists only in an app installed to the
 * home screen, which {@link readState} reports as `needs-install`.
 */

/** What the sidebar toggle should show. */
export type PushState =
  /** Still asking the Host. */
  | 'loading'
  /** The Host runs without the push channel: show nothing. */
  | 'unavailable'
  /** This browser has no Web Push and is not an iPhone or iPad waiting for an install: show nothing. */
  | 'unsupported'
  /** iPhone or iPad in a browser tab: push works only from the installed app. */
  | 'needs-install'
  /** The user refused notifications for this app in the system settings. */
  | 'blocked'
  | 'off'
  | 'on'

/** Base-relative route of the public key (`GET`). */
export const KEY_ROUTE = 'api/vesta/notify/push/key'
/** Base-relative route storing a subscription (`POST`). */
export const SUBSCRIBE_ROUTE = 'api/vesta/notify/push/subscribe'
/** Base-relative route forgetting a subscription (`POST`). */
export const UNSUBSCRIBE_ROUTE = 'api/vesta/notify/push/unsubscribe'
/** The worker script, relative to the document base (served from `apps/web/public`). */
export const WORKER_SCRIPT = 'sw.js'

/** The parts of a `PushSubscription` this flow uses. */
export interface SubscriptionLike {
  readonly endpoint: string
  readonly options?: { readonly applicationServerKey?: ArrayBuffer | null }
  toJSON(): unknown
  unsubscribe(): Promise<boolean>
}

/** The parts of a `PushManager` this flow uses. */
export interface PushManagerLike {
  getSubscription(): Promise<SubscriptionLike | null>
  subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<SubscriptionLike>
}

/** The parts of a `ServiceWorkerRegistration` this flow uses. */
export interface RegistrationLike {
  readonly pushManager: PushManagerLike
}

/** The parts of `navigator.serviceWorker` this flow uses. */
export interface WorkerContainerLike {
  register(script: string, options: { scope: string }): Promise<RegistrationLike>
  getRegistration(scope: string): Promise<RegistrationLike | undefined>
  readonly ready: Promise<RegistrationLike>
}

/** The parts of `Notification` this flow uses. */
export interface NotificationLike {
  readonly permission: string
  requestPermission(): Promise<string>
}

/** Everything the flow reads from the page. */
export interface PushEnv {
  /** `document.baseURI`: the app's base path, so a reverse-proxy sub-path is honoured. */
  readonly base: string
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly serviceWorker: WorkerContainerLike | undefined
  readonly notification: NotificationLike | undefined
  /** Whether `PushManager` exists in this window. */
  readonly pushManager: boolean
  /** Running as an installed app rather than in a browser tab. */
  readonly standalone: boolean
  /** An iPhone or iPad (including iPadOS presenting a desktop user agent). */
  readonly ios: boolean
}

/**
 * Read the flow's environment from the page.
 * @returns the environment, or undefined when there is no window (server rendering, tests).
 */
export function detectEnv(): PushEnv | undefined {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return undefined
  const nav = navigator as Navigator & { standalone?: boolean }
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  const standalone = window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true
  return {
    base: document.baseURI,
    fetch: (input, init) => window.fetch(input, init),
    serviceWorker: 'serviceWorker' in nav ? nav.serviceWorker as unknown as WorkerContainerLike : undefined,
    notification: typeof Notification === 'undefined' ? undefined : Notification,
    pushManager: 'PushManager' in window,
    standalone,
    ios,
  }
}

/**
 * Decode the Host's base64url VAPID public key for `applicationServerKey`.
 * @param key - base64url text.
 * @returns the key bytes.
 */
export function decodeKey(key: string): Uint8Array {
  const padded = key.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(key.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function scopeOf(base: string): string {
  return new URL('./', base).pathname
}

function credentials(body?: unknown): RequestInit {
  return body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/** The Host's public key, or undefined when the push channel is off or unreachable. */
async function fetchKey(env: PushEnv): Promise<string | undefined> {
  try {
    const response = await env.fetch(new URL(KEY_ROUTE, env.base).href, credentials())
    if (!response.ok) return undefined
    const body = await response.json() as { enabled?: unknown; publicKey?: unknown }
    return body.enabled === true && typeof body.publicKey === 'string' ? body.publicKey : undefined
  } catch {
    return undefined
  }
}

function sameKey(subscription: SubscriptionLike, key: Uint8Array): boolean {
  const held = subscription.options?.applicationServerKey
  if (held === undefined || held === null) return true
  const bytes = new Uint8Array(held)
  return bytes.length === key.length && bytes.every((value, index) => value === key[index])
}

/**
 * Work out what the toggle should show.
 * @param env - the page's capabilities.
 * @returns the state; `on` only when this browser holds a subscription made with the Host's current key.
 */
export async function readState(env: PushEnv): Promise<PushState> {
  const key = await fetchKey(env)
  if (key === undefined) return 'unavailable'
  if (env.serviceWorker === undefined || env.notification === undefined || !env.pushManager) {
    return env.ios && !env.standalone ? 'needs-install' : 'unsupported'
  }
  if (env.notification.permission === 'denied') return 'blocked'
  const registration = await env.serviceWorker.getRegistration(scopeOf(env.base))
  const subscription = await registration?.pushManager.getSubscription()
  return subscription !== null && subscription !== undefined && sameKey(subscription, decodeKey(key)) ? 'on' : 'off'
}

/** Subscribe, replacing a subscription made with a different (earlier) server key. */
async function subscribeFresh(manager: PushManagerLike, applicationServerKey: Uint8Array): Promise<SubscriptionLike> {
  const options = { userVisibleOnly: true, applicationServerKey }
  try {
    return await manager.subscribe(options)
  } catch (error) {
    const existing = await manager.getSubscription()
    if (existing === null) throw error
    await existing.unsubscribe()
    return manager.subscribe(options)
  }
}

/**
 * Turn alerts on for this device. Must run from a tap.
 * @param env - the page's capabilities.
 * @returns the new state: `on`, or `blocked` / `off` when the user did not grant permission.
 * @throws when the Host refuses the subscription; the browser-side subscription is removed first.
 */
export async function enable(env: PushEnv): Promise<PushState> {
  const { notification, serviceWorker } = env
  if (notification === undefined || serviceWorker === undefined) return readState(env)
  // The first asynchronous step: iOS shows the prompt only for a call made during the tap.
  const permission = await notification.requestPermission()
  if (permission === 'denied') return 'blocked'
  if (permission !== 'granted') return 'off'
  const key = await fetchKey(env)
  if (key === undefined) throw new Error('push notifications are not enabled on the server')
  const registration = await serviceWorker.register(new URL(WORKER_SCRIPT, env.base).href, { scope: scopeOf(env.base) })
  // subscribe() needs an active worker; a first registration is still installing here.
  await serviceWorker.ready
  const subscription = await subscribeFresh(registration.pushManager, decodeKey(key))
  const response = await env.fetch(new URL(SUBSCRIBE_ROUTE, env.base).href, credentials(subscription.toJSON()))
  if (!response.ok) {
    await subscription.unsubscribe().catch(() => false)
    const detail = await response.json().then((body: { error?: unknown }) => body.error, () => undefined)
    throw new Error(typeof detail === 'string' ? detail : `the server answered ${String(response.status)}`)
  }
  return 'on'
}

/**
 * Turn alerts off for this device.
 * @param env - the page's capabilities.
 * @returns `off`. The Host is told first, but a failure there never blocks the local unsubscribe:
 *   a dead endpoint is dropped at the next push.
 */
export async function disable(env: PushEnv): Promise<PushState> {
  const registration = await env.serviceWorker?.getRegistration(scopeOf(env.base))
  const subscription = await registration?.pushManager.getSubscription()
  if (subscription === null || subscription === undefined) return 'off'
  await env.fetch(new URL(UNSUBSCRIBE_ROUTE, env.base).href, credentials({ endpoint: subscription.endpoint })).catch(() => undefined)
  await subscription.unsubscribe()
  return 'off'
}
