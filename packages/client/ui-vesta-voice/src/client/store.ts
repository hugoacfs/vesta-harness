/**
 * The voice call store: one active call at a time, shared by the mic button
 * and the HUD registrations. The call controller (apply world) is the only
 * writer; components read through `props.useStore`.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Lifecycle of the single active call. */
export type CallStatus = 'idle' | 'connecting' | 'live' | 'error'

/** The agent's published state (`lk.agent.state`), plus `unknown` before the first publication. */
export type AgentState = 'unknown' | 'initializing' | 'listening' | 'thinking' | 'speaking' | 'idle'

/** Store state. */
export interface VoiceCallState {
  /** Session the active call is bound to; null while idle. */
  sessionId: string | null
  status: CallStatus
  agentState: AgentState
  muted: boolean
  /** Whether the STT sidecar annotates transcripts with tone and laughter. */
  emotion: boolean
  /** Whether the perception toggle is served by the Host at all. */
  emotionAvailable: boolean
  /** Agent audio level, 0..1, throttled. */
  level: number
  /** Failure text (not localized: error-surface policy). */
  error: string | null
}

/** Declared action shape giving the exported factory a stable return type. */
type VoiceCallActions = {
  connecting: (draft: VoiceCallState, sessionId: string) => void
  live: (draft: VoiceCallState) => void
  agentState: (draft: VoiceCallState, state: AgentState) => void
  muted: (draft: VoiceCallState, muted: boolean) => void
  emotion: (draft: VoiceCallState, enabled: boolean, available: boolean) => void
  level: (draft: VoiceCallState, level: number) => void
  failed: (draft: VoiceCallState, message: string) => void
  ended: (draft: VoiceCallState) => void
}

function initialState(): VoiceCallState {
  return {
    sessionId: null,
    status: 'idle',
    agentState: 'unknown',
    muted: false,
    emotion: true,
    emotionAvailable: false,
    level: 0,
    error: null,
  }
}

/**
 * Declares the voice call state and write surface.
 * @returns the store handle.
 */
export function createVoiceCallStore(): EngineStoreHandle<VoiceCallState, VoiceCallActions> {
  return defineStore({
    init: initialState,
    actions: {
      connecting: (d, sessionId: string) => {
        d.sessionId = sessionId
        d.status = 'connecting'
        d.agentState = 'unknown'
        d.muted = false
        d.level = 0
        d.error = null
      },
      live: (d) => { d.status = 'live' },
      agentState: (d, state: AgentState) => { d.agentState = state },
      muted: (d, muted: boolean) => { d.muted = muted },
      emotion: (d, enabled: boolean, available: boolean) => {
        d.emotion = enabled
        d.emotionAvailable = available
      },
      level: (d, level: number) => { d.level = level },
      failed: (d, message: string) => {
        d.status = 'error'
        d.error = message
        d.level = 0
      },
      ended: (d) => {
        Object.assign(d, initialState())
      },
    },
  })
}
