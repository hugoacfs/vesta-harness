# @deepseek-ai/dsh-client-ui-vesta-brand

## Summary

This package fills the generic browser-brand slots with the Vesta identity: `sidebar.brand.mark` and `sidebar.brand.name` (the veiled-goddess emblem and the "Vesta Harness" wordmark) and `conversation.hero.brand.mark` (the breathing ember orb that replaces the animated fish), and puts two rows into `sidebar.footer.action`, stacked inside one `vesta-footer` occupant (the sidebar lays its footer occupants out side by side): the `Vesta home` link back to the landing page (icon and label when the sidebar is wide, the icon with a title on the rail; `href="/"`, root-relative so the sub-path `<base href>` does not apply and both `/harness/` and `/harness-staging/` reach the same page) and the phone-alerts toggle described below. The official DeepSeek brand package registers nothing outside official builds, so the two never collide. Colors come from the `--vesta-*` tokens that `dsh-client-ui-vesta-theme` provides, with literal fallbacks. The package retains no runtime state, contributes nothing to model requests, and is private to the Vesta fork. Vesta Harness is built on DeepSeek Harness; the name follows DeepSeek's brand guidelines by not using "DeepSeek Harness" as its own.

## Phone alerts toggle

*Proposal branch `pwa-proposal-sonnet`; not yet exercised on a device.* The bell row under the home link subscribes this browser to Web Push through the routes `dsh-vesta-notify` serves when its `push` channel is on (`GET /api/vesta/notify/push/key`, `POST .../subscribe`, `POST .../unsubscribe`). The flow lives in `push-client.ts`, which takes everything it touches (fetch, service worker, `Notification`) through one `PushEnv` so `tests/push-client.spec.ts` covers it without a browser.

- The row is hidden while the Host is being asked, when the Host runs without the push channel (the key route answers 404 or `enabled: false`), and in a browser without Web Push that is not an iPhone. On an iPhone or iPad in a Safari tab it reads "Add to Home Screen for alerts", because iOS delivers Web Push only to an installed app. When the user has refused notifications it reads "Alerts blocked in Settings". Both are informational and disabled.
- `enable()` asks for notification permission as its **first** asynchronous step: iOS shows the prompt only for a call made during the tap. Then it fetches the key, registers `sw.js` from the document base (scope is the app path, e.g. `/harness/`), waits for the worker to be active, subscribes with the Host's key (replacing a subscription made with an earlier key), and stores it on the Host. If the Host refuses the subscription (for example an endpoint outside its allowlist), the browser-side subscription is removed and the Host's reason is shown as the row's title.
- `disable()` tells the Host, then unsubscribes locally; an unreachable Host never blocks the local unsubscribe (a dead endpoint is dropped at the Host's next push).
- The state is re-read when the page becomes visible again, so allowing notifications in the system Settings shows up on return.

## Model Experience

None, as the package is a browser-side UI plugin that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The toggle component (`NotifyToggle.tsx`) and the stacked footer have no component test: the repo's React testing setup could not be installed where this was written. `push-client.ts` carries the logic and is covered; the row's look on the rail and on a phone is unchecked.
- The phone-alerts toggle shows only once the Host enables `channels: [telegram, push]` for `vesta-notify`; with the default configuration the row never appears.

- The hero mark inherits the hero's geometry class sized for the 34×25 fish; the emblem renders 34×34 inside it.
- Since 2026-09-25 the wordmark suffix reads `staging` when the bundle was built with `DSH_CLIENT_VESTA_ENV=staging` (`vesta-build` on the `staging` branch; every `DSH_CLIENT_*` variable is inlined at build time), `harness` otherwise.
- Since 2026-09-25 the sidebar foot carries the `Vesta home` link (Hugo's ask: a way back to the landing page from the harness and from the vesta-voice page alike); it is a plain anchor, so a running turn keeps running on the host when the tab leaves.
- Since 2026-09-10 the mark is the veiled-goddess emblem (flat, ember palette) and the name is the lowercase `vesta harness` wordmark under one ember gradient with a blinking terminal caret (`_`, hidden from assistive tech, still under `prefers-reduced-motion`); the ambient ground (grain, 44px grid, slow breathe) lives in `ui-vesta-theme`.
