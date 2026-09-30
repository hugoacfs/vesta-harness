# @deepseek-ai/dsh-client-ui-vesta-presence

## Summary

`dsh-client-ui-vesta-presence` is the browser half of the Vesta notifier (and reconnects a tab resumed from the background; see below). While a tab is visible it posts `{ "visible": true }` to `POST api/vesta/notify/presence` (base-relative, so the reverse-proxy sub-path is honoured) every 30 s and on every `visibilitychange`; a hidden tab posts `{ "visible": false }`. `dsh-vesta-notify` on the Host treats the absence of a visible heartbeat for its `awayAfterSeconds` as "the user is away". No services, no UI, no configuration. The package is private to the Vesta fork.

## Reconnect on resume

*Proposal branch `pwa-proposal-sonnet`; not yet exercised on a device.* The Connection service already restarts its loop on the browser's `online` event, but a phone that suspends a backgrounded tab gets neither that event nor a close notice for the socket it froze, so on return the connection may still read `connected` while dead, or sit in a backoff wait. `src/client/resume.ts` watches `visibilitychange` (and `pageshow` for a back-forward-cache restore), remembers when the page was hidden, and on return calls `connection.reconnect()` when:

- the connection is `connecting` or `disconnected` (go now instead of waiting out the backoff), or
- it reads `connected` but the page was hidden for at least 15 s (`STALE_AFTER_MS`); a shorter look away leaves a healthy socket alone, because replacing one interrupts a stream in flight and the streams then resume from their cursors.

It does nothing while `navigator.onLine` is false (the `online` event restarts the loop) or before the loop has produced a first state, and it counts `visibilitychange` and `pageshow` arriving together as one resume. The decision (`shouldReconnect`) is pure and `watchResume` takes the page's objects through `ResumeHost`; `tests/resume.spec.ts` covers both. The package now depends on `dsh-client-connection` (service `connection`).
