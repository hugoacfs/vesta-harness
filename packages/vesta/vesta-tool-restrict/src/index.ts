/**
 * Vesta tool restriction, host plugin (roadmap T12 v2): agents composed from a
 * listed preset see only the tools named for it. Upstream's `tools.restrict`
 * mask filters what a scope inherits and never that scope's own registrations,
 * and it is validated from the scope it is registered in — so a preset row
 * cannot name the preset's own tools, while an agent below the preset inherits
 * them. The mask is therefore applied per agent, from the agent's own scope,
 * at `agent/created` (creation and resume alike), exactly as upstream's
 * delegation runtime filters a child agent. Tools registered per agent
 * (reminders) stay visible regardless. With PTC presentation this keeps the
 * generated SDK small.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'vesta-tool-restrict'

/** Required services: the agent registry (for the event) and the preset roster (which preset an agent runs). */
export const inject = ['agents', 'agentPresets']

/** One preset's visible tool list. */
export interface PresetRule {
  /** Tool names that stay visible; every other inherited tool is hidden. */
  allow: string[]
}

export interface Config {
  /** Preset id → rule. Presets absent from the map are left alone. */
  presets: Record<string, PresetRule>
}

export const Config: z<Config> = z.object({
  presets: z.dict(z.object({ allow: z.array(z.string()).default([]) })).default({}),
})

/**
 * Mask each new agent of a listed preset from its own scope.
 * @param ctx - host plugin context.
 * @param config - preset id → allow list.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    const preset = ctx.agentPresets.composedPreset(agent.ctx) ?? agent.session.header.agentPreset
    const rule = preset === undefined ? undefined : config.presets[preset]
    if (rule === undefined) return
    try {
      agent.ctx.tools.restrict({ allow: rule.allow })
      ctx.logger.info(`vesta-tool-restrict: ${agent.id} (${preset}) sees ${rule.allow.length === 0 ? 'no inherited tool' : rule.allow.join(', ')}`)
    } catch (error: unknown) {
      ctx.logger.warn(`vesta-tool-restrict: ${agent.id} (${preset}): mask not applied: ${error instanceof Error ? error.message : String(error)}`)
    }
  }), 'vesta-tool-restrict: agent masks')
}
