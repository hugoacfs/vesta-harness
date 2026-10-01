# @deepseek-ai/dsh-vesta-login

## Summary

`dsh-vesta-login` replaces the launch-token 401 with a login page. A browser without a session is sent to `auth/` under the app's mount, taps one button, and a six-digit code goes to the user's Telegram through the send-only notifier MCP (`ai-telegram-mcp`; the harness never holds the chat id). The code typed back mints the ordinary browser-session cookie through the connection service's fork hook (`issueBrowserSession`), so the app, its RPC and its WebSocket are untouched, and the device stays signed in for the connection row's `cookieMaxAgeDays` (seven days in the Vesta bundle). The launch-token exchange keeps working beside it, for scripts and `vesta-url`.

Who may ask is gated by the tailnet: Tailscale Serve stamps every proxied request with `Tailscale-User-Login`, which the LAN cannot forge because nginx listens only to Serve. With `identities` set, a request without an allowed login cannot ask for a code, see the form, or redeem a code; the page says which login it saw. A code is bound to the browser that asked for it by a short pending cookie, lives five minutes, allows five wrong tries and is spent on use; one identity gets one code per thirty seconds and ten per hour. Nothing model-facing changes: this plugin has no tools and no prompt text.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `label` | `vesta` | The harness name in the page title and the Telegram message (`vesta staging` on staging) |
| `notifyUrl` | `http://127.0.0.1:7335/mcp` | The notifier MCP |
| `tool` | `notify` | Its send tool |
| `identityHeader` | `tailscale-user-login` | The request header carrying the tailnet login |
| `identities` | `[]` | Logins allowed to sign in; empty skips the identity check (anyone who reaches the page may ask) |
| `digits` | `6` | Digits in a code |
| `ttlSeconds` | `300` | How long a code may be redeemed |
| `maxAttempts` | `5` | Wrong tries a code survives |
| `cooldownSeconds` | `30` | Gap between two codes for one identity |
| `hourlyLimit` | `10` | Codes one identity may request per hour |

Routes, under the mount: `GET auth/` (the page), `POST auth/send`, `POST auth/verify`. They are named web routes, so they sit outside the `/api` cookie gate on purpose.

## Verify

`tests/` cover the code desk (lifetime, tries, cooldown, hourly limit, identity binding) and the routes with a fake connection and transport. On a deployment: a fresh browser profile opening the harness lands on `auth/`; the code arrives on Telegram; the right code lands on the app with a `dsh-auth-…` cookie whose `Path` is the mount; a browser without the Tailscale header sees the refusal and gets `403` on `auth/send`.

## Known Limitations and Deferred Work

- Codes and rate limits live in memory: a restart forgets a pending code (the person sends another) and resets the hourly count.
- One recipient: the notifier MCP pins the chat, so a second person cannot receive codes until the notifier learns a second recipient.
- No sign-out: a device stays signed in until the cookie's seven days end; clearing the browser's cookies ends it early.
