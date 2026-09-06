/**
 * The voice bridge: an upgrade route on the Host web server that a LiveKit
 * agent job dials once per room. The Host authenticates the bearer against the
 * LiveKit API secret, maps the room name to a Session, resolves (or resumes)
 * its Agent, and binds the socket: spoken turns enter through the Session
 * Controller exactly like typed prompts, assistant text streams back as
 * `speak` deltas from the process-local assistant stream, tool calls and turn
 * ends are relayed, approval questions are asked aloud and raced against the
 * on-screen card, and spoken permission switches go through the permission
 * preset service.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context, Events } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Config } from './index.ts'
import { VOICE_SOURCE_PLUGIN, VOICE_TURN_NOTE } from './prompt.ts'
import type { AgentToHost, HostToAgent } from './types.ts'

/** One bound room: the socket, the Agent it drives, and what unwinds on close. */
interface Binding {
  readonly sessionId: SessionId
  readonly agent: Agent
  readonly socket: WebSocket
  readonly disposers: (() => void)[]
  /** The Session's reasoning effort before the call switched it off, restored on unbind. */
  restoreReasoning: { provider: string; model: string; reasoningEffort: string | undefined } | undefined
  /** Approval questions asked aloud and not yet settled, by bridge id. */
  readonly approvals: Map<string, PendingApproval>
}

/** One approval question in flight on the socket: the spoken answer settles it, `close` withdraws it. */
interface PendingApproval {
  readonly resolve: (outcome: ApprovalOutcome) => void
}

type ApprovalRequest = Parameters<Events['approval/request']>[0]

/** Requests this bridge re-dispatched with its own cancellation, skipped by the answerer on re-entry. */
const derivedRequests = new WeakSet<ApprovalRequest>()

const BEARER = /^Bearer\s+(\S+)$/u

