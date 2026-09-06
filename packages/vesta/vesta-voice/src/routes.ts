/**
 * Browser-facing Fetch routes under the authenticated `/api` channel: a
 * LiveKit room token for the Session the browser is looking at, and the
 * perception ("hide emotions") toggle proxied to the STT sidecar.
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol'
import { AccessToken } from 'livekit-server-sdk'
import type { Config } from './index.ts'

/** Browser route minting one room token per call. */
export const TOKEN_PATH = '/api/vesta/voice/token'
/** Browser route reading and writing the STT sidecar's perception flag. */
export const EMOTION_PATH = '/api/vesta/voice/emotion'

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
export function registerVoiceRoutes(ctx: Context, config: Config): void {
  const connection = connectionOf(ctx)
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
  }
  return Response.json({ serverUrl: config.livekitUrl, roomName, token: await token.toJwt() })
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
