/**
 * Vesta presence heartbeat. While a tab is visible the browser posts
 * `{ visible: true }` to the Host every 30 s (and on every visibility change),
 * so `vesta-notify` can tell an attended harness from an unattended one.
 * Resolved against the document base URI, so a reverse-proxy sub-path works.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** Presence route on the Host, base-relative (no leading slash). */
export const PRESENCE_ROUTE = 'api/vesta/notify/presence'

/** Heartbeat period while a tab is visible. */
export const HEARTBEAT_MS = 30_000

/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
function hostBase(): string {
  const doc = (globalThis as { document?: { baseURI?: string } }).document
  if (typeof doc?.baseURI === 'string' && doc.baseURI !== '') return doc.baseURI
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

/**
 * Post one heartbeat; failures are silent (the notifier just sees the user as away).
 * @param visible - whether the tab is currently visible.
 */
function beat(visible: boolean): void {
  void fetch(new URL(PRESENCE_ROUTE, hostBase()), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visible }),
  }).catch(() => undefined)
}

/**
 * Start the heartbeat for the plugin lifetime.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const doc = (globalThis as { document?: Document }).document
    if (doc === undefined) return () => {}
    const tick = (): void => { beat(doc.visibilityState === 'visible') }
    tick()
    const timer = setInterval(tick, HEARTBEAT_MS)
    doc.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      doc.removeEventListener('visibilitychange', tick)
    }
  }, 'ui-vesta-presence: heartbeat')
}
