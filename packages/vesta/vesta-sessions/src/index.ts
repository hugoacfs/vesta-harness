/**
 * Vesta session management, host plugin. Three browser-facing routes under the
 * authenticated `/api` channel: the archived sessions with their titles, restore
 * one to the sidebar, and delete one for good — after its directory has been
 * exported as a tarball, and only while nothing has it open. The registry
 * methods it relies on (`unarchiveSession`, `forgetSession`) are the fork's
 * additions to `@deepseek-ai/dsh-workspace` (VESTA.md → fork patches).
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-vesta-routines/types'
import z from '@deepseek-ai/schemastery'

export const name = 'vesta-sessions'

/** Required services: the `/api` Connection, the workspace registry, and the Session controller. */
export const inject = ['connection', 'workspaceRegistry', 'sessionController']

export const ARCHIVED_PATH = '/api/vesta/sessions/archived'
export const UNARCHIVE_PATH = '/api/vesta/sessions/unarchive'
export const DELETE_PATH = '/api/vesta/sessions/delete'

/** Where deleted sessions are exported before removal. */
export interface Config {
  /** Directory for the export tarballs; a leading `~/` is the home directory. @default '~/backups/sessions-deleted' */
  exportDir: string
}

export const Config: z<Config> = z.object({
  exportDir: z.string().default('~/backups/sessions-deleted'),
})

const SESSION_ID = /^session-[0-9a-f-]{36}$/u
const run = promisify(execFile)

interface SessionsConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** An archived session as the panel shows it. */
export interface ArchivedSession {
  readonly sessionId: string
  readonly title: string
  readonly updatedAt: number
  readonly cwd: string
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

async function readBody(request: Request): Promise<SessionId | Response> {
  let body: { sessionId?: unknown }
  try {
    body = (await request.json()) as { sessionId?: unknown }
  } catch {
    return new Response('body must be JSON', { status: 400 })
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (!SESSION_ID.test(sessionId)) return new Response('expected { sessionId: "session-<uuid>" }', { status: 400 })
  return sessionId as SessionId
}

/**
 * The on-disk directory of a stored session: `$DSH_HOME/sessions/<workspace>/<sessionId>`.
 * @param sessionId - validated session id.
 * @returns the directory, or undefined when no workspace directory holds it.
 */
async function sessionDirectory(sessionId: string): Promise<string | undefined> {
  const base = dshHomePath('sessions')
  let workspaces: string[]
  try {
    workspaces = await readdir(base)
  } catch {
    return undefined
  }
  for (const workspace of workspaces) {
    const candidate = join(base, workspace, sessionId)
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch {
      // not under this workspace directory
    }
  }
  return undefined
}

/**
 * Register the three routes.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const connection = Reflect.get(ctx, 'connection') as SessionsConnection
  const registry = ctx.workspaceRegistry
  const controller = ctx.sessionController

  const archived = async (): Promise<Response> => {
    const ids = new Set<string>(registry.archivedSessionIds)
    // Routine threads are archived by design and belong to the Routines page.
    const threads = ctx.get('vestaRoutines')?.threadSessionIds()
    const { items } = await controller.list({}, new AbortController().signal)
    const rows: ArchivedSession[] = items
      .filter(item => ids.has(item.sessionId) && !(threads?.has(item.sessionId) ?? false))
      .map((item) => {
        const title: unknown = item.projections?.values.title
        return {
          sessionId: item.sessionId,
          title: typeof title === 'string' ? title.trim() : '',
          updatedAt: item.updatedAt,
          cwd: item.cwd ?? '',
        }
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
    return Response.json({ items: rows })
  }

  const unarchive = async (request: Request): Promise<Response> => {
    const parsed = await readBody(request)
    if (parsed instanceof Response) return parsed
    if (!registry.archivedSessionIds.includes(parsed)) return new Response('that session is not archived', { status: 404 })
    await registry.unarchiveSession(parsed)
    ctx.logger.info(`vesta-sessions: restored ${parsed}`)
    return Response.json({ ok: true })
  }

  const remove = async (request: Request): Promise<Response> => {
    const parsed = await readBody(request)
    if (parsed instanceof Response) return parsed
    if (ctx.get('sessions')?.get(parsed) !== undefined) {
      // A live session is closed first (the fork's controller.close); only a
      // session this controller does not hold (a subagent, a config-created
      // agent) is refused.
      const closed = await controller.close(parsed)
      if (!closed) return new Response('that session is open and cannot be closed from here', { status: 409 })
    }
    const directory = await sessionDirectory(parsed)
    if (directory === undefined) return new Response('no stored session with that id', { status: 404 })
    const exportDir = expandHome(config.exportDir)
    await mkdir(exportDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const exported = join(exportDir, `${parsed}-${stamp}.tar.gz`)
    await run('tar', ['-czf', exported, '-C', join(directory, '..'), parsed])
    await rm(directory, { recursive: true, force: true })
    await registry.forgetSession(parsed)
    // The same frame the controller sends when a live Session goes away; every
    // connected browser drops the row.
    ctx.emit('api-session/removed', parsed)
    ctx.logger.info(`vesta-sessions: deleted ${parsed} (exported to ${exported})`)
    return Response.json({ ok: true, exported })
  }

  ctx.effect(() => {
    const disposers = [
      connection.fetch.register({ path: ARCHIVED_PATH, methods: ['GET'], requestBody: 'buffered', fetch: () => archived() }),
      connection.fetch.register({ path: UNARCHIVE_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => unarchive(request) }),
      connection.fetch.register({ path: DELETE_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => remove(request) }),
    ]
    return () => {
      for (const dispose of disposers) void dispose()
    }
  }, 'vesta-sessions: routes')
}
