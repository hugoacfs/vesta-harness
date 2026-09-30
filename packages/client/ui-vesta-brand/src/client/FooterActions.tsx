import clsx from 'clsx'
import { VestaHomeLink } from './HomeLink.tsx'
import type { VestaHomeLinkProps } from './HomeLink.tsx'
import { VestaNotifyToggle } from './NotifyToggle.tsx'
import css from './FooterActions.module.css'

/** Footer occupant props: the foot's column state plus the brand locale seat. */
export type VestaFooterActionsProps = VestaHomeLinkProps

/**
 * The Vesta rows at the sidebar foot, stacked: the link back to the landing
 * page, then the phone-alerts toggle. The sidebar lays its footer occupants
 * out side by side, so the two share one occupant that owns the stacking.
 * @param props - the foot's column state plus the locale seat.
 * @returns the stacked rows.
 */
export function VestaFooterActions(props: VestaFooterActionsProps) {
  return (
    <div className={clsx(css.stack, !props.wide && css.rail)}>
      <VestaHomeLink {...props} />
      <VestaNotifyToggle {...props} />
    </div>
  )
}
