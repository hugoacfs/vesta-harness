/**
 * Vesta tool restriction, a preset row (roadmap T12 v2): agents composed from
 * the preset see only the tools named in `allow` — the mask applies to every
 * tool the agent inherits, the preset's own rows included, so list the preset's
 * tools by name; tools registered per agent (upstream's reminders) stay visible
 * regardless. With PTC presentation this keeps the generated SDK small.
 * Uses upstream's `tools.restrict` in the preset's scope. The mask can only
 * name tools that exist at the time it is applied, and sibling rows register
 * theirs while this row loads, so an unknown name is retried for a few seconds
 * before the mask is dropped with a warning.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'vesta-tool-restrict'

/** Required service: the tool registry of this preset realm. */
export const inject = ['tools']

export interface Config {
  /** Tool names that stay visible; every other inherited tool is hidden. @default [] */
  allow: string[]
  /** Attempts while sibling rows are still registering their tools. @default 40 */
  retries: number
  /** Milliseconds between attempts. @default 250 */
  retryMs: number
}

export const Config: z<Config> = z.object({
  allow: z.array(z.string()).default([]),
  retries: z.number().default(40),
  retryMs: z.number().default(250),
})

/**
 * Register the mask in the preset's scope, waiting for sibling rows' tools.
 * @param ctx - preset realm context.
 * @param config - the allow list and the retry budget.
 */
export function apply(ctx: Context, config: Config): void {
  const attempt = (tries: number): void => {
    try {
      ctx.effect(() => ctx.tools.restrict({ allow: config.allow }), 'vesta-tool-restrict: mask')
      ctx.logger.info(`vesta-tool-restrict: visible tools limited to ${config.allow.length === 0 ? 'none' : config.allow.join(', ')}`)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('unknown global tool') && tries < config.retries) {
        setTimeout(() => { attempt(tries + 1) }, config.retryMs)
        return
      }
      ctx.logger.warn(`vesta-tool-restrict: mask not applied: ${message}`)
    }
  }
  attempt(0)
}
