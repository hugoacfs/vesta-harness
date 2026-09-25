import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { VestaMark } from './VestaMark.tsx'
import css from './Brand.module.css'

/**
 * Render the Vesta mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the ember orb.
 */
export function VestaBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <VestaMark size={size} className={css.orb} />
}

/**
 * The instance this bundle was built for, inlined by vesta-build (`DSH_CLIENT_VESTA_ENV`,
 * 2026-09-25): the staging wordmark reads "vesta staging" so the two harnesses are told
 * apart at a glance; anything else reads "vesta harness".
 */
const INSTANCE = process.env.DSH_CLIENT_VESTA_ENV

/** Name occupant props: the locale seat only (the owner passes no data). */
export type VestaBrandNameProps = PropsLocale<'brand.vesta'>

/**
 * Render the Vesta name: the ember-gradient wordmark followed by the product suffix.
 * @param props - composed slot props.
 * @returns the name element.
 */
export function VestaBrandName({ t }: VestaBrandNameProps) {
  return (
    <span className={css.name}>
      <span className={css.word}>{t('brand.name')}</span>
      <span className={css.suffix}>{t(INSTANCE === 'staging' ? 'brand.suffix.staging' : 'brand.suffix')}</span>
      <span className={css.caret} aria-hidden="true">_</span>
    </span>
  )
}
