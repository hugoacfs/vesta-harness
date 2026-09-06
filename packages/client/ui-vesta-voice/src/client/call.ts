/**
 * The voice call controller (apply world): owns the single LiveKit `Room`,
 * fetches the Session's room token from the Host, publishes the microphone,
 * plays the agent's audio, mirrors the agent's published state and audio level
 * into the store, meters the local microphone, switches capture devices, and
 * relays the perception toggle. Components never see the Room; they receive
 * plain callbacks and store state.
 */
import {
  ConnectionQuality,
  createAudioAnalyser,
  LocalAudioTrack,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
} from 'livekit-client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentState, createVoiceCallStore, MicDevice, SignalState } from './store.ts'

/** Host route minting a room token for one Session. */
export const TOKEN_PATH = '/api/vesta/voice/token'
/** Host route reading and writing the STT sidecar's perception flag. */
export const EMOTION_PATH = '/api/vesta/voice/emotion'
/** localStorage key remembering the chosen microphone across calls. */
export const MIC_DEVICE_KEY = 'vesta.voice.micDeviceId'
/** localStorage key (value `1`) that prints the receiver stats to the console once a second. */
export const DEBUG_KEY = 'vesta.voice.debug'

const AGENT_STATE_ATTRIBUTE = 'lk.agent.state'
const AGENT_STATES: readonly AgentState[] = ['initializing', 'listening', 'thinking', 'speaking', 'idle']
const LEVEL_INTERVAL_MS = 66
const STATS_INTERVAL_MS = 1000
/** Opus decodes at 48 kHz, which is the unit of the receiver's concealed-sample counters. */
const RECEIVER_SAMPLE_RATE = 48000

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

