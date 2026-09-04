import clsx from 'clsx'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createVoiceCallStore } from './store.ts'
import { MicGlyph } from './icons.tsx'
import css from './Voice.module.css'

/** Injected business face of the mic button. */
export interface MicButtonInjected {
  /** Start a call for this Session (ends a call in another Session first). */
  start: () => Promise<void>
  /** End the active call. */
  end: () => Promise<void>
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type MicButtonProps =
  PropsRuntime<'conversation.input.right'> & PropsStore<ReturnType<typeof createVoiceCallStore>>
  & PropsLocale<'vesta.voice'> & MicButtonInjected

/**
 * Render the composer mic control: starts a call for the Session it sits in,
 * ends it while that Session owns the active call.
 * @param props - composed slot props.
 * @returns the button.
 */
export function MicButton({ t, sessionId, useStore, start, end }: MicButtonProps) {
  const status = useStore(s => s.status)
  const owner = useStore(s => s.sessionId)
  const mine = owner !== null && owner === String(sessionId)
  const live = mine && (status === 'live' || status === 'connecting')
  const busyElsewhere = !mine && owner !== null && status !== 'idle'
  const label = live ? t('mic.stop') : busyElsewhere ? t('mic.busy') : t('mic.start')
  return (
    <button
      type="button"
      className={clsx(css.mic, live && css.live)}
      aria-label={label}
      title={label}
      aria-pressed={live}
      disabled={busyElsewhere}
      onClick={() => { void (live ? end() : start()) }}
    >
      <MicGlyph />
    </button>
  )
}
