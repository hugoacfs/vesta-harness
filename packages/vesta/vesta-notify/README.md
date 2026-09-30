# @deepseek-ai/dsh-vesta-notify

## Summary

`dsh-vesta-notify` pings the user on Telegram when something worth a glance happens while no browser tab is looking at the harness. Delivery goes through the send-only notifier MCP (`ai-telegram-mcp`, loopback `127.0.0.1:7335`, tool `notify`): the harness posts a stateless streamable-HTTP `tools/call`; the recipient is pinned server-side and the bot token never reaches the harness. Two triggers: a turn that ran at least `minTurnSeconds` finished (`turn/end` on the Session's durable log; the message carries the first line of the reply), and an approval or ask-user question has waited `approvalWaitSeconds` for a decision (passive observers at the front of the `approval/request` and `user-questions/request` waterfalls: they record, call the rest of the chain, and forget when it settles). Presence comes from `ui-vesta-presence`, which posts `{ visible }` to `POST /api/vesta/notify/presence` every 30 s while a tab is visible; no visible heartbeat for `awayAfterSeconds` means away, and with `onlyWhenAway` (the default) nothing is sent while a tab is watching. `cooldownSeconds` caps one message per Session and trigger; `quietHours` (`HH:MM-HH:MM`, local time, may wrap midnight) silences the notifier.

Since the phone-hardening work it can also deliver as a **Web Push** notification (channel `push`, off by default), so a phone that installed the harness to its home screen gets a banner that opens the app. Both channels share every gate above (away, cooldown, quiet hours, excluded presets); only the delivery differs. The package is private to the Vesta fork.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `url` | `http://127.0.0.1:7335/mcp` | notifier MCP endpoint |
| `tool` | `notify` | tool to call |
| `minTurnSeconds` | `120` | report finished turns at least this long |
| `approvalWaitSeconds` | `60` | report approvals / questions waiting this long |
| `cooldownSeconds` | `300` | minimum gap per Session and trigger |
| `awayAfterSeconds` | `90` | no visible heartbeat for this long = away |
| `onlyWhenAway` | `true` | report only while away |
| `quietHours` | `''` | `HH:MM-HH:MM` local window with no messages |
| `silent` | `false` | deliver without sound |
| `linkBase` | `''` | link appended to every message; the tap target of a push notification |
| `channels` | `['telegram']` | `telegram`, `push`, or both; an unknown name fails the plugin at load |
| `push.subject` | `''` | VAPID contact URL, `https:` or `mailto:`; empty uses `linkBase` when that is https (Apple refuses other subjects). Use a URL, not a personal address: the value is sent to the push service |
| `push.storeFile` | `''` | JSON file (0600) holding the VAPID key pair and subscriptions; empty = `$DSH_HOME/vesta-push.json` |
| `push.allowedHosts` | Apple, Google, Mozilla, Windows push services | host suffixes a subscription endpoint may use; anything else is refused, so a subscribe request cannot make the harness POST to an arbitrary URL |
| `push.ttlSeconds` | `3600` | how long a push service may hold a message for an offline device |

## Verify

`docker logs ai-telegram-mcp` shows the delivery; the harness journal does not carry plugin logs. A scripted check: create a session, prompt a turn that runs longer than the threshold (for example a `sleep 150` through the shell tool) with every tab closed, and expect one message.

## Web Push

Enable it by adding `push` to `channels` in the bundle row (`packages/bundle/vesta-app/cordis.patch.yml`). On first start the plugin creates `push.storeFile` with a fresh VAPID key pair; keep that file (deleting it drops every subscription and the browsers must subscribe again). Delivery uses Node's built-in `crypto` only: RFC 8291 `aes128gcm` message encryption and RFC 8292 VAPID, checked in `tests/push.spec.ts` against the RFC 8291 section 5 example message byte for byte. Nothing was added to the lockfile for it; replacing `sendPush` with the `web-push` package later touches only `src/push.ts`.

Routes (cookie-authenticated like the presence route; the browser half is `ui-vesta-brand`'s sidebar toggle):

| Route | Body | Answer |
|---|---|---|
| `GET /api/vesta/notify/push/key` | none | `{ enabled: true, publicKey }`, the `applicationServerKey`; 404 while the channel is off |
| `POST /api/vesta/notify/push/subscribe` | `PushSubscription.toJSON()` | `{ ok, devices }`; 400 with a reason for a bad endpoint host or keys |
| `POST /api/vesta/notify/push/unsubscribe` | `{ endpoint }` | `{ ok, devices }` |

A device the push service answers 404 or 410 for is dropped from the store; any other failure keeps it. The store holds at most 20 devices (the oldest go first). iOS delivers Web Push only to an app installed to the home screen (iOS 16.4 or later), and only after the user grants permission from a tap. Every push must show a notification on iOS, so suppressing pings while a tab is open is decided here (presence), never in the service worker.

Verify without a phone: `pnpm exec vitest run packages/vesta/vesta-notify` covers the encryption vector, the store, the routes and the plugin wiring. With a device: subscribe from the sidebar toggle, then run the `sleep 150` check above with every tab closed and expect one banner; `journalctl` does not carry plugin logs, so read the session log or the store file (`subscriptions` should list the device).
