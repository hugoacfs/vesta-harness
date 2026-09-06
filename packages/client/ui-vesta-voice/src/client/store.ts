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

/** One microphone the browser can capture from. */
export interface MicDevice {
  id: string
  /** Browser label; empty until the page has capture permission. */
  label: string
}

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
  /** Local microphone level, 0..1, throttled: what the room is hearing from you. */
  micLevel: number
  /** Microphones the browser offers, in its order. */
  devices: readonly MicDevice[]
  /** The microphone the call captures from; null until known. */
  deviceId: string | null
  /** The browser's capture error text (permission, device in use); null when capture works. */
  deviceError: string | null
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
  micLevel: (draft: VoiceCallState, level: number) => void
  devices: (draft: VoiceCallState, devices: readonly MicDevice[], activeId: string | null) => void
  deviceError: (draft: VoiceCallState, message: string | null) => void
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
    micLevel: 0,
    devices: [],
    deviceId: null,
    deviceError: null,
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
        d.micLevel = 0
        d.devices = []
        d.deviceId = null
        d.deviceError = null
        d.error = null
      },
      live: (d) => { d.status = 'live' },
      agentState: (d, state: AgentState) => { d.agentState = state },
      muted: (d, muted: boolean) => {
        d.muted = muted
        if (muted) d.micLevel = 0
      },
      emotion: (d, enabled: boolean, available: boolean) => {
        d.emotion = enabled
        d.emotionAvailable = available
      },
      level: (d, level: number) => { d.level = level },
      micLevel: (d, level: number) => { d.micLevel = level },
      devices: (d, devices: readonly MicDevice[], activeId: string | null) => {
        d.devices = devices
        d.deviceId = activeId
      },
      deviceError: (d, message: string | null) => { d.deviceError = message },
      failed: (d, message: string) => {
        d.status = 'error'
        d.error = message
        d.level = 0
        d.micLevel = 0
      },
      ended: (d) => {
        Object.assign(d, initialState())
      },
    },
  })
}
