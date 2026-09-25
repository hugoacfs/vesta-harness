import clsx from 'clsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './HomeLink.module.css'

/** Home-link occupant props: the foot's column state plus the brand locale seat. */
export type VestaHomeLinkProps = SidebarFooterActionOwnerProps & PropsLocale<'brand.vesta'>

/**
 * The landing page is the site root of the host that serves the harness:
 * `/harness/` and `/harness-staging/` both hang off it. Root-relative, so the
 * `<base href>` a sub-path build emits does not apply.
 */
const HOME_HREF = '/'

/** A small house, drawn like the 16px outline icons. */
function HouseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={css.icon} aria-hidden="true">
      <path
        d="M2.5 7.5 8 3l5.5 4.5M4 6.8V13a.5.5 0 0 0 .5.5h2.25V10h2.5v3.5h2.25A.5.5 0 0 0 12 13V6.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Render the "Vesta home" link at the sidebar foot: icon and label when the
 * column is wide, the icon alone with a native title on the 56px rail.
 * @param props - the foot's column state plus the locale seat.
 * @returns the anchor back to the landing page.
 */
export function VestaHomeLink({ wide, t }: VestaHomeLinkProps) {
  const label = t('home.label')
  return (
    <a
      className={clsx(css.link, !wide && css.rail)}
      href={HOME_HREF}
      aria-label={label}
      title={wide ? undefined : label}
    >
      <HouseIcon />
      {wide && <span className={css.label}>{label}</span>}
    </a>
  )
}
