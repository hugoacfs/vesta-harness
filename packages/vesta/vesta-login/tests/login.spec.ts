import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cookieValue, createLogin, mountPath } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { CodeDesk } from '../src/codes.ts'
import { renderPage } from '../src/page.ts'

interface Written {
  status: number
  headers: Record<string, string>
  body: string
}

function request(method: string, url: string, headers: Record<string, string> = {}, body = ''): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(stream, { method, url, headers })
  return stream
}

function response(): { res: ServerResponse; written: Written } {
  const written: Written = { status: 0, headers: {}, body: '' }
  const res = {
    setHeader(name: string, value: string) { written.headers[name.toLowerCase()] = value },
    writeHead(status: number, headers?: Record<string, string>) {
      written.status = status
      for (const [key, value] of Object.entries(headers ?? {})) written.headers[key.toLowerCase()] = value
      return res
    },
    end(body?: string) { written.body = body ?? '' },
  } as unknown as ServerResponse
  return { res, written }
}

function login(overrides: Partial<Config> = {}, sendFails = false) {
  const sent: string[] = []
  const minted: string[] = []
  const config: Config = {
    label: 'vesta',
    notifyUrl: 'http://127.0.0.1:7335/mcp',
    tool: 'notify',
    identityHeader: 'tailscale-user-login',
    identities: ['hugo@example.com'],
    digits: 6,
    ttlSeconds: 300,
    maxAttempts: 5,
    cooldownSeconds: 30,
    hourlyLimit: 10,
    ...overrides,
  }
  const desk = new CodeDesk({ digits: 6, ttlMs: 300_000, maxAttempts: 5, cooldownMs: 0, hourlyLimit: 100, randomDigit: () => 4 })
  const connection = {
    issueBrowserSession(req: IncomingMessage, res: ServerResponse) {
      minted.push(req.headers.host ?? '')
      res.writeHead(303, { location: '/harness/', 'set-cookie': 'dsh-auth-x=y' })
      res.end()
      return true
    },
  }
  const log = { info() {}, warn() {} }
  const send = async (_url: string, _tool: string, _title: string, message: string): Promise<void> => {
    if (sendFails) throw new Error('down')
    sent.push(message)
  }
  return { ...createLogin(config, connection, log, { send, desk }), sent, minted }
}

const HUGO = { host: 'vesta.example', 'tailscale-user-login': 'Hugo@Example.com' }

