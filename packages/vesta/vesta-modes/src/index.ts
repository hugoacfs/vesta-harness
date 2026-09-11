/**
 * Vesta modes, host plugin. A mode is an agent preset plus the two settings the
 * harness applies when a session starts with it: the permission tier and the
 * reasoning level. Both are keyed on the session's creation preset
 * (`session.header.agentPreset`) and applied once, to a session that has not
 * produced a turn yet, so a change made by hand or by voice later in the
 * session is never undone by a resume. Roadmap stream M (VESTA-PLAN.md).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'

export const name = 'vesta-modes'

/** Required services: the Session store, the Session controller (model selection) and the permission presets. */
export const inject = ['sessions', 'sessionController', 'permissionPresets']

/** What one mode applies at session start; either field may be left out. */
export interface ModeSettings {
  /** Permission preset name, e.g. `danger-full-access`, `workspace-write`, `read-only`. */
  permission?: string
  /** Reasoning level name the routed model declares, e.g. `xhigh` or `off`. */
  reasoning?: string
}

/** Preset id → settings. Presets absent from the map are left alone. */
export interface Config {
  modes: Record<string, ModeSettings>
}

export const Config: z<Config> = z.object({
  modes: z.dict(z.object({
    permission: z.string(),
    reasoning: z.string(),
  })).default({}),
})

const RETRY_DELAY_MS = 400
const RETRIES = 4

function hasTurn(session: Session): boolean {
  // oxlint-disable-next-line typescript/no-deprecated -- freshness check at creation; a projection later
  return session.snapshotEvents().some(event => event.type === 'turn/start')
}

/**
 * Apply each mode's permission tier and reasoning level when a session starts with its preset.
 * @param ctx - host plugin context.
 * @param config - preset id → settings.
 */
export function apply(ctx: Context, config: Config): void {
  const applyMode = async (session: Session, attempt: number): Promise<void> => {
    const preset = session.header.agentPreset
    if (preset === undefined) return
    const mode = config.modes[preset]
    if (mode === undefined) return
    if (session.header.parentSession !== undefined) return
    if (ctx.sessions.get(session.id) !== session) return
    if (hasTurn(session)) return
    try {
      if (mode.permission !== undefined) ctx.permissionPresets.set(session, mode.permission)
      if (mode.reasoning !== undefined) {
        const route = ctx.get('agentDefaultModel')?.currentSelection()
        if (route === undefined) throw new Error('no default model selection yet')
        await ctx.sessionController.selectModel({
          sessionId: session.id,
          provider: route.provider,
          model: route.model,
          reasoningEffort: mode.reasoning,
        })
      }
      ctx.logger.info(`vesta-modes: ${session.id} started as ${preset} (${mode.permission ?? 'permission unchanged'}, reasoning ${mode.reasoning ?? 'unchanged'})`)
    } catch (error: unknown) {
      if (attempt < RETRIES) {
        setTimeout(() => { void applyMode(session, attempt + 1) }, RETRY_DELAY_MS)
        return
      }
      ctx.logger.warn(`vesta-modes: could not apply ${preset} to ${session.id}: ${String(error)}`)
    }
  }
  ctx.effect(() => ctx.on('session/created', (session) => {
    setTimeout(() => { void applyMode(session, 0) }, 0)
  }), 'vesta-modes: apply at session start')
}
