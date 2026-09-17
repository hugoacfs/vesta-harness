/**
 * Vesta tool restriction, a preset row (roadmap T12 v2): agents composed from
 * the preset see only the host-global tools named in `allow` (MCP servers,
 * reminders, and every other host-registered tool are hidden unless listed);
 * the preset's own tool rows stay visible. With PTC presentation this keeps the
 * generated SDK small. Uses upstream's `tools.restrict` mask in the preset's
 * scope; an unknown name in `allow` fails the mount, so list only tools that
 * exist before the preset mounts (an empty list hides every host-global tool).
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'vesta-tool-restrict'

/** Required service: the tool registry of this preset realm. */
export const inject = ['tools']

export interface Config {
  /** Host-global tool names that stay visible; everything else host-global is hidden. @default [] */
  allow: string[]
}

export const Config: z<Config> = z.object({
  allow: z.array(z.string()).default([]),
})

/**
 * Register the mask in the preset's scope.
 * @param ctx - preset realm context.
 * @param config - the allow list.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.tools.restrict({ allow: config.allow }), 'vesta-tool-restrict: mask')
  ctx.logger.info(`vesta-tool-restrict: host-global tools limited to ${config.allow.length === 0 ? 'none' : config.allow.join(', ')}`)
}
