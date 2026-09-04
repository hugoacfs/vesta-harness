/**
 * Vesta ember theme, browser half. Stacks the ember alias-token layer over the
 * built-in light/dark palettes through `ctx.theme.overrideTokens` (the token
 * analogue of slot shading: the base sheets stay untouched and unloading the
 * plugin restores them) and mounts one plugin-owned global sheet carrying the
 * self-hosted `@font-face` rules and the ambient ground.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ThemeRuntime Context merge (ctx.theme).
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { installVestaStyles } from './styles.ts'
import { VESTA_TOKENS } from './tokens.ts'

export type { VestaTokenName } from './tokens.ts'

/** Override-layer source id: one layer per plugin, replaced on re-apply. */
export const LAYER_SOURCE = '@deepseek-ai/dsh-client-ui-vesta-theme'

/** Required service: the theme registry the override layer stacks onto. */
export const inject = ['theme']

/**
 * Client plugin body: mount the global sheet, then stack the ember layer.
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  installVestaStyles(ctx)
  ctx.effect(() => ctx.theme.overrideTokens(LAYER_SOURCE, VESTA_TOKENS), 'ui-vesta-theme: ember token layer')
}
