/**
 * Vesta login, host plugin. A browser without a session gets a login page in
 * place of the launch-token 401: one tap sends a six-digit code to Hugo's
 * Telegram through the send-only notifier MCP (the harness never holds the
 * chat id), and the code typed back mints the ordinary browser-session cookie
 * through the connection service's fork hook, so the rest of the app is
 * untouched. Only a request carrying an allowed tailnet identity header may
 * ask for or redeem a code; the code is bound to the browser that asked for it
 * by a short pending cookie, lives five minutes, allows five tries and is
 * spent on use. The launch-token exchange keeps working beside it (scripts).
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CodeDesk } from './codes.ts'
import type { CheckOutcome, IssueRefusal } from './codes.ts'
import { renderPage } from './page.ts'
import type { PageState } from './page.ts'

export const name = 'vesta-login'
export const inject = ['connection', 'webServer']

/** Plugin settings. */
export interface Config {
  /** Which harness this is, in the page title and the Telegram message. @default 'vesta' */
  label: string
  /** The send-only notifier MCP (`ai-telegram-mcp`). @default 'http://127.0.0.1:7335/mcp' */
  notifyUrl: string
  /** Its tool. @default 'notify' */
  tool: string
  /** Request header carrying the tailnet identity; Tailscale Serve sets it. @default 'tailscale-user-login' */
  identityHeader: string
  /** Identities allowed to sign in; empty means the header is not checked. @default [] */
  identities: string[]
  /** Digits in a code. @default 6 */
  digits: number
  /** Seconds a code may be redeemed. @default 300 */
  ttlSeconds: number
  /** Wrong tries a code survives. @default 5 */
  maxAttempts: number
  /** Seconds between two codes for one identity. @default 30 */
  cooldownSeconds: number
  /** Codes one identity may request per hour. @default 10 */
  hourlyLimit: number
}

/** Validate the plugin configuration. */
export const Config: z<Config> = z.object({
  label: z.string().default('vesta'),
  notifyUrl: z.string().default('http://127.0.0.1:7335/mcp'),
  tool: z.string().default('notify'),
  identityHeader: z.string().default('tailscale-user-login'),
  identities: z.array(z.string()).default([]),
  digits: z.number().default(6),
  ttlSeconds: z.number().default(300),
  maxAttempts: z.number().default(5),
  cooldownSeconds: z.number().default(30),
  hourlyLimit: z.number().default(10),
})

/** The connection service's fork hooks (structural, no package import). */
export interface LoginConnection {
  issueBrowserSession(request: IncomingMessage, response: ServerResponse): boolean
  setUnauthorizedResponder(responder: ((request: IncomingMessage, response: ServerResponse) => boolean) | undefined): void
}

/** The web server's route registry (structural). */
export interface LoginWebServer {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The route prefix, under the app's mount. */
export const AUTH_PATH = '/auth'
const MAX_BODY_BYTES = 4096
const PENDING_COOKIE_PREFIX = 'dsh-login-'
/** Identity recorded when the header is not checked. */
const ANYONE = 'anyone'

/** The mount path with a trailing slash, from `DSH_BASE_PATH` (the reverse proxy strips it before the request arrives). */
export function mountPath(): string {
  const raw = (process.env.DSH_BASE_PATH ?? '').trim()
  if (raw === '' || raw === '/') return '/'
  const lead = raw.startsWith('/') ? raw : `/${raw}`
  return lead.endsWith('/') ? lead : `${lead}/`
}

function pendingCookieName(mount: string): string {
  return PENDING_COOKIE_PREFIX + createHash('sha256').update(mount).digest('base64url').slice(0, 16)
}

/**
 * Read one cookie by exact name.
 * @param header - the Cookie header, if any.
 * @param name - the cookie's name.
 * @returns the value, or undefined.
 */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1)
  }
  return undefined
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()]
  return typeof value === 'string' ? value : undefined
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY_BYTES) return new URLSearchParams()
    chunks.push(buffer)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

/** The people-facing line for each outcome, shown above the form after a redirect. */
const NOTICES: Readonly<Record<string, string>> = {
  sent: 'Code sent.',
  wrong: 'That code is not right.',
  expired: 'That code has expired; send a new one.',
  tries: 'Too many wrong tries; send a new code.',
  unknown: 'No code is pending for this browser; send one.',
  cooldown: 'A code was sent a moment ago; wait half a minute.',
  hourly: 'Too many codes this hour; try later.',
  failed: 'Telegram could not be reached; try again.',
  nocode: 'Type the code.',
}

/**
 * Send one message through the notifier MCP.
 * @param url - the MCP endpoint.
 * @param tool - its send tool.
 * @param title - message title.
 * @param message - message text.
 */
async function telegram(url: string, tool: string, title: string, message: string): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: tool, arguments: { message, title, silent: false } },
    }),
  })
  if (!response.ok) throw new Error(`vesta-login: ${url} answered ${String(response.status)}`)
  const payload = await response.json() as { error?: { message?: string }; result?: { isError?: boolean } }
  if (payload.error !== undefined) throw new Error(`vesta-login: ${payload.error.message ?? 'rpc error'}`)
  if (payload.result?.isError === true) throw new Error('vesta-login: the notifier reported an error')
}

/** Collaborators a test may replace. */
export interface LoginDeps {
  readonly send?: typeof telegram
  readonly desk?: CodeDesk
}

/**
 * Build the route handler and the unauthorized responder for one harness.
 * @param config - resolved plugin config.
 * @param connection - the connection service's fork hooks.
 * @param log - where to note sends and refusals (never a code).
 * @param deps - replaceable Telegram transport and code desk.
 * @returns the pieces `apply` registers.
 */
