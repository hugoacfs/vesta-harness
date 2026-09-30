# @deepseek-ai/dsh-client-ui-vesta-theme

## Summary

`dsh-client-ui-vesta-theme` gives the web client the Vesta ember look: it stacks one alias-token override layer over the built-in palettes through `ctx.theme.overrideTokens` (ground `#07080c`, ember accents `#ffc46b → #ff7847 → #ff4d6d`, Inter / Space Grotesk / JetBrains Mono) and mounts one plugin-owned global sheet with the self-hosted `@font-face` rules and the ambient ground. Both palette modes carry values, so the Appearance preference keeps working; Vesta deployments pin `ui-theme.preference: dark` in `settings.yaml`. The font files live in `apps/web/public/vesta/fonts` (SIL OFL 1.1) and are served at `/vesta/fonts` by the SPA dist server. The package contributes nothing to model requests and is private to the Vesta fork.

## Tokens

`src/client/tokens.ts` is the single source: every `--dsw-alias-*` and `--dsw-specific-*` color the stock client consumes, the two font stacks, and the `--vesta-*` brand tokens (`--vesta-ember-1/2/3`, `--vesta-ember-gradient`, `--vesta-glow`, `--vesta-font-display`) that `dsh-client-ui-vesta-brand` reads. Unloading the plugin removes the layer and the sheet.

## Phone shell

*Proposal branch `pwa-proposal-sonnet`; not yet exercised on a device.*

- **Safe areas.** `apps/web/index.html` sets `viewport-fit=cover` and `vesta.css` pads `body` with `env(safe-area-inset-*)`, so the installed app (which asks for `black-translucent` status-bar text) draws under the notch and home indicator without hiding the header or composer behind them. `html, body, #root` are `height: 100%`, so `#root` shrinks with the padding. All insets are `0` on desktop. `position: fixed` overlays (dialogs, toasts, menus) do not see the padding.
- **On-screen keyboard.** iOS and Android Chrome shrink only the *visual* viewport when the keyboard opens and pan the page to the focused field. `client/viewport.ts` watches `visualViewport` and, while it is at least 120 px shorter than the layout viewport (and not pinch-zoomed), sets `data-vesta-keyboard` and `--vesta-visual-height` on `<html>`; `vesta.css` then sizes the page to that height, drops the bottom inset, and the script pans the page back to the top. It runs only for a coarse (touch) pointer and only where `visualViewport` exists, and clears everything when the keyboard closes or the plugin unloads. The decision is pure (`readViewport`) and `trackViewport` takes its browser objects through `ViewportHost`, so `tests/viewport.spec.ts` covers both without a browser.

- **Touch behaviour.** `html` gets `touch-action: manipulation` (no double-tap zoom or tap delay; pinch-zoom stays), `overscroll-behavior: none` (the installed app no longer rubber-bands as a whole), `-webkit-text-size-adjust: 100%` and no tap highlight. Under `(pointer: coarse)` every editable field (`input` except checkbox/radio/range/button-like types, `textarea`, `select`, `[contenteditable]`) is `font-size: max(16px, 1em)`, because iOS zooms the page on focus below 16px; the composer is a 14px `contenteditable` by default. The rule sits behind `:root :is(...)` so it outranks the components' single-class font sizes without `!important` (an inline style still wins). Checked in headless Chromium with touch emulation and the CDP safe-area override: composer 14→16px, a larger preference stays as is, a read-only `contenteditable` and checkboxes are untouched, mouse browsers are unchanged, body padding follows the insets, and the keyboard attribute sizes `html` and `body` to the published height with no bottom padding.

## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The safe-area padding and the keyboard handling are reasoned from platform behaviour and the repo's CSS, not observed: nothing was run on a phone. The checklist in `deploy/vesta/README.md` lists what to look at (header under the notch, composer above the keyboard, rotating the phone, hardware keyboard, pinch-zoom).
- With the `black-translucent` status bar the status-bar text is always white; in the light palette that is white on a light header. Vesta deployments pin the dark preference.

- The ambient ground renders above content at z-index 0 (the app frame paints an opaque base); it is subtle by design and disabled under `prefers-reduced-transparency`.
- The light palette is a coherent counterpart, not a designed product; Vesta is dark-first.