describe('vesta-login', () => {
  beforeEach(() => { process.env.DSH_BASE_PATH = '/harness' })
  afterEach(() => { delete process.env.DSH_BASE_PATH })

  it('reads the mount path from DSH_BASE_PATH', () => {
    expect(mountPath()).toBe('/harness/')
    delete process.env.DSH_BASE_PATH
    expect(mountPath()).toBe('/')
  })

  it('sends an unauthenticated page load to the login page', () => {
    const { unauthorized } = login()
    const { res, written } = response()
    expect(unauthorized(request('GET', '/', HUGO), res)).toBe(true)
    expect(written.status).toBe(303)
    expect(written.headers.location).toBe('/harness/auth/')
    expect(unauthorized(request('POST', '/', HUGO), response().res)).toBe(false)
  })

  it('shows the page with the offer to send a code for an allowed identity', async () => {
    const { handler } = login()
    const { res, written } = response()
    await handler(request('GET', '/auth/', HUGO), res)
    expect(written.status).toBe(200)
    expect(written.body).toContain('Send me a code on Telegram')
    expect(written.body).toContain('hugo@example.com')
    expect(written.body).toContain('<base href="/harness/">')
  })

  it('refuses a browser without the identity header, and one not on the list', async () => {
    const { handler, sent } = login()
    const nobody = response()
    await handler(request('GET', '/auth/', { host: 'vesta.example' }), nobody.res)
    expect(nobody.written.body).toContain('not on the tailnet')
    expect(nobody.written.body).not.toContain('<form')
    const other = response()
    await handler(request('POST', '/auth/send', { host: 'vesta.example', 'tailscale-user-login': 'other@example.com' }), other.res)
    expect(other.written.status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  it('sends a code, binds it to the browser, and signs the right code in', async () => {
    const { handler, sent, minted } = login()
    const first = response()
    await handler(request('POST', '/auth/send', HUGO), first.res)
    expect(first.written.status).toBe(303)
    expect(first.written.headers.location).toBe('/harness/auth/?n=sent')
    expect(sent).toEqual(['Sign-in code for vesta: 444 444\nIt lives five minutes. If you did not ask for it, ignore it.'])
    const cookie = first.written.headers['set-cookie'] ?? ''
    expect(cookie).toMatch(/^dsh-login-[A-Za-z0-9_-]+=[A-Za-z0-9_-]+; Max-Age=360; Path=\/harness\/; HttpOnly; SameSite=Strict$/u)
    const pending = cookie.split(';')[0] ?? ''
    const page = response()
    await handler(request('GET', '/auth/?n=sent', { ...HUGO, cookie: pending }), page.res)
    expect(page.written.body).toContain('Code sent.')
    expect(page.written.body).toContain('name="code"')
    const wrong = response()
    await handler(request('POST', '/auth/verify', { ...HUGO, cookie: pending, 'content-type': 'application/x-www-form-urlencoded' }, 'code=123456'), wrong.res)
    expect(wrong.written.headers.location).toBe('/harness/auth/?n=wrong')
    expect(minted).toHaveLength(0)
    const right = response()
    await handler(request('POST', '/auth/verify', { ...HUGO, cookie: pending, 'content-type': 'application/x-www-form-urlencoded' }, 'code=444+444'), right.res)
    expect(minted).toEqual(['vesta.example'])
    expect(right.written.status).toBe(303)
    expect(right.written.headers.location).toBe('/harness/')
  })

  it('reports a Telegram failure instead of a sent code', async () => {
    const { handler } = login({}, true)
    const { res, written } = response()
    await handler(request('POST', '/auth/send', HUGO), res)
    expect(written.headers.location).toBe('/harness/auth/?n=failed')
    expect(written.headers['set-cookie']).toBeUndefined()
  })

  it('needs a pending code and a typed code to verify', async () => {
    const { handler, minted } = login()
    const empty = response()
    await handler(request('POST', '/auth/verify', HUGO, 'code='), empty.res)
    expect(empty.written.headers.location).toBe('/harness/auth/?n=nocode')
    const stray = response()
    await handler(request('POST', '/auth/verify', HUGO, 'code=444444'), stray.res)
    expect(stray.written.headers.location).toBe('/harness/auth/?n=unknown')
    expect(minted).toHaveLength(0)
  })

  it('answers 404 elsewhere under the prefix and checks nobody when the list is empty', async () => {
    const { handler, sent } = login({ identities: [] })
    const missing = response()
    await handler(request('GET', '/auth/nothing', { host: 'vesta.example' }), missing.res)
    expect(missing.written.status).toBe(404)
    const open = response()
    await handler(request('POST', '/auth/send', { host: 'vesta.example' }), open.res)
    expect(open.written.headers.location).toBe('/harness/auth/?n=sent')
    expect(sent).toHaveLength(1)
  })

  it('reads cookies by exact name and escapes what the page shows', () => {
    expect(cookieValue('a=1; dsh-login-x=abc; b=2', 'dsh-login-x')).toBe('abc')
    expect(cookieValue(undefined, 'dsh-login-x')).toBeUndefined()
    const html = renderPage({ mount: '/h/', label: '<vesta>', state: 'ask', identity: 'a<b', allowed: false })
    expect(html).toContain('&lt;vesta&gt;')
    expect(html).toContain('a&lt;b is on the tailnet but not on this harness')
  })
})
