/**
 * Vesta notify, host plugin. Sends the user a Telegram message through the
 * send-only notifier MCP (`ai-telegram-mcp`, loopback) when something worth a
 * glance happens while no browser tab is looking at the harness: a turn that
 * ran longer than a threshold finished, or an approval / question has been
 * waiting for a decision. Presence comes from the browser half
 * (`ui-vesta-presence`), which heartbeats `POST /api/vesta/notify/presence`
 * while a tab is visible. The bot token never reaches the harness: the MCP
 * server pins the recipient and only takes text.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'

export const name = 'vesta-notify'

/** Required services: the `/api` Connection carrying the presence route. */
export const inject = ['connection']

/** Presence heartbeat route the browser half posts to (`{ visible: boolean }`). */
export const PRESENCE_PATH = '/api/vesta/notify/presence'

/** Deployment facts and thresholds of the notifier. */
export interface Config {
  /** Streamable-HTTP endpoint of the notifier MCP server. @default 'http://127.0.0.1:7335/mcp' */
  url: string
  /** Tool name to call on that server. @default 'notify' */
  tool: string
  /** A finished turn is reported only when it ran at least this long. @default 120 */
  minTurnSeconds: number
  /** An approval or question is reported once it has waited this long. @default 60 */
  approvalWaitSeconds: number
  /** Minimum gap between two messages about the same Session and trigger. @default 300 */
  cooldownSeconds: number
  /** No visible-tab heartbeat for this long means the user is away. @default 90 */
  awayAfterSeconds: number
  /** Report only while away; false reports regardless of presence. @default true */
  onlyWhenAway: boolean
  /** Sessions started with these presets are never reported (incognito). @default ['vesta-incognito'] */
  excludePresets: string[]
  /** Local-time window with no messages, `HH:MM-HH:MM` (may wrap midnight); empty disables. @default '' */
  quietHours: string
  /** Deliver without sound. @default false */
  silent: boolean
  /** Link appended to every message (the harness URL); empty omits it. @default '' */
  linkBase: string
}

/** Validate the notifier configuration. */
export const Config: z<Config> = z.object({
  url: z.string().default('http://127.0.0.1:7335/mcp'),
  tool: z.string().default('notify'),
  minTurnSeconds: z.number().default(120),
  approvalWaitSeconds: z.number().default(60),
  cooldownSeconds: z.number().default(300),
  awayAfterSeconds: z.number().default(90),
  onlyWhenAway: z.boolean().default(true),
  excludePresets: z.array(z.string()).default(['vesta-incognito']),
  quietHours: z.string().default(''),
  silent: z.boolean().default(false),
  linkBase: z.string().default(''),
})

type Trigger = 'turn' | 'approval' | 'question'

interface NotifyConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** Session face the durable-event listener receives; only the id and the history read are used. */
interface SessionLike {
  readonly header?: { readonly agentPreset?: string }
  readonly id: unknown
  snapshotEvents(): Iterable<{ readonly type: string; readonly data?: unknown }>
}

/**
 * Parse `HH:MM-HH:MM` into minutes of the day; undefined when empty or malformed.
 * @param spec - the configured window.
 * @returns start and end minutes, end may be smaller than start (wraps midnight).
 */
export function parseQuietHours(spec: string): { start: number; end: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(spec.trim())
  if (match === null) return undefined
  const [, h1, m1, h2, m2] = match
  const start = Number(h1) * 60 + Number(m1)
  const end = Number(h2) * 60 + Number(m2)
  if (start > 24 * 60 || end > 24 * 60) return undefined
  return { start, end }
}

/**
 * Whether local time `at` falls inside the quiet window.
 * @param spec - the configured window.
 * @param at - the moment to test.
 * @returns true inside the window.
 */
export function inQuietHours(spec: string, at: Date): boolean {
  const window = parseQuietHours(spec)
  if (window === undefined) return false
  const minutes = at.getHours() * 60 + at.getMinutes()
  return window.start <= window.end
    ? minutes >= window.start && minutes < window.end
    : minutes >= window.start || minutes < window.end
}

/**
 * The Session's current title from its durable history (the last `session/title` record).
 * @param session - the Session whose history is read.
 * @returns the title, or undefined when none was ever recorded.
 */
function titleOf(session: SessionLike): string | undefined {
  let title: string | undefined
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'session/title') continue
    const data = event.data as { readonly title?: unknown } | undefined
    if (typeof data?.title === 'string' && data.title.trim() !== '') title = data.title.trim()
  }
  return title
}

/**
 * First line of a text, trimmed to a Telegram-friendly length.
 * @param text - assistant text of the turn.
 * @returns the excerpt, or a placeholder when empty.
 */
function excerpt(text: string | undefined): string {
  const line = (text ?? '').split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  if (line === '') return '(no reply text)'
  return line.length > 240 ? `${line.slice(0, 237)}…` : line
}

