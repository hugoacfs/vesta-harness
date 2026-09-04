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
      <span className={css.suffix}>{t('brand.suffix')}</span>
    </span>
  )
}
