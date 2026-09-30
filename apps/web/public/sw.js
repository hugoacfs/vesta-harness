/*
 * Vesta service worker: Web Push and nothing else.
 *
 * There is deliberately no `fetch` handler. The app's assets are content-hashed
 * and the page needs the live Host anyway, so caching here would only add a
 * stale-shell failure mode. The worker exists because iOS (16.4+) and Android
 * deliver Web Push only through a registered service worker.
 *
 * It is served from the app's base path (`/harness/sw.js`), so its default scope
 * is the app itself and it sees only this deployment's notifications.
 *
 * Message shape (from dsh-vesta-notify): { title, body, url, tag }.
 * iOS requires every push to show a notification; this worker always does.
 */
'use strict'

const FALLBACK_TITLE = 'vesta'

/**
 * Read what the Host sent; a malformed or empty push still shows something.
 * @param {PushEvent} event
 * @returns {{ title: string, body: string, url: string, tag: string | undefined }}
 */
function readMessage(event) {
  let data = {}
  if (event.data) {
    try {
      data = event.data.json()
    } catch {
      data = { body: event.data.text() }
    }
  }
  const text = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback)
  return {
    title: text(data.title, FALLBACK_TITLE),
    body: text(data.body, ''),
    url: text(data.url, ''),
    tag: typeof data.tag === 'string' && data.tag !== '' ? data.tag : undefined,
  }
}

/**
 * The page a tap opens: the message's URL when it lies inside the app, else the app's start page.
 * @param {string} url
 * @returns {string}
 */
function targetFor(url) {
  const scope = self.registration.scope
  if (url === '') return scope
  try {
    const target = new URL(url, scope)
    return target.href.startsWith(scope) ? target.href : scope
  } catch {
    return scope
  }
}

/** Show the count of delivered notifications on the app icon, where the platform supports it. */
async function syncBadge() {
  const nav = self.navigator
  if (!nav || typeof nav.setAppBadge !== 'function') return
  try {
    const count = (await self.registration.getNotifications()).length
    if (count > 0) await nav.setAppBadge(count)
    else await nav.clearAppBadge()
  } catch {
    // The badge is decoration; a platform that refuses it must not break the notification.
  }
}

self.addEventListener('install', () => {
  void self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', event => {
  const message = readMessage(event)
  const options = {
    body: message.body,
    icon: new URL('apple-touch-icon.png', self.registration.scope).href,
    data: { url: message.url },
  }
  if (message.tag !== undefined) options.tag = message.tag
  event.waitUntil(
    self.registration.showNotification(message.title, options).then(syncBadge),
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const target = targetFor(event.notification.data && event.notification.data.url ? event.notification.data.url : '')
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = windows.find(client => client.url.startsWith(self.registration.scope))
    if (open && typeof open.focus === 'function') await open.focus()
    else await self.clients.openWindow(target)
    await syncBadge()
  })())
})