/**
 * Deliver one message through the notifier MCP (stateless streamable-HTTP `tools/call`).
 * @param config - endpoint and delivery options.
 * @param title - bold heading.
 * @param message - body text.
 */
async function deliver(config: Config, title: string, message: string): Promise<void> {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: config.tool, arguments: { message, title, silent: config.silent } },
    }),
  })
  if (!response.ok) throw new Error(`vesta-notify: ${config.url} answered ${String(response.status)}`)
  const payload = await response.json() as { error?: { message?: string }; result?: { isError?: boolean } }
  if (payload.error !== undefined) throw new Error(`vesta-notify: ${payload.error.message ?? 'rpc error'}`)
  if (payload.result?.isError === true) throw new Error('vesta-notify: the tool reported an error')
}

/**
 * Observe turns, approvals and questions; report the ones nobody is watching.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const connection = Reflect.get(ctx, 'connection') as NotifyConnection
  const turnStarted = new Map<string, number>()
  const turnText = new Map<string, string>()
  const lastSent = new Map<string, number>()
  let lastVisibleAt = 0

  const away = (): boolean => Date.now() - lastVisibleAt > config.awayAfterSeconds * 1000

  const notify = (sessionId: string, session: SessionLike | undefined, trigger: Trigger, body: string): void => {
    const preset = session?.header?.agentPreset
    if (preset !== undefined && config.excludePresets.includes(preset)) return
    if (config.onlyWhenAway && !away()) return
    if (inQuietHours(config.quietHours, new Date())) return
    const key = `${sessionId}:${trigger}`
    const last = lastSent.get(key) ?? 0
    if (Date.now() - last < config.cooldownSeconds * 1000) return
    lastSent.set(key, Date.now())
    const title = `Vesta · ${(session !== undefined ? titleOf(session) : undefined) ?? sessionId.slice(0, 16)}`
    const message = config.linkBase === '' ? body : `${body}\n${config.linkBase}`
    deliver(config, title, message).then(
      () => { ctx.logger.info(`vesta-notify: sent (${trigger}) for ${sessionId}`) },
      (error: unknown) => { ctx.logger.warn(error) },
    )
  }

  ctx.effect(() => {
    const dispose = connection.fetch.register({
      path: PRESENCE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        let visible = false
        try {
          const body = await request.json() as { visible?: unknown }
          visible = body.visible === true
        } catch {
          visible = false
        }
        if (visible) lastVisibleAt = Date.now()
        return Response.json({ ok: true, away: away() })
      },
    })
    return () => { void dispose() }
  }, 'vesta-notify: presence route')

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const record = event as { readonly type: string; readonly data?: unknown }
    const id = String(session.id)
    if (record.type === 'turn/start') {
      turnStarted.set(id, Date.now())
      turnText.set(id, '')
      return
    }
    if (record.type !== 'turn/end') return
    const started = turnStarted.get(id)
    turnStarted.delete(id)
    if (started === undefined) return
    const seconds = Math.round((Date.now() - started) / 1000)
    if (seconds < config.minTurnSeconds) return
    notify(id, session, 'turn', `Turn finished after ${String(seconds)} s.\n${excerpt(turnText.get(id))}`)
  }), 'vesta-notify: turn observer')

  ctx.effect(() => ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type !== 'chunk' || frame.chunk.type !== 'text-delta') return
    const id = String(agent.session.id)
    turnText.set(id, (turnText.get(id) ?? '') + frame.chunk.text)
  }), 'vesta-notify: assistant text')

  // Passive observers at the front of both waterfalls: record, wait for the
  // real answerer, then forget. A voice bridge registered later sits ahead of
  // these and may settle a request without reaching them (the caller is present).
  ctx.effect(() => ctx.on('approval/request', async (request, next) => {
    const agent = request.agent
    const id = String(agent.session.id)
    const reason = request.reason === undefined || request.reason === '' ? '' : `\n${request.reason}`
    const timer = setTimeout(() => {
      notify(id, agent.session, 'approval', `Approval waiting for ${request.toolName}.${reason}`)
    }, config.approvalWaitSeconds * 1000)
    try {
      return await next()
    } finally {
      clearTimeout(timer)
    }
  }, { prepend: true }), 'vesta-notify: approval observer')

  ctx.effect(() => ctx.on('user-questions/request', async (request, next) => {
    const agent = request.agent
    if (agent === undefined) return next()
    const id = String(agent.session.id)
    const first = request.questions[0]?.question
    const timer = setTimeout(() => {
      notify(id, agent.session, 'question', `Question waiting for you.${typeof first === 'string' ? `\n${first}` : ''}`)
    }, config.approvalWaitSeconds * 1000)
    try {
      return await next()
    } finally {
      clearTimeout(timer)
    }
  }, { prepend: true }), 'vesta-notify: question observer')
}
