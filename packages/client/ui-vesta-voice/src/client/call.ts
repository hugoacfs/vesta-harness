/**
 * The voice call controller (apply world): owns the single LiveKit `Room`,
 * fetches the Session's room token from the Host, publishes the microphone,
 * plays the agent's audio, mirrors the agent's published state and audio level
 * into the store, and relays the perception toggle. Components never see the
 * Room; they receive plain callbacks and store state.
 */
import {
  createAudioAnalyser,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  type Participant,
  type RemoteTrack,
} from 'livekit-client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentState, createVoiceCallStore } from './store.ts'

/** Host route minting a room token for one Session. */
export const TOKEN_PATH = '/api/vesta/voice/token'
/** Host route reading and writing the STT sidecar's perception flag. */
export const EMOTION_PATH = '/api/vesta/voice/emotion'

const AGENT_STATE_ATTRIBUTE = 'lk.agent.state'
const AGENT_STATES: readonly AgentState[] = ['initializing', 'listening', 'thinking', 'speaking', 'idle']
const LEVEL_INTERVAL_MS = 66

type Actions = BoundActions<ReturnType<typeof createVoiceCallStore>>

interface TokenResponse {
  serverUrl: string
  roomName: string
  token: string
}

interface EmotionResponse {
  emotion_enabled?: boolean
  available?: boolean
}

/** Resolve the browser's Host base with the connection carrier's null-origin fallback. */
function hostBase(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function agentStateOf(value: string | undefined): AgentState | undefined {
  return AGENT_STATES.find(state => state === value)
}

/** One active call at a time, bound to the Session whose mic button started it. */
export class VoiceCallController {
  private actions: Actions | undefined
  private room: Room | undefined
  private sessionId: string | undefined
  private audio: HTMLMediaElement[] = []
  private levelTimer: ReturnType<typeof setInterval> | undefined
  private stopAnalyser: (() => Promise<void>) | undefined
  /** True while a failed start is leaving the room, so its Disconnected event keeps the error state. */
  private failing = false

  /**
   * Adopt the store's bound actions; both slot registrations share one store,
   * so the first `inject` to run installs them and later ones are no-ops.
   * @param actions - the store's bound action set.
   */
  adopt(actions: Actions): void {
    this.actions ??= actions
  }

  /** Whether the given Session owns the active call. */
  owns(sessionId: string): boolean {
    return this.sessionId === sessionId && this.room !== undefined
  }

  /**
   * Start a call for one Session, ending any other call first.
   * @param sessionId - the Session whose room to join.
   */
  async start(sessionId: string): Promise<void> {
    await this.end()
    const actions = this.actions
    if (actions === undefined) return
    actions.connecting(sessionId)
    this.sessionId = sessionId
    const room = new Room({ adaptiveStream: false, dynacast: false })
    this.room = room
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => { this.onTrack(track) })
    room.on(RoomEvent.ParticipantAttributesChanged, (changed: Record<string, string>, participant: Participant) => {
      if (participant.isLocal) return
      const state = agentStateOf(changed[AGENT_STATE_ATTRIBUTE])
      if (state !== undefined) actions.agentState(state)
    })
    // A failed start disconnects deliberately; that disconnect must not wipe
    // the error the HUD is about to show.
    room.on(RoomEvent.Disconnected, () => { void this.teardown(this.failing) })
    try {
      const response = await fetch(new URL(`${TOKEN_PATH}?sessionId=${encodeURIComponent(sessionId)}`, hostBase()), {
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`token ${String(response.status)}: ${await response.text()}`)
      const grant = (await response.json()) as TokenResponse
      await room.connect(grant.serverUrl, grant.token)
      await room.localParticipant.setMicrophoneEnabled(true)
      for (const participant of room.remoteParticipants.values()) {
        const state = agentStateOf(participant.attributes[AGENT_STATE_ATTRIBUTE])
        if (state !== undefined) actions.agentState(state)
      }
      actions.live()
      void this.refreshEmotion()
    } catch (error) {
      actions.failed(messageOf(error))
      // Leave the room on the failure path too, or the participant lingers
      // (and the agent stays linked to a browser that never publishes).
      this.failing = true
      this.room = undefined
      await room.disconnect()
      await this.teardown(true)
      this.failing = false
    }
  }

  /** Leave the room and reset the store. */
  async end(): Promise<void> {
    if (this.room === undefined) return
    const room = this.room
    this.room = undefined
    await room.disconnect()
    await this.teardown()
  }

  /** Toggle the local microphone track. */
  async toggleMute(): Promise<void> {
    const room = this.room
    const actions = this.actions
    if (room === undefined || actions === undefined) return
    const muted = room.localParticipant.isMicrophoneEnabled
    await room.localParticipant.setMicrophoneEnabled(!muted)
    actions.muted(muted)
  }

  /**
   * Flip the STT sidecar's perception flag through the Host.
   * @param enabled - whether transcripts should carry tone and laughter notes.
   */
  async setEmotion(enabled: boolean): Promise<void> {
    const actions = this.actions
    if (actions === undefined) return
    try {
      const response = await fetch(new URL(EMOTION_PATH, hostBase()), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const body = (await response.json()) as EmotionResponse
      actions.emotion(body.emotion_enabled !== false, body.available === true)
    } catch {
      actions.emotion(true, false)
    }
  }

  private async refreshEmotion(): Promise<void> {
    const actions = this.actions
    if (actions === undefined) return
    try {
      const response = await fetch(new URL(EMOTION_PATH, hostBase()), { credentials: 'same-origin' })
      const body = (await response.json()) as EmotionResponse
      actions.emotion(body.emotion_enabled !== false, body.available === true)
    } catch {
      actions.emotion(true, false)
    }
  }

  private onTrack(track: RemoteTrack): void {
    if (!(track instanceof RemoteAudioTrack)) return
    const element = track.attach()
    element.style.display = 'none'
    document.body.appendChild(element)
    this.audio.push(element)
    void this.watchLevel(track)
  }

  private async watchLevel(track: RemoteAudioTrack): Promise<void> {
    const actions = this.actions
    if (actions === undefined || this.levelTimer !== undefined) return
    try {
      const { calculateVolume, cleanup } = createAudioAnalyser(track, { smoothingTimeConstant: 0.6 })
      this.stopAnalyser = cleanup
      let last = 0
      this.levelTimer = setInterval(() => {
        const level = Math.min(1, calculateVolume() * 4)
        if (Math.abs(level - last) < 0.02) return
        last = level
        actions.level(level)
      }, LEVEL_INTERVAL_MS)
    } catch {
      // The analyser is decorative; a browser without AudioContext keeps the static orb.
    }
  }

  private async teardown(keepError = false): Promise<void> {
    if (this.levelTimer !== undefined) {
      clearInterval(this.levelTimer)
      this.levelTimer = undefined
    }
    if (this.stopAnalyser !== undefined) {
      const stop = this.stopAnalyser
      this.stopAnalyser = undefined
      await stop()
    }
    for (const element of this.audio.splice(0)) element.remove()
    this.room = undefined
    this.sessionId = undefined
    if (!keepError) this.actions?.ended()
  }
}
