import clsx from 'clsx'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { VestaMark } from './VestaMark.tsx'
import css from './Brand.module.css'

/**
 * The hero orb: the ember mark breathing in place (a slow scale + glow cycle;
 * static under reduced motion). Decorative — hidden from the accessibility tree.
 * @param props - Host-supplied size and geometry class.
 * @returns the animated orb.
 */
export function VestaHeroMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <VestaMark size={size} className={clsx(css.heroOrb, className)} />
}
