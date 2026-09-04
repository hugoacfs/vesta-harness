/** Vesta Harness occupants for the generic browser-brand slots. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots) and the slot declarations.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { VestaBrandMark, VestaBrandName } from './Brand.tsx'
import { VestaHeroMark } from './HeroMark.tsx'
import { BRAND_NS, en, zh, type BrandKey } from './locales.ts'

export type { VestaBrandNameProps } from './Brand.tsx'
export type { BrandKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The brand occupants' copy. */
    'brand.vesta': BrandKey
  }
}

/** Required services: the UI slot registry and the locale dictionaries. */
export const inject = ['slots', 'locale']

/**
 * Fill the sidebar brand slots as one declaration-aware registration set and
 * replace the conversation hero's fallback fish with the ember orb.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(BRAND_NS, { zh, en }), 'ui-vesta-brand: dictionaries')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, VestaBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', locale: BRAND_NS }, VestaBrandName)
    }))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, VestaHeroMark))
}
