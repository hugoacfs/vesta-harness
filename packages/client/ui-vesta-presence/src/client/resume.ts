/**
 * Reconnect when a backgrounded tab comes back.
 *
 * A phone suspends a backgrounded page and its WebSocket with it; on return the
 * socket is often dead without the page having been told (no `online` event
 * fires, the connection may still read `connected`), or the loop is sitting in a
 * backoff wait of up to tens of seconds. The Connection service already handles
 * `online`/`offline`; this covers the resume. The decision ({@link shouldReconnect})
 * is pure and {@link watchResume} takes the page's objects through
 * {@link ResumeHost}, so both run under test.
 */
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'

/**
 * How long a tab must have been hidden before a socket that still reads
 * `connected` is replaced. Shorter than this the socket is almost certainly
 * fine, and replacing a healthy one interrupts any stream in flight.
 */
export const STALE_AFTER_MS = 15_000

/** Resume signals closer together than this are one resume (visibilitychange and pageshow arrive together). */
export const DEDUPE_MS = 1_000

/** What {@link shouldReconnect} decides from. */
export interface ResumeInput {
  /** The Connection service's state, undefined before its first outcome. */
  readonly state: ConnectionState | undefined
  /** How long the page was hidden, in ms (0 when unknown). */
  readonly hiddenMs: number
  /** `navigator.onLine`. */
  readonly online: boolean
}

/**
 * Decide whether a resumed page should replace its connection now.
 * @param input - the connection state, the time hidden and the network flag.
 * @returns true to call `connection.reconnect()`.
 */
export function shouldReconnect(input: ResumeInput): boolean {
  // Offline: the Connection service restarts on the `online` event; an attempt now would only fail.
  if (!input.online) return false
  switch (input.state) {
    // No outcome yet, so the loop has nothing to replace.
    case undefined: return false
    // In a retry or a backoff wait: go now instead of waiting it out.
    case 'connecting':
    case 'disconnected': return true
    // Looks healthy, but the socket may have died while the page was suspended.
    case 'connected': return input.hiddenMs >= STALE_AFTER_MS
  }
}

/** The parts of the page {@link watchResume} listens to and reads. */
export interface ResumeHost {
  readonly document: {
    readonly visibilityState: string
    addEventListener(type: 'visibilitychange', listener: () => void): void
    removeEventListener(type: 'visibilitychange', listener: () => void): void
  }
  readonly window: {
    addEventListener(type: 'pageshow' | 'pagehide', listener: (event: { readonly persisted: boolean }) => void): void
    removeEventListener(type: 'pageshow' | 'pagehide', listener: (event: { readonly persisted: boolean }) => void): void
  }
  /** Wall-clock time in ms: it keeps counting while the page is suspended, which a timer does not. */
  now(): number
  /** `navigator.onLine`. */
  online(): boolean
  /** The Connection service's current state. */
  state(): ConnectionState | undefined
  /** `connection.reconnect()`. */
  reconnect(): void
}

/**
 * Read the host from the page.
 * @param state - reads the Connection service's state.
 * @param reconnect - `connection.reconnect()`.
 * @returns the host, or undefined without a window (server rendering, tests).
 */
export function browserHost(state: () => ConnectionState | undefined, reconnect: () => void): ResumeHost | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined
  return {
    document,
    window,
    now: () => Date.now(),
    online: () => navigator.onLine,
    state,
    reconnect,
  }
}

/**
 * Reconnect when the page becomes visible again after being hidden long enough
 * for its socket to have died, or at once if the connection was not healthy.
 * @param host - the page's objects.
 * @returns a function that stops watching.
 */
export function watchResume(host: ResumeHost): () => void {
  let hiddenAt: number | undefined
  let handledAt: number | undefined

  const hide = (): void => {
    hiddenAt ??= host.now()
  }
  const resume = (): void => {
    const at = host.now()
    const hiddenMs = hiddenAt === undefined ? 0 : at - hiddenAt
    hiddenAt = undefined
    if (handledAt !== undefined && at - handledAt < DEDUPE_MS) return
    handledAt = at
    if (shouldReconnect({ state: host.state(), hiddenMs, online: host.online() })) host.reconnect()
  }
  const onVisibility = (): void => {
    if (host.document.visibilityState === 'visible') resume()
    else hide()
  }
  const onPageHide = (): void => { hide() }
  const onPageShow = (event: { readonly persisted: boolean }): void => {
    // A restore from the back-forward cache; an ordinary load has nothing to resume.
    if (event.persisted) resume()
  }

  host.document.addEventListener('visibilitychange', onVisibility)
  host.window.addEventListener('pagehide', onPageHide)
  host.window.addEventListener('pageshow', onPageShow)
  return () => {
    host.document.removeEventListener('visibilitychange', onVisibility)
    host.window.removeEventListener('pagehide', onPageHide)
    host.window.removeEventListener('pageshow', onPageShow)
  }
}
