import clsx from 'clsx'
import type { CSSProperties } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AgentState, CallStatus, createVoiceCallStore } from './store.ts'
import type { VoiceKey } from './locales.ts'
import { EndGlyph, HeartGlyph, MicGlyph, MicOffGlyph } from './icons.tsx'
import css from './Voice.module.css'

/** Injected business face of the call HUD. */
export interface CallHudInjected {
  /** End the active call. */
  end: () => Promise<void>
  /** Toggle the local microphone. */
  toggleMute: () => Promise<void>
  /** Flip the STT sidecar's perception flag. */
  setEmotion: (enabled: boolean) => Promise<void>
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type CallHudProps =
  PropsRuntime<'conversation.input.overlay'> & PropsStore<ReturnType<typeof createVoiceCallStore>>
  & PropsLocale<'vesta.voice'> & CallHudInjected

function stateKey(status: CallStatus, agentState: AgentState): VoiceKey {
  if (status === 'connecting') return 'hud.connecting'
  if (status === 'error') return 'hud.error'
  switch (agentState) {
    case 'initializing': return 'hud.initializing'
    case 'listening': return 'hud.listening'
    case 'thinking': return 'hud.thinking'
    case 'speaking': return 'hud.speaking'
    default: return 'hud.idle'
  }
}

/**
 * Render the call HUD above the composer while this Session owns a call:
 * the ember orb driven by the agent's audio level, the state label, and the
 * mute, perception, and end controls.
 * @param props - composed slot props.
 * @returns the HUD, or null when this Session has no call.
 */
export function CallHud({ t, sessionId, useStore, end, toggleMute, setEmotion }: CallHudProps) {
  const owner = useStore(s => s.sessionId)
  const status = useStore(s => s.status)
  const agentState = useStore(s => s.agentState)
  const muted = useStore(s => s.muted)
  const emotion = useStore(s => s.emotion)
  const emotionAvailable = useStore(s => s.emotionAvailable)
  const level = useStore(s => s.level)
  const error = useStore(s => s.error)
  if (owner === null || owner !== String(sessionId) || status === 'idle') return null
  const orbStyle = { '--vesta-orb-level': String(agentState === 'speaking' ? level : 0) } as CSSProperties
  return (
    <div className={css.hud} role="status" aria-live="polite">
      <div className={css.orbWrap}>
        <div
          className={clsx(css.orb, agentState === 'thinking' && css.thinking, agentState === 'listening' && css.listening)}
          style={orbStyle}
        />
      </div>
      <div className={css.state}>
        <span className={css.stateLabel}>{t(stateKey(status, agentState))}</span>
        {status === 'error' && error !== null
          ? <span className={clsx(css.stateHint, css.stateError)}>{error}</span>
          : <span className={css.stateHint}>{emotionAvailable ? t(emotion ? 'hud.emotionOn' : 'hud.emotionOff') : ''}</span>}
      </div>
      <div className={css.actions}>
        <button
          type="button"
          className={clsx(css.action, muted && css.muted)}
          aria-label={muted ? t('hud.unmute') : t('hud.mute')}
          title={muted ? t('hud.unmute') : t('hud.mute')}
          aria-pressed={muted}
          onClick={() => { void toggleMute() }}
        >
          {muted ? <MicOffGlyph size={16} /> : <MicGlyph size={16} />}
        </button>
        {emotionAvailable && (
          <button
            type="button"
            className={clsx(css.action, emotion && css.active)}
            aria-label={t(emotion ? 'hud.emotionOn' : 'hud.emotionOff')}
            title={t(emotion ? 'hud.emotionOn' : 'hud.emotionOff')}
            aria-pressed={emotion}
            onClick={() => { void setEmotion(!emotion) }}
          >
            <HeartGlyph />
          </button>
        )}
        <button
          type="button"
          className={clsx(css.action, css.end)}
          aria-label={t('hud.end')}
          title={t('hud.end')}
          onClick={() => { void end() }}
        >
          <EndGlyph />
        </button>
      </div>
    </div>
  )
}
