/**
 * Vesta routines panel: an entry in the sidebar's global panel list and the
 * matching main-column panel (scheduled jobs, next and last run, run now,
 * pause, open the last run's session). Data comes from the `dsh-vesta-routines`
 * host routes.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the locale service, the slot registry, and the slots we fill.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ClockIcon } from './ClockIcon.tsx'
import { RoutinesPanel } from './RoutinesPanel.tsx'
import type { RoutinesInjected } from './RoutinesPanel.tsx'
import { en, ROUTINES_NS, zh, type RoutinesKey } from './locales.ts'

export type { RoutinesInjected, RoutinesPanelProps } from './RoutinesPanel.tsx'
export type { RoutinesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The routines panel copy. */
    'vesta.routines': RoutinesKey
  }
}

/** Navigation face of the workspace UI service (`uiWorkspace`). */
interface WorkspaceNavigationFace {
  openSession(sessionId: SessionId): void
}

/** The main-panel id the panel-list entry addresses. */
export const PANEL_ID = 'vesta-routines' as MainPanelId

/** Required services: the UI slot registry, the locale dictionaries, the layout (to return to the conversation). */
export const inject = ['slots', 'locale', 'layout']

/**
 * Register the panel-list icon and the main panel.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(ROUTINES_NS, { zh, en }), 'ui-vesta-routines: dictionaries')
  const t = ctx.locale.bind(ROUTINES_NS)
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 70,
    label: () => t('panel.label'),
  }, ClockIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: ROUTINES_NS,
    inject: (): RoutinesInjected => ({
      open: (sessionId) => {
        const navigation = ctx.get('uiWorkspace') as unknown as WorkspaceNavigationFace | undefined
        navigation?.openSession(sessionId as SessionId)
        ctx.layout.selectPanel(null)
      },
    }),
  }, RoutinesPanel))
}