/** A level watcher over one audio track: stop() releases the analyser and the timer. */
interface LevelWatch {
  stop: () => Promise<void>
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

function qualityOf(quality: ConnectionQuality): SignalState['quality'] {
  switch (quality) {
    case ConnectionQuality.Excellent: return 'excellent'
    case ConnectionQuality.Good: return 'good'
    case ConnectionQuality.Poor: return 'poor'
    case ConnectionQuality.Lost: return 'lost'
    default: return 'unknown'
  }
}

function debugEnabled(): boolean {
  try {
    return globalThis.localStorage.getItem(DEBUG_KEY) === '1'
  } catch {
    return false
  }
}

function readPreferredMic(): string | undefined {
  try {
    return globalThis.localStorage.getItem(MIC_DEVICE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function writePreferredMic(id: string): void {
  try {
    globalThis.localStorage.setItem(MIC_DEVICE_KEY, id)
  } catch {
    // Storage may be unavailable (private mode); the choice then lasts for the call.
  }
}

/**
 * Meter one track into a callback, throttled and change-filtered.
 * @param track - a local or remote audio track.
 * @param onLevel - receives 0..1 levels.
 * @returns the watcher, or undefined when the browser has no AudioContext.
 */
function watchLevel(track: LocalAudioTrack | RemoteAudioTrack, onLevel: (level: number) => void): LevelWatch | undefined {
  try {
    const { calculateVolume, cleanup } = createAudioAnalyser(track, { smoothingTimeConstant: 0.6 })
    let last = 0
    const timer = setInterval(() => {
      const level = Math.min(1, calculateVolume() * 4)
      if (Math.abs(level - last) < 0.02) return
      last = level
      onLevel(level)
    }, LEVEL_INTERVAL_MS)
    return {
      stop: async () => {
        clearInterval(timer)
        await cleanup()
      },
    }
  } catch {
    // The analyser is decorative; a browser without AudioContext keeps the static orb.
    return undefined
  }
}

/** One active call at a time, bound to the Session whose mic button started it. */
export class VoiceCallController {
  private actions: Actions | undefined
  private room: Room | undefined
  private sessionId: string | undefined
  private audio: HTMLMediaElement[] = []
  private agentLevel: LevelWatch | undefined
  private micLevel: LevelWatch | undefined
  private statsTimer: ReturnType<typeof setInterval> | undefined
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
    const preferred = readPreferredMic()
    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      audioCaptureDefaults: preferred === undefined ? {} : { deviceId: preferred },
    })
    this.room = room
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => { this.onTrack(track) })
    room.on(RoomEvent.ParticipantAttributesChanged, (changed: Record<string, string>, participant: Participant) => {
      if (participant.isLocal) return
      const state = agentStateOf(changed[AGENT_STATE_ATTRIBUTE])
      if (state !== undefined) actions.agentState(state)
    })
    room.on(RoomEvent.MediaDevicesError, (error: Error) => { actions.deviceError(error.message) })
    room.on(RoomEvent.ConnectionQualityChanged, (quality: ConnectionQuality, participant: Participant) => {
      if (participant.isLocal) actions.signal({ quality: qualityOf(quality) })
    })
    room.on(RoomEvent.MediaDevicesChanged, () => { void this.refreshDevices() })
    room.on(RoomEvent.ActiveDeviceChanged, (kind: MediaDeviceKind) => {
      if (kind !== 'audioinput') return
      void this.refreshDevices()
      this.watchMic()
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
      actions.deviceError(null)
      this.watchMic()
      void this.refreshDevices()
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
    if (!muted) this.watchMic()
  }

  /**
   * Capture from another microphone for the rest of this call and later ones.
   * @param deviceId - a browser `MediaDeviceInfo.deviceId` from the store's device list.
   */
  async selectDevice(deviceId: string): Promise<void> {
    const room = this.room
    const actions = this.actions
    if (room === undefined || actions === undefined) return
    try {
      await room.switchActiveDevice('audioinput', deviceId, true)
      writePreferredMic(deviceId)
      actions.deviceError(null)
    } catch (error) {
      actions.deviceError(messageOf(error))
    }
    await this.refreshDevices()
    this.watchMic()
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

  /** The microphone track the call publishes, once it exists. */
  private micTrack(): LocalAudioTrack | undefined {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
    return track instanceof LocalAudioTrack ? track : undefined
  }

  /**
   * List the browser's microphones and mark the one the call captures from.
   * Labels need capture permission, which the live call has granted.
   */
  private async refreshDevices(): Promise<void> {
    const room = this.room
    const actions = this.actions
    if (room === undefined || actions === undefined) return
    let devices: MicDevice[] = []
    try {
      const list = await Room.getLocalDevices('audioinput', false)
      devices = list.map(device => ({ id: device.deviceId, label: device.label }))
    } catch {
      // Enumeration can be refused (no permission yet); the list stays empty.
    }
    if (this.room !== room) return
    const active = room.getActiveDevice('audioinput') ?? this.micTrack()?.mediaStreamTrack.getSettings().deviceId ?? null
    actions.devices(devices, active)
  }

  /** Meter the microphone track (again, after a device switch replaces its stream). */
  private watchMic(): void {
    const actions = this.actions
    const track = this.micTrack()
    if (actions === undefined || track === undefined) return
    const previous = this.micLevel
    this.micLevel = undefined
    if (previous !== undefined) void previous.stop()
    this.micLevel = watchLevel(track, (level) => { actions.micLevel(level) })
  }

  private onTrack(track: RemoteTrack): void {
    if (!(track instanceof RemoteAudioTrack)) return
    const element = track.attach()
    element.style.display = 'none'
    document.body.appendChild(element)
    this.audio.push(element)
    const actions = this.actions
    if (actions !== undefined && this.agentLevel === undefined) {
      this.agentLevel = watchLevel(track, (level) => { actions.level(level) })
      this.watchSignal(track, actions)
    }
  }

  /**
   * Sample the receiver's own account of Vesta's audio once a second: what the
   * jitter buffer concealed, packets lost, jitter. A dropout that shows here is
   * the network's; one that does not is upstream of the browser.
   */
  private watchSignal(track: RemoteAudioTrack, actions: Actions): void {
    if (this.statsTimer !== undefined) clearInterval(this.statsTimer)
    let concealedBase: number | undefined
    let eventsBase: number | undefined
    let lostBase: number | undefined
    const debug = debugEnabled()
    this.statsTimer = setInterval(() => {
      void track.getReceiverStats().then((stats) => {
        if (stats === undefined) return
        const concealed = stats.concealedSamples ?? 0
        const events = stats.concealmentEvents ?? 0
        const lost = stats.packetsLost ?? 0
        concealedBase ??= concealed
        eventsBase ??= events
        lostBase ??= lost
        const patch: Partial<SignalState> = {
          concealedMs: Math.round((concealed - concealedBase) / RECEIVER_SAMPLE_RATE * 1000),
          concealmentEvents: events - eventsBase,
          packetsLost: lost - lostBase,
          jitterMs: Math.round((stats.jitter ?? 0) * 1000),
        }
        actions.signal(patch)
        if (debug) console.info('[vesta-voice] receiver', patch)
      }).catch(() => {
        // Stats are diagnostic only; a browser that refuses them keeps the call.
      })
    }, STATS_INTERVAL_MS)
  }

  private async teardown(keepError = false): Promise<void> {
    if (this.statsTimer !== undefined) {
      clearInterval(this.statsTimer)
      this.statsTimer = undefined
    }
    const watches = [this.agentLevel, this.micLevel]
    this.agentLevel = undefined
    this.micLevel = undefined
    for (const watch of watches) {
      if (watch !== undefined) await watch.stop()
    }
    for (const element of this.audio.splice(0)) element.remove()
    this.room = undefined
    this.sessionId = undefined
    if (!keepError) this.actions?.ended()
  }
}
