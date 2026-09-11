/**
 * Vesta archived-sessions panel: an entry in the sidebar's global panel list and
 * the matching main-column panel (restore, download the log, delete for good).
 * Data comes from the `dsh-vesta-sessions` host routes.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the locale service, the slot registry, and the slots we fill.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ArchivedPanel } from './ArchivedPanel.tsx'
import { ArchiveIcon } from './ArchiveIcon.tsx'
import { en, SESSIONS_NS, zh, type SessionsKey } from './locales.ts'

export type { ArchivedPanelProps } from './ArchivedPanel.tsx'
export type { SessionsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The archived-sessions panel copy. */
    'vesta.sessions': SessionsKey
  }
}

/** The main-panel id the panel-list entry addresses. */
export const PANEL_ID = 'vesta-archived' as MainPanelId

/** Required services: the UI slot registry and the locale dictionaries. */
export const inject = ['slots', 'locale']

/**
 * Register the panel-list icon and the main panel.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(SESSIONS_NS, { zh, en }), 'ui-vesta-sessions: dictionaries')
  const t = ctx.locale.bind(SESSIONS_NS)
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 60,
    label: () => t('panel.label'),
  }, ArchiveIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: SESSIONS_NS,
  }, ArchivedPanel))
}
