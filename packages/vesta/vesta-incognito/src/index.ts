/**
 * Vesta incognito, host plugin. A session that starts with an incognito preset
 * leaves nothing behind: the memory MCP's writing tools are refused on the
 * `tools/pre-execute` waterfall, the title is pinned at creation so no title
 * request carries the conversation, the notifier skips it (vesta-notify's
 * `excludePresets`), and the session directory plus every registry trace is
 * wiped when the session is closed, archived, or found on disk at the next
 * boot. Closing a live session uses the fork's `sessionController.close`.
 * Roadmap M4 (VESTA-PLAN.md).
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'

export const name = 'vesta-incognito'

/** Required services: Session store, Session controller (close, rename), the workspace registry and session persistence. */
export const inject = ['sessions', 'sessionController', 'workspaceRegistry', 'sessionPersistence']

/** Which presets are incognito and what the plugin refuses. */
export interface Config {
  /** Preset ids treated as incognito. @default ['vesta-incognito'] */
  presets: string[]
  /** Title pinned at creation (a user rename, so no title generation runs). @default 'Incognito' */
  title: string
  /** Tool names refused in an incognito session. @default the memory MCP's writing tools */
  denyTools: string[]
}

export const Config: z<Config> = z.object({
  presets: z.array(z.string()).default(['vesta-incognito']),
  title: z.string().default('Incognito'),
  denyTools: z.array(z.string()).default([
    'mcp__memory__memory_write',
    'mcp__memory__memory_edit',
    'mcp__memory__memory_delete',
  ]),
})

const WIPE_DELAY_MS = 500

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
 * Refuse memory writes, pin the title, and wipe incognito sessions when they end.
 * @param ctx - host plugin context.
 * @param config - presets, pinned title, refused tools.
 */
export function apply(ctx: Context, config: Config): void {
  const incognitoPreset = (preset: string | undefined): boolean => preset !== undefined && config.presets.includes(preset)
  const isIncognito = (session: Session): boolean => incognitoPreset(session.header.agentPreset)
  const wiping = new Set<string>()

  const wipe = async (sessionId: SessionId, why: string): Promise<void> => {
    if (wiping.has(sessionId)) return
    wiping.add(sessionId)
    try {
      if (ctx.sessions.get(sessionId) !== undefined) {
        const closed = await ctx.sessionController.close(sessionId)
        if (!closed) {
          ctx.logger.warn(`vesta-incognito: ${sessionId} is live and not closable; wipe deferred to the next boot`)
          return
        }
      }
      const directory = await sessionDirectory(sessionId)
      if (directory !== undefined) await rm(directory, { recursive: true, force: true })
      await ctx.workspaceRegistry.forgetSession(sessionId)
      ctx.emit('api-session/removed', sessionId)
      ctx.logger.info(`vesta-incognito: wiped ${sessionId} (${why})`)
    } catch (error: unknown) {
      ctx.logger.warn(`vesta-incognito: wipe of ${sessionId} failed (${why}): ${String(error)}`)
    } finally {
      wiping.delete(sessionId)
    }
  }

  /** Stored incognito sessions that are not live: the boot sweep and the archive check. */
  const storedIncognito = async (): Promise<SessionId[]> => {
    const snapshots = await ctx.sessionPersistence.list()
    return snapshots
      .filter(snapshot => incognitoPreset(snapshot.header.agentPreset))
      .map(snapshot => snapshot.header.id)
  }

  // 1. Memory writes are refused.
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const session = exec.agent?.session
    if (session !== undefined && isIncognito(session) && config.denyTools.includes(exec.name)) {
      return { kind: 'deny', reason: `incognito session: ${exec.name} is switched off; nothing from this conversation is kept` }
    }
    return next()
  }), 'vesta-incognito: refuse memory writes')

  // 2. The title is pinned at creation (a user rename), so no title request runs.
  const pin = async (session: Session, attempt: number): Promise<void> => {
    if (ctx.sessions.get(session.id) !== session) return
    try {
      await ctx.sessionController.rename({ sessionId: session.id, title: config.title })
    } catch (error: unknown) {
      if (attempt < 4) {
        setTimeout(() => { void pin(session, attempt + 1) }, 400)
        return
      }
      ctx.logger.warn(`vesta-incognito: could not pin the title of ${session.id}: ${String(error)}`)
    }
  }
  ctx.effect(() => ctx.on('session/created', (session) => {
    if (session.header.parentSession !== undefined || !isIncognito(session)) return
    // oxlint-disable-next-line typescript/no-deprecated -- freshness check at creation; a projection later
    if (session.snapshotEvents().some(event => event.type === 'turn/start')) return
    setTimeout(() => { void pin(session, 0) }, 0)
  }), 'vesta-incognito: pin the title')

  // 3. Wipe when the live session goes away (close, shutdown) — best effort; the boot sweep is the backstop.
  ctx.effect(() => ctx.on('session/disposed', (session) => {
    if (session.header.parentSession !== undefined || !isIncognito(session)) return
    setTimeout(() => { void wipe(session.id, 'disposed') }, WIPE_DELAY_MS)
  }), 'vesta-incognito: wipe on dispose')

  // 4. Archiving an incognito session closes and wipes it: "archive" is the one-click way out.
  ctx.effect(() => ctx.on('domain/changed', (change: DomainChanged) => {
    if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
    // The registry's own getter lags this event (it updates after the write
    // resolves), so the new archive set is read from the written value.
    const value = change.value as { archivedSessionIds?: unknown }
    if (!Array.isArray(value.archivedSessionIds)) return
    const archived = new Set<string>(value.archivedSessionIds.map(String))
    void (async () => {
      for (const session of ctx.sessions.list()) {
        if (archived.has(session.id) && isIncognito(session)) await wipe(session.id, 'archived')
      }
      for (const sessionId of await storedIncognito()) {
        if (archived.has(sessionId) && ctx.sessions.get(sessionId) === undefined) await wipe(sessionId, 'archived')
      }
    })()
  }), 'vesta-incognito: wipe on archive')

  // 5. Boot sweep: whatever an earlier run left behind.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        for (const sessionId of await storedIncognito()) {
          if (ctx.sessions.get(sessionId) === undefined) await wipe(sessionId, 'boot sweep')
        }
      })()
    }, 5000)
    return () => { clearTimeout(timer) }
  }, 'vesta-incognito: boot sweep')
}
