# @deepseek-ai/dsh-client-ui-vesta-presence

## Summary

`dsh-client-ui-vesta-presence` is the browser half of the Vesta notifier. While a tab is visible it posts `{ "visible": true }` to `POST api/vesta/notify/presence` (base-relative, so the reverse-proxy sub-path is honoured) every 30 s and on every `visibilitychange`; a hidden tab posts `{ "visible": false }`. `dsh-vesta-notify` on the Host treats the absence of a visible heartbeat for its `awayAfterSeconds` as "the user is away". No services, no UI, no configuration. The package is private to the Vesta fork.
