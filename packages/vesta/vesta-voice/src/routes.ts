/**
 * Browser-facing Fetch routes under the authenticated `/api` channel: a
 * LiveKit room token for the Session the browser is looking at, and the
 * perception ("hide emotions") toggle proxied to the STT sidecar.
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol'
import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk'
import type { Config } from './index.ts'

/** Browser route minting one room token per call. */
export const TOKEN_PATH = '/api/vesta/voice/token'
/** Browser route reading and writing the STT sidecar's perception flag. */
export const EMOTION_PATH = '/api/vesta/voice/emotion'
export const CONFIG_PATH = '/api/vesta/voice/config'

/** The bridge face the config route needs. */
export interface VoiceBridgeLike {
  configure(sessionId: string, speed: number): boolean
}

/** The slice of the Host Connection service these routes use (structural, like session-log-export). */
interface VoiceConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

function connectionOf(ctx: Context): VoiceConnection {
  return Reflect.get(ctx, 'connection') as VoiceConnection
}

/**
 * Register both routes on the shared `/api` channel.
 * @param ctx - the plugin context carrying credentials and the Connection service.
 * @param config - resolved plugin config.
 */
export function registerVoiceRoutes(ctx: Context, config: Config, bridge: VoiceBridgeLike): void {
  const connection = connectionOf(ctx)
  connection.fetch.register({
    path: CONFIG_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => configResponse(bridge, request),
  })
  connection.fetch.register({
    path: TOKEN_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => tokenResponse(ctx, config, request),
  })
  connection.fetch.register({
    path: EMOTION_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: request => emotionResponse(config, request),
  })
}

/** `POST /api/vesta/voice/config` with `{ sessionId, speed }`: forward playback settings to the bound agent job. */
async function configResponse(bridge: VoiceBridgeLike, request: Request): Promise<Response> {
  let body: { sessionId?: unknown; speed?: unknown }
  try {
    body = (await request.json()) as { sessionId?: unknown; speed?: unknown }
  } catch {
    return new Response('body must be JSON', { status: 400 })
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const speed = typeof body.speed === 'number' && Number.isFinite(body.speed) ? body.speed : Number.NaN
  if (sessionId === '' || Number.isNaN(speed) || speed < 1 || speed > 2) {
    return new Response('expected { sessionId: string, speed: 1..2 }', { status: 400 })
  }
  if (!bridge.configure(sessionId, speed)) return new Response('no call bound to that session', { status: 404 })
  return Response.json({ ok: true, speed })
}

async function tokenResponse(ctx: Context, config: Config, request: Request): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get('sessionId')
  if (sessionId === null || sessionId.length === 0) {
    return new Response('missing sessionId query parameter', { status: 400 })
  }
  const [key, secret] = await Promise.all([
    ctx.credentials.resolve(credentialRef(config.apiKeyRef)),
    ctx.credentials.resolve(credentialRef(config.apiSecretRef)),
  ])
  if (key === undefined || secret === undefined) {
    return new Response(
      `LiveKit credentials are not configured: store ${config.apiKeyRef} and ${config.apiSecretRef}`,
      { status: 503 },
    )
  }
  const roomName = `${config.roomPrefix}${sessionId}`
  const token = new AccessToken(key.value, secret.value, {
    // One identity per Session: the agent pins itself to the first caller identity and only
    // ever re-links that one, so a re-join (or a second tab, which replaces the first) must
    // present the same name.
    identity: `user-${sessionId.replace(/^session-/u, '')}`,
    name: 'You',
    ttl: config.tokenTtlSeconds,
  })
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  })
  // Explicit dispatch to a named worker, when the deployment uses one. The vesta
  // SFU (livekit-server 1.13) ignored this claim and kept looking for an unnamed
  // worker, so production runs unnamed workers that accept rooms by prefix
  // instead; the claim stays available for an SFU that honours it.
  if (config.agentName.length > 0) {
    token.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: config.agentName })] })
    // livekit-server 1.13 ignores the token claim, so also ask the SFU's API for an explicit
    // dispatch to the named worker (the room is created with it when it does not exist yet).
    // Idempotent per room, best effort: a refusal is logged and the caller still joins.
    await requestDispatch(ctx, config, roomName, key.value, secret.value)
  }
  return Response.json({ serverUrl: config.livekitUrl, roomName, token: await token.toJwt() })
}

/** HTTP endpoint of the SFU's API: the configured one, else the signaling URL with its scheme swapped. */
function apiUrl(config: Config): string {
  if (config.livekitApiUrl !== '') return config.livekitApiUrl
  return config.livekitUrl.replace(/^wss:/u, 'https:').replace(/^ws:/u, 'http:')
}

async function requestDispatch(ctx: Context, config: Config, roomName: string, apiKey: string, apiSecret: string): Promise<void> {
  const client = new AgentDispatchClient(apiUrl(config), apiKey, apiSecret)
  try {
    let existing: readonly { readonly agentName: string }[] = []
    try {
      existing = await client.listDispatch(roomName)
    } catch {
      existing = []   // no room yet: nothing dispatched
    }
    if (existing.some(dispatch => dispatch.agentName === config.agentName)) return
    await client.createDispatch(roomName, config.agentName)
    ctx.logger.info(`vesta-voice: dispatched ${config.agentName} to ${roomName}`)
  } catch (error: unknown) {
    ctx.logger.warn(`vesta-voice: explicit dispatch of ${config.agentName} to ${roomName} failed: ${String(error)}`)
  }
}

async function emotionResponse(config: Config, request: Request): Promise<Response> {
  if (config.mediaUrl === undefined) {
    return Response.json({ emotion_enabled: true, available: false })
  }
  const target = `${config.mediaUrl.replace(/\/$/u, '')}/config`
  try {
    if (request.method === 'POST') {
      const body = (await request.json()) as { enabled?: unknown }
      const upstream = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ emotion_enabled: body.enabled === true }),
      })
      return Response.json({ ...(await upstream.json() as object), available: true })
    }
    const upstream = await fetch(target)
    return Response.json({ ...(await upstream.json() as object), available: true })
  } catch (error) {
    return Response.json(
      { emotion_enabled: true, available: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    )
  }
}
