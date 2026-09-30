import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { BrandKey } from './locales.ts'
import { detectEnv, disable, enable, readState } from './push-client.ts'
import type { PushState } from './push-client.ts'
import css from './NotifyToggle.module.css'

/** Toggle occupant props: the foot's column state plus the brand locale seat. */
export type VestaNotifyToggleProps = SidebarFooterActionOwnerProps & PropsLocale<'brand.vesta'>

/** A bell; `off` draws the slash across it. */
function BellIcon({ off }: { off: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={css.icon} aria-hidden="true">
      <path
        d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3L4 11ZM6.5 14a1.5 1.5 0 0 0 3 0"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {off && <path d="M2.5 2.5 13.5 13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
    </svg>
  )
}

/** The copy for a state that shows a row. */
function labelFor(state: PushState): BrandKey {
  switch (state) {
    case 'on': return 'notify.on'
    case 'needs-install': return 'notify.install'
    case 'blocked': return 'notify.blocked'
    default: return 'notify.off'
  }
}

/**
 * Render the phone-alerts toggle at the sidebar foot. It shows nothing while the
 * Host is being asked, when the Host runs without the push channel, and in a
 * browser that cannot do Web Push; an iPhone in a browser tab gets a hint to
 * install the app instead, since push exists only there.
 * @param props - the foot's column state plus the locale seat.
 * @returns the toggle row, or nothing.
 */
export function VestaNotifyToggle({ wide, t }: VestaNotifyToggleProps) {
  const env = useMemo(() => detectEnv(), [])
  const [state, setState] = useState<PushState>('loading')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (env === undefined) {
      setState('unsupported')
      return undefined
    }
    let live = true
    const refresh = () => {
      readState(env).then(
        (next) => { if (live) setState(next) },
        () => { if (live) setState('unavailable') },
      )
    }
    refresh()
    // Coming back from the system Settings (where notifications may have been allowed or refused).
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [env])

  if (env === undefined || state === 'loading' || state === 'unavailable' || state === 'unsupported') return null

  const informational = state === 'needs-install' || state === 'blocked'
  const label = failure === undefined ? t(labelFor(state)) : t('notify.failed')

  const toggle = () => {
    if (busy || informational) return
    setBusy(true)
    setFailure(undefined)
    // enable() asks for permission as its first step, so it must be called directly from the tap.
    const run = state === 'on' ? disable(env) : enable(env)
    run.then(
      (next) => { setState(next) },
      (error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error))
        return readState(env).then(setState, () => undefined)
      },
    ).finally(() => { setBusy(false) })
  }

  return (
    <button
      type="button"
      className={clsx(css.toggle, !wide && css.rail, state === 'on' && css.on, informational && css.note, busy && css.busy)}
      onClick={toggle}
      disabled={informational}
      aria-pressed={informational ? undefined : state === 'on'}
      aria-busy={busy || undefined}
      aria-label={label}
      title={failure ?? (wide ? undefined : label)}
    >
      <BellIcon off={state !== 'on'} />
      {wide && <span className={css.label}>{label}</span>}
    </button>
  )
}
