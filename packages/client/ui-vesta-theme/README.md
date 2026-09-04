# @deepseek-ai/dsh-client-ui-vesta-theme

## Summary

`dsh-client-ui-vesta-theme` gives the web client the Vesta ember look: it stacks one alias-token override layer over the built-in palettes through `ctx.theme.overrideTokens` (ground `#07080c`, ember accents `#ffc46b → #ff7847 → #ff4d6d`, Inter / Space Grotesk / JetBrains Mono) and mounts one plugin-owned global sheet with the self-hosted `@font-face` rules and the ambient ground. Both palette modes carry values, so the Appearance preference keeps working; Vesta deployments pin `ui-theme.preference: dark` in `settings.yaml`. The font files live in `apps/web/public/vesta/fonts` (SIL OFL 1.1) and are served at `/vesta/fonts` by the SPA dist server. The package contributes nothing to model requests and is private to the Vesta fork.

## Tokens

`src/client/tokens.ts` is the single source: every `--dsw-alias-*` and `--dsw-specific-*` color the stock client consumes, the two font stacks, and the `--vesta-*` brand tokens (`--vesta-ember-1/2/3`, `--vesta-ember-gradient`, `--vesta-glow`, `--vesta-font-display`) that `dsh-client-ui-vesta-brand` reads. Unloading the plugin removes the layer and the sheet.

## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The ambient ground renders above content at z-index 0 (the app frame paints an opaque base); it is subtle by design and disabled under `prefers-reduced-transparency`.
- The light palette is a coherent counterpart, not a designed product; Vesta is dark-first.
