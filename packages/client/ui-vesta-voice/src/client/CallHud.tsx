import clsx from 'clsx'
import { useState, type CSSProperties } from 'react'
import { IconChevronDownOutline14, Menu, Tooltip, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
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
  /** Capture from another microphone. */
  selectDevice: (deviceId: string) => Promise<void>
  /** Flip the STT sidecar's perception flag. */
  setEmotion: (enabled: boolean) => Promise<void>
}

/** Full component props: runtime share (dock owner values) + store share + locale seat + injected face. */
export type CallHudProps =
  PropsRuntime<'conversation.input.dock'> & PropsStore<ReturnType<typeof createVoiceCallStore>>
  & PropsLocale<'vesta.voice'> & CallHudInjected

const METER_STEPS = [0.04, 0.12, 0.24, 0.4, 0.6] as const

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
 * Render the call HUD in the input dock while this Session owns a call: the
 * ember orb driven by the agent's audio level, the state label, the
 * microphone being captured (with a meter of what it hears and a picker), and
 * the mute, perception, and end controls. In-flow, so the transcript shrinks
 * above it rather than being covered.
 * @param props - composed slot props.
 * @returns the HUD, or null when this Session has no call.
 */
export function CallHud({ t, sessionId, useStore, end, toggleMute, selectDevice, setEmotion }: CallHudProps) {
  const owner = useStore(s => s.sessionId)
  const status = useStore(s => s.status)
  const agentState = useStore(s => s.agentState)
  const muted = useStore(s => s.muted)
  const emotion = useStore(s => s.emotion)
  const emotionAvailable = useStore(s => s.emotionAvailable)
  const level = useStore(s => s.level)
  const micLevel = useStore(s => s.micLevel)
  const devices = useStore(s => s.devices)
  const deviceId = useStore(s => s.deviceId)
  const deviceError = useStore(s => s.deviceError)
  const signal = useStore(s => s.signal)
  const error = useStore(s => s.error)
  const [deviceMenu, setDeviceMenu] = useState(false)
  if (owner === null || owner !== String(sessionId) || status === 'idle') return null
  const orbStyle = { '--vesta-orb-level': String(agentState === 'speaking' ? level : 0) } as CSSProperties
  const active = devices.find(device => device.id === deviceId)
  const deviceLabel = active === undefined ? '' : (active.label || t('hud.deviceDefault'))
  const items: MenuEntry[] = devices.length === 0
    ? [{ id: '', label: t('hud.noDevices'), disabled: true }]
    : devices.map(device => ({ id: device.id, label: device.label || t('hud.deviceDefault') }))
  const problem = status === 'error' && error !== null ? error : deviceError
  const muteLabel = muted ? t('hud.unmute') : t('hud.mute')
  const signalTitle = `${t('hud.signal')}: ${signal.quality} · concealed ${String(signal.concealedMs)} ms in ${String(signal.concealmentEvents)} events · lost ${String(signal.packetsLost)} · jitter ${String(signal.jitterMs)} ms`
  const toneLabel = t(emotion ? 'hud.emotionOn' : 'hud.emotionOff')
  return (
    <div className={css.dock}>
      <div className={css.bar} role="status" aria-live="polite">
        <div
          className={clsx(css.orb, agentState === 'thinking' && css.thinking, agentState === 'listening' && css.listening)}
          style={orbStyle}
        />
        <span className={css.label}>{t(stateKey(status, agentState))}</span>
        <span className={clsx(css.hint, problem !== null && css.hintError)} title={problem ?? deviceLabel}>
          {problem ?? deviceLabel}
        </span>
        <span className={clsx(css.meter, muted && css.meterOff)} role="img" aria-label={t('hud.micLevel')}>
          {METER_STEPS.map(step => (
            <span key={step} className={clsx(css.meterBar, !muted && micLevel >= step && css.meterOn)} />
          ))}
        </span>
        <span className={clsx(css.signal, css[`signal_${signal.quality}`])} role="img" aria-label={signalTitle} title={signalTitle}>
          <span className={css.signalBar} />
          <span className={css.signalBar} />
          <span className={css.signalBar} />
        </span>
        <div className={css.actions}>
          <div className={clsx(css.split, muted && css.muted)}>
            <Tooltip label={muteLabel} side="top" delayMs={500}>
              <button
                type="button"
                className={css.splitMain}
                aria-label={muteLabel}
                aria-pressed={muted}
                onClick={() => { void toggleMute() }}
              >
                {muted ? <MicOffGlyph size={14} /> : <MicGlyph size={14} />}
              </button>
            </Tooltip>
            <Menu
              open={deviceMenu}
              portal
              side="top"
              align="end"
              items={items}
              selectedId={deviceId ?? undefined}
              onSelect={(id) => {
                setDeviceMenu(false)
                if (id !== '') void selectDevice(id)
              }}
              onClose={() => { setDeviceMenu(false) }}
              anchor={(
                <Tooltip label={t('hud.device')} side="top" delayMs={500}>
                  <button
                    type="button"
                    className={css.splitCaret}
                    aria-label={t('hud.device')}
                    aria-haspopup="listbox"
                    aria-expanded={deviceMenu}
                    onClick={() => { setDeviceMenu(open => !open) }}
                  >
                    <IconChevronDownOutline14 size={12} />
                  </button>
                </Tooltip>
              )}
            />
          </div>
          {emotionAvailable && (
            <Tooltip label={toneLabel} side="top" delayMs={500}>
              <button
                type="button"
                className={clsx(css.control, emotion && css.active)}
                aria-label={toneLabel}
                aria-pressed={emotion}
                onClick={() => { void setEmotion(!emotion) }}
              >
                <HeartGlyph size={14} />
              </button>
            </Tooltip>
          )}
          <Tooltip label={t('hud.end')} side="top" delayMs={500}>
            <button
              type="button"
              className={css.end}
              aria-label={t('hud.end')}
              onClick={() => { void end() }}
            >
              <EndGlyph size={16} />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
