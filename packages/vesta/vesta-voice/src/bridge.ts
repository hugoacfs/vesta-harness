/**
 * The voice bridge: an upgrade route on the Host web server that a LiveKit
 * agent job dials once per room. The Host authenticates the bearer against the
 * LiveKit API secret, maps the room name to a Session, resolves (or resumes)
 * its Agent, and binds the socket: spoken turns enter through the Session
 * Controller exactly like typed prompts, assistant text streams back as
 * `speak` deltas from the process-local assistant stream, tool calls and turn
 * ends are relayed, and a spoken-mode prompt section covers the Agent while
 * the socket lives.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Config } from './index.ts'
import { VOICE_SECTION, VOICE_SECTION_NAME, VOICE_SECTION_ORDER } from './prompt.ts'
import type { AgentToHost, HostToAgent } from './types.ts'

/** One bound room: the socket, the Agent it drives, and what unwinds on close. */
interface Binding {
  readonly sessionId: SessionId
  readonly agent: Agent
  readonly socket: WebSocket
  readonly disposers: (() => void)[]
}

const BEARER = /^Bearer\s+(\S+)$/u

function bearerMatches(header: string | undefined, secret: string): boolean {
  const presented = header === undefined ? undefined : BEARER.exec(header)?.[1]
  if (presented === undefined) return false
  const actual = Buffer.from(presented, 'utf8')
  const expected = Buffer.from(secret, 'utf8')
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function parseFrame(raw: unknown): AgentToHost | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(raw))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const frame = parsed as { type?: unknown; text?: unknown }
  if (frame.type === 'turn' && typeof frame.text === 'string') return { type: 'turn', text: frame.text }
  if (frame.type === 'interrupt') return { type: 'interrupt' }
  if (frame.type === 'ping') return { type: 'ping' }
  return undefined
}

/** The bridge owner: one WebSocket server behind the upgrade route plus the live bindings. */
export class VoiceBridge {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly bindings = new Set<Binding>()

  /**
   * @param ctx - the plugin context (Session Controller, credentials, and session events).
   * @param config - resolved plugin config.
   */
  constructor(private readonly ctx: Context, private readonly config: Config) {}

  /**
   * Handle one HTTP upgrade on the bridge path: authenticate, bind the room's
   * Session, then complete the WebSocket handshake.
   * @param req - the upgrade request carrying `Authorization` and `X-Vesta-Room`.
   * @param socket - the raw socket; refused handshakes write a status line and destroy it.
   * @param head - the first packet of the upgraded stream.
   */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const secret = await this.ctx.credentials.resolve(credentialRef(this.config.apiSecretRef))
    if (secret === undefined || !bearerMatches(req.headers.authorization, secret.value)) {
      refuse(socket, 401, 'Unauthorized')
      return
    }
    const room = req.headers['x-vesta-room']
    const roomName = typeof room === 'string' ? room : ''
    if (!roomName.startsWith(this.config.roomPrefix) || roomName.length === this.config.roomPrefix.length) {
      refuse(socket, 404, 'Not Found')
      return
    }
    const sessionId = brandString<SessionId>(roomName.slice(this.config.roomPrefix.length))
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if (!('agent' in resolved)) {
      this.ctx.logger.warn(`vesta-voice: room ${roomName} names no resumable session`)
      refuse(socket, 404, 'Not Found')
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => { this.bind(ws, sessionId, resolved.agent) })
  }

  /** Close every bound socket; the upgrade route owner calls this on unload. */
  dispose(): void {
    for (const binding of [...this.bindings]) this.unbind(binding, 1001, 'host unloading')
    this.wss.close()
  }

  private bind(socket: WebSocket, sessionId: SessionId, agent: Agent): void {
    const binding: Binding = { sessionId, agent, socket, disposers: [] }
    this.bindings.add(binding)
    const send = (frame: HostToAgent): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
    }
    binding.disposers.push(agent.ctx.systemPrompt.section({
      name: VOICE_SECTION_NAME,
      order: VOICE_SECTION_ORDER,
      text: VOICE_SECTION,
    }))
    binding.disposers.push(agent.ctx.on('agent/assistant-stream', ({ agent: owner, frame }) => {
      if (owner !== agent || frame.type !== 'chunk' || frame.chunk.type !== 'text-delta') return
      send({ type: 'speak', text: frame.chunk.text })
    }))
    binding.disposers.push(this.ctx.on('session/event', (session, event) => {
      if (session.id !== agent.session.id) return
      const record = event as { readonly type: string; readonly data?: unknown }
      const data = (typeof record.data === 'object' && record.data !== null ? record.data : {}) as {
        readonly name?: unknown
        readonly reason?: unknown
      }
      if (record.type === 'tool/call' && typeof data.name === 'string') {
        send({ type: 'status', tool: data.name })
      } else if (record.type === 'turn/end') {
        send({ type: 'done', reason: typeof data.reason === 'string' ? data.reason : 'closed' })
      }
    }))
    socket.on('message', (raw) => {
      const frame = parseFrame(raw)
      if (frame === undefined) return
      switch (frame.type) {
        case 'turn':
          void this.submitTurn(binding, frame.text, send)
          break
        case 'interrupt':
          this.interrupt(binding)
          break
        case 'ping':
          send({ type: 'pong' })
          break
      }
    })
    socket.on('error', (error) => { this.ctx.logger.warn(error) })
    socket.once('close', () => { this.unbind(binding) })
    send({ type: 'ready', sessionId: String(sessionId) })
    this.ctx.logger.info(`vesta-voice: room bound to session ${String(sessionId)}`)
  }

  private unbind(binding: Binding, code?: number, reason?: string): void {
    if (!this.bindings.delete(binding)) return
    for (const dispose of binding.disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (code !== undefined && binding.socket.readyState === binding.socket.OPEN) binding.socket.close(code, reason)
    this.ctx.logger.info(`vesta-voice: room unbound from session ${String(binding.sessionId)}`)
  }

  /** A finished utterance: steer a running Agent, otherwise queue a new turn. */
  private async submitTurn(binding: Binding, text: string, send: (frame: HostToAgent) => void): Promise<void> {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const mode = binding.agent.status === 'running' ? 'steer' : 'queue'
    try {
      await this.ctx.sessionController.prompt({
        requestId: brandString<SessionRequestId>(randomUUID()),
        sessionId: binding.sessionId,
        mode,
        content: [{ type: 'text', text: trimmed }],
      }, new AbortController().signal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`vesta-voice: prompt refused for ${String(binding.sessionId)}: ${message}`)
      send({ type: 'error', message })
    }
  }

  /** Barge-in: abort the active turn but keep queued and steering work. */
  private interrupt(binding: Binding): void {
    try {
      this.ctx.sessionController.cancel({ sessionId: binding.sessionId })
    } catch (error) {
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  }
}