export function createLogin(
  config: Config,
  connection: Pick<LoginConnection, 'issueBrowserSession'>,
  log: { info(message: string): void; warn(message: unknown): void },
  deps: LoginDeps = {},
): {
  readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  readonly unauthorized: (req: IncomingMessage, res: ServerResponse) => boolean
} {
  const mount = mountPath()
  const page = `${mount}auth/`
  const cookieName = pendingCookieName(mount)
  const allowed = new Set(config.identities.map(identity => identity.trim().toLowerCase()).filter(identity => identity !== ''))
  const desk = deps.desk ?? new CodeDesk({
    digits: config.digits,
    ttlMs: config.ttlSeconds * 1000,
    maxAttempts: config.maxAttempts,
    cooldownMs: config.cooldownSeconds * 1000,
    hourlyLimit: config.hourlyLimit,
  })
  const send = deps.send ?? telegram

  const identityOf = (req: IncomingMessage): { readonly identity: string | undefined; readonly allowed: boolean } => {
    if (allowed.size === 0) return { identity: ANYONE, allowed: true }
    const identity = headerValue(req, config.identityHeader)?.trim().toLowerCase()
    return { identity, allowed: identity !== undefined && allowed.has(identity) }
  }

  const redirect = (res: ServerResponse, notice: string | undefined, cookie?: string): void => {
    if (cookie !== undefined) res.setHeader('set-cookie', cookie)
    res.writeHead(303, {
      'cache-control': 'no-store',
      location: notice === undefined ? page : `${page}?n=${notice}`,
      'referrer-policy': 'no-referrer',
    })
    res.end()
  }

  const refuse = (res: ServerResponse, status: number, text: string): void => {
    res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    res.end(`${text}\n`)
  }

  const showPage = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const who = identityOf(req)
    const pendingId = cookieValue(headerValue(req, 'cookie'), cookieName)
    const state: PageState = pendingId !== undefined && desk.pending(pendingId) ? 'sent' : 'ask'
    const key = url.searchParams.get('n') ?? ''
    const notice = NOTICES[key]
    res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
    res.end(req.method === 'HEAD' ? undefined : renderPage({
      mount,
      label: config.label,
      state,
      ...(notice === undefined ? {} : { notice }),
      ...(who.identity === undefined || who.identity === ANYONE ? {} : { identity: who.identity }),
      allowed: who.allowed,
    }))
  }

  const sendCode = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const who = identityOf(req)
    if (!who.allowed || who.identity === undefined) {
      log.info(`vesta-login: refused a code request from ${who.identity ?? 'no identity'}`)
      refuse(res, 403, 'this harness does not know you')
      return
    }
    const issued = desk.issue(who.identity)
    if (!issued.ok) {
      const reason: IssueRefusal = issued.reason
      log.info(`vesta-login: ${reason} for ${who.identity}`)
      redirect(res, reason)
      return
    }
    const spaced = `${issued.code.slice(0, 3)} ${issued.code.slice(3)}`
    try {
      await send(
        config.notifyUrl,
        config.tool,
        `${config.label} · sign in`,
        `Sign-in code for ${config.label}: ${spaced}\nIt lives five minutes. If you did not ask for it, ignore it.`,
      )
    } catch (error) {
      log.warn(error)
      redirect(res, 'failed')
      return
    }
    log.info(`vesta-login: code sent for ${who.identity}`)
    const maxAge = config.ttlSeconds + 60
    redirect(res, 'sent', `${cookieName}=${issued.id}; Max-Age=${String(maxAge)}; Path=${mount}; HttpOnly; SameSite=Strict`)
  }

  const verify = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const who = identityOf(req)
    if (!who.allowed || who.identity === undefined) {
      refuse(res, 403, 'this harness does not know you')
      return
    }
    const pendingId = cookieValue(headerValue(req, 'cookie'), cookieName)
    const code = (await readForm(req)).get('code')?.trim() ?? ''
    if (code === '') {
      redirect(res, 'nocode')
      return
    }
    const outcome: CheckOutcome = pendingId === undefined ? 'unknown' : desk.check(pendingId, code, who.identity)
    if (outcome !== 'ok') {
      log.info(`vesta-login: ${outcome} code for ${who.identity}`)
      redirect(res, outcome)
      return
    }
    log.info(`vesta-login: signed in ${who.identity} for a new browser`)
    if (!connection.issueBrowserSession(req, res)) refuse(res, 400, 'the request carries no Host')
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const sub = url.pathname === AUTH_PATH ? '/' : url.pathname.slice(AUTH_PATH.length)
    if (sub === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
      showPage(req, res, url)
    } else if (sub === '/send' && req.method === 'POST') {
      await sendCode(req, res)
    } else if (sub === '/verify' && req.method === 'POST') {
      await verify(req, res)
    } else {
      refuse(res, 404, 'not found')
    }
  }

  const unauthorized = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    res.writeHead(303, { 'cache-control': 'no-store', location: page, 'referrer-policy': 'no-referrer' })
    res.end()
    return true
  }

  return { handler, unauthorized }
}

/**
 * Register the login routes and take over the unauthenticated index response.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const connection = Reflect.get(ctx, 'connection') as LoginConnection
  const webServer = Reflect.get(ctx, 'webServer') as LoginWebServer
  const login = createLogin(config, connection, ctx.logger)
  ctx.effect(() => webServer.register({ kind: 'prefix', path: AUTH_PATH, handler: login.handler }), 'vesta-login: routes')
  ctx.effect(() => {
    connection.setUnauthorizedResponder(login.unauthorized)
    return () => { connection.setUnauthorizedResponder(undefined) }
  }, 'vesta-login: login page instead of the 401')
}
