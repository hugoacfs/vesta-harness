/**
 * Vesta voice bridge, host plugin. Three contributions: the LiveKit room-token
 * and perception-toggle Fetch routes the browser calls, the WebSocket upgrade
 * route each LiveKit agent job dials to bind its room to one Session, a
 * spoken-mode note injected with every spoken turn, and reasoning switched
 * off for the Session while a call is bound. The voice models themselves run
 * in the LiveKit stack; this plugin never touches audio.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { VoiceBridge } from './bridge.ts'
import { registerVoiceRoutes } from './routes.ts'

export { EMOTION_PATH, TOKEN_PATH } from './routes.ts'
export { VOICE_SECTION, VOICE_SOURCE_PLUGIN, VOICE_TURN_NOTE } from './prompt.ts'
export type { AgentToHost, HostToAgent } from './types.ts'

export const name = 'vesta-voice'

/** Required services: the HTTP carrier, the `/api` Connection, Session commands, and the credential store. */
export const inject = ['webServer', 'connection', 'sessionController', 'credentials']

/** Deployment facts of the voice stack. */
export interface Config {
  /** LiveKit signaling URL the browser connects to (`wss://…`). */
  livekitUrl: string
  /** Credential reference holding the LiveKit API key. @default 'LIVEKIT_API_KEY' */
  apiKeyRef: string
  /** Credential reference holding the LiveKit API secret; also the bridge bearer. @default 'LIVEKIT_API_SECRET' */
  apiSecretRef: string
  /** Upgrade path the agent job dials on the Host web server. @default '/vesta/voice/bridge' */
  bridgePath: string
  /** Base URL of the STT sidecar whose `/config` carries the perception flag; absent disables the toggle. */
  mediaUrl?: string
  /** Room token lifetime in seconds. @default 3600 */
  tokenTtlSeconds: number
  /** Room name prefix before the Session id. @default 'dsh-' */
  roomPrefix: string
  /**
   * On bind, submit a greeting turn that also warms the request prefix in the
   * model cache; its spoken reply greets the caller. Empty disables warming and
   * leaves the greeting to the agent job's fixed line. @default true
   */
  warmupOnBind: boolean
}

/** Validate the voice bridge configuration. */
export const Config: z<Config> = z.object({
  livekitUrl: z.string().required(),
  apiKeyRef: z.string().default('LIVEKIT_API_KEY'),
  apiSecretRef: z.string().default('LIVEKIT_API_SECRET'),
  bridgePath: z.string().default('/vesta/voice/bridge'),
  mediaUrl: z.string(),
  tokenTtlSeconds: z.natural().min(60).default(3600),
  roomPrefix: z.string().default('dsh-'),
  warmupOnBind: z.boolean().default(true),
})

/**
 * Mount the bridge upgrade route and the browser routes.
 * @param ctx - Host context.
 * @param config - resolved deployment facts.
 */
export function apply(ctx: Context, config: Config): void {
  const bridge = new VoiceBridge(ctx, config)
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: config.bridgePath,
    handler: (req, socket, head) => bridge.handleUpgrade(req, socket, head),
  }), 'vesta-voice: bridge upgrade route')
  ctx.effect(() => () => { bridge.dispose() }, 'vesta-voice: bound rooms')
  registerVoiceRoutes(ctx, config)
}
