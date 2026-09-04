# @deepseek-ai/dsh-client-ui-vesta-brand

## Summary

This package fills the generic browser-brand slots with the Vesta identity: `sidebar.brand.mark` and `sidebar.brand.name` (the ember orb and the "Vesta Harness" wordmark) and `conversation.hero.brand.mark` (the breathing ember orb that replaces the animated fish). The official DeepSeek brand package registers nothing outside official builds, so the two never collide. Colors come from the `--vesta-*` tokens that `dsh-client-ui-vesta-theme` provides, with literal fallbacks. The package retains no runtime state, contributes nothing to model requests, and is private to the Vesta fork. Vesta Harness is built on DeepSeek Harness; the name follows DeepSeek's brand guidelines by not using "DeepSeek Harness" as its own.

## Model Experience

None, as the package is a browser-side UI plugin that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- The hero orb inherits the hero's geometry class sized for the 34×25 fish; the orb renders 34×34 inside it.