/** Preset ids as they should be spoken. */
function spokenPresetName(preset: string): string {
  switch (preset) {
    case 'read-only': return 'read-only mode'
    case 'workspace-write': return 'workspace mode'
    case 'danger-full-access': return 'full access mode'
    default: return `${preset.replaceAll('-', ' ')} mode`
  }
}

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
  const frame = parsed as { type?: unknown; text?: unknown; id?: unknown; allow?: unknown; preset?: unknown }
  if (frame.type === 'turn' && typeof frame.text === 'string') return { type: 'turn', text: frame.text }
  if (frame.type === 'interrupt') return { type: 'interrupt' }
  if (frame.type === 'approval-decision' && typeof frame.id === 'string' && typeof frame.allow === 'boolean') {
    return { type: 'approval-decision', id: frame.id, allow: frame.allow }
  }
  if (frame.type === 'permission' && typeof frame.preset === 'string') return { type: 'permission', preset: frame.preset }
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
    const binding: Binding = {
      sessionId, agent, socket, disposers: [], restoreReasoning: undefined, approvals: new Map(),
    }
    this.bindings.add(binding)
    const send = (frame: HostToAgent): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
    }
    void this.quietReasoning(binding)
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
        readonly preset?: unknown
      }
      if (record.type === 'tool/call' && typeof data.name === 'string') {
        send({ type: 'status', tool: data.name })
      } else if (record.type === 'turn/end') {
        send({ type: 'done', reason: typeof data.reason === 'string' ? data.reason : 'closed' })
      } else if (record.type === 'permission/preset' && typeof data.preset === 'string') {
        send({ type: 'permission', preset: data.preset })
      }
    }))
    // Outermost answerer: the on-screen card (registered at boot) would
    // otherwise hold the chain until the user clicks, and a spoken answer
    // could never win the race.
    binding.disposers.push(this.ctx.on('approval/request', (request, next) => {
      if (request.agent !== agent || derivedRequests.has(request)) return next()
      return this.askAloud(binding, request, send)
    }, { prepend: true }))
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
        case 'approval-decision':
          binding.approvals.get(frame.id)?.resolve(frame.allow ? 'allowed-once' : 'rejected')
          break
        case 'permission':
          this.switchPermission(binding, frame.preset, send)
          break
        case 'ping':
          send({ type: 'pong' })
          break
      }
    })
    socket.on('error', (error) => { this.ctx.logger.warn(error) })
    socket.once('close', () => { this.unbind(binding) })
    send({ type: 'ready', sessionId: String(sessionId), permission: this.currentPermission(binding) })
    this.ctx.logger.info(`vesta-voice: room bound to session ${String(sessionId)}`)
  }

  private unbind(binding: Binding, code?: number, reason?: string): void {
    if (!this.bindings.delete(binding)) return
    for (const pending of binding.approvals.values()) pending.resolve('unavailable')
    binding.approvals.clear()
    void this.restoreReasoning(binding)
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
      // The spoken-mode note rides the same step as the utterance: injected
      // context waits in the inbox until the prompt below wakes the driver.
      binding.agent.inject(createUserMessage({
        content: [{ type: 'text', text: VOICE_TURN_NOTE }],
        source: { kind: 'plugin', plugin: VOICE_SOURCE_PLUGIN },
      }))
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

  /**
   * Switch the Session's reasoning effort off while the call lasts: a spoken
   * reply should not wait for a thinking phase. A model that declares no
   * `off` effort keeps its current selection (logged, not fatal).
   */
  private async quietReasoning(binding: Binding): Promise<void> {
    const { provider, model, reasoningEffort } = binding.agent.options
    if (provider === undefined || model === undefined || reasoningEffort === 'off') return
    try {
      await this.ctx.sessionController.selectModel({
        sessionId: binding.sessionId, provider, model, reasoningEffort: 'off',
      })
      binding.restoreReasoning = { provider, model, reasoningEffort }
    } catch (error) {
      this.ctx.logger.info(`vesta-voice: reasoning stays on for ${String(binding.sessionId)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Put the reasoning effort back the way the call found it. */
  private async restoreReasoning(binding: Binding): Promise<void> {
    const previous = binding.restoreReasoning
    if (previous === undefined) return
    binding.restoreReasoning = undefined
    try {
      await this.ctx.sessionController.selectModel({
        sessionId: binding.sessionId,
        provider: previous.provider,
        model: previous.model,
        ...(previous.reasoningEffort === undefined ? {} : { reasoningEffort: previous.reasoningEffort }),
      })
    } catch (error) {
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Ask one approval aloud and race the spoken answer against the rest of the
   * chain. The chain is re-dispatched with a request whose cancellation the
   * bridge also owns: a spoken decision aborts it, which withdraws the
   * on-screen card through the gateway; an on-screen decision (or the asker's
   * own cancellation) tells the agent to stop asking. First decision wins;
   * `unavailable` from the chain (no browser attached) leaves the spoken
   * answer as the only channel until the socket closes.
   */
  private askAloud(binding: Binding, request: ApprovalRequest, send: (frame: HostToAgent) => void): Promise<ApprovalOutcome> {
    const id = randomUUID()
    const withdraw = new AbortController()
    const signals = [withdraw.signal, ...(request.signal === undefined ? [] : [request.signal])]
    const derived: ApprovalRequest = { ...request, signal: AbortSignal.any(signals) }
    derivedRequests.add(derived)
    const spoken = new Promise<ApprovalOutcome>((resolve) => {
      binding.approvals.set(id, { resolve })
    })
    const screen: Promise<ApprovalOutcome> = Promise.resolve().then(() => this.ctx.waterfall(
      scopeTarget(request.agent, request.agent), 'approval/request', derived,
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )).then(
      outcome => outcome === 'unavailable' ? spoken : outcome,
      () => spoken,
    )
    send({ type: 'approval', id, tool: request.toolName, ...(request.reason === undefined ? {} : { reason: request.reason }) })
    return Promise.race([spoken, screen]).then((outcome) => {
      binding.approvals.delete(id)
      withdraw.abort(new Error(`vesta-voice: approval ${outcome}`))
      send({ type: 'approval-done', id, outcome })
      return outcome
    })
  }

  /** The Session's effective permission preset, or `custom` when no table row matches. */
  private currentPermission(binding: Binding): string {
    const presets = this.ctx.get('permissionPresets')
    if (presets === undefined) return 'custom'
    try {
      return presets.current(binding.agent.session)
    } catch {
      // A Session whose log cannot be folded yet reports the same as no table row.
      return 'custom'
    }
  }

  /** A spoken permission switch: apply the named preset and confirm aloud, or refuse aloud. */
  private switchPermission(binding: Binding, preset: string, send: (frame: HostToAgent) => void): void {
    const presets = this.ctx.get('permissionPresets')
    if (presets === undefined) {
      send({ type: 'error', message: 'permission presets are not available in this composition' })
      return
    }
    try {
      presets.resolve(preset)
      presets.set(binding.agent.session, preset)
      this.ctx.logger.info(`vesta-voice: permission preset ${preset} selected by voice for ${String(binding.sessionId)}`)
      send({ type: 'say', text: `Switched to ${spokenPresetName(preset)}.` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`vesta-voice: permission switch to ${preset} refused for ${String(binding.sessionId)}: ${message}`)
      send({ type: 'error', message: `I could not switch to ${spokenPresetName(preset)}.` })
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
