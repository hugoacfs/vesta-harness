/**
 * Vesta modes, host plugin. A mode is an agent preset plus the two settings the
 * harness applies when a session starts with it: the permission tier and the
 * reasoning level, keyed on the creation preset (`session.header.agentPreset`)
 * and applied once, to a session that has not produced a turn yet.
 *
 * `/mode <name>` switches a running session softly (roadmap M3): the tier and
 * the reasoning change at once, and the target mode's persona text is rendered
 * as a prompt section right after the original persona, telling the model the
 * new guidance replaces the old one; the tool set cannot change once a session
 * has produced anything (upstream rule). Overrides persist per session in
 * `$DSH_HOME/mode-overrides.json` so a resume keeps them.
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { scopeChainOf } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import yaml from 'js-yaml'
import z from '@deepseek-ai/schemastery'

export const name = 'vesta-modes'

/** Required services: Session store, Session controller, permission presets, the system prompt and the command registry. */
export const inject = ['sessions', 'sessionController', 'permissionPresets', 'systemPrompt', 'commands']

/** What one mode applies at session start; either field may be left out. */
export interface ModeSettings {
  /** Permission preset name, e.g. `danger-full-access`, `workspace-write`, `read-only`. */
  permission?: string
  /** Reasoning level name the routed model declares, e.g. `xhigh` or `off`. */
  reasoning?: string
  /** Human name shown by `/mode`; defaults to the preset id. */
  label?: string
  /** Whether `/mode` may switch a running session to this mode. @default true */
  switchable?: boolean
}

/** Preset id → settings. Presets absent from the map are left alone. */
export interface Config {
  modes: Record<string, ModeSettings>
  /** Where `/mode` overrides are kept; empty = `$DSH_HOME/mode-overrides.json`. @default '' */
  overridesFile: string
}

export const Config: z<Config> = z.object({
  modes: z.dict(z.object({
    permission: z.string(),
    reasoning: z.string(),
    label: z.string(),
    switchable: z.boolean().default(true),
  })).default({}),
  overridesFile: z.string().default(''),
})

const RETRY_DELAY_MS = 400
const RETRIES = 4
/** Right after the deployment persona prefix (order 0). */
const OVERRIDE_SECTION_ORDER = 1
const PERSONA_ROW = 'persona'

function hasTurn(session: Session): boolean {
  // oxlint-disable-next-line typescript/no-deprecated -- freshness check at creation; a projection later
  return session.snapshotEvents().some(event => event.type === 'turn/start')
}

/** The session id behind a prompt-assembly scope (an Agent or a Session in the chain). */
function sessionIdOfScope(scope: object | undefined): string | undefined {
  for (const key of scopeChainOf(scope)) {
    const candidate = key as { id?: unknown; session?: { id?: unknown } }
    if (typeof candidate.session?.id === 'string') return candidate.session.id
    if (typeof candidate.id === 'string' && candidate.id.startsWith('session-')) return candidate.id
  }
  return undefined
}

/** A YAML schema that keeps `!!js` expressions as plain strings. */
const PRESET_SCHEMA = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value: unknown) => value })])

/**
 * The persona prefix of a preset, read from its composition file.
 * @param preset - preset id under `$DSH_HOME/.agent-presets`.
 * @returns the prefix template, or undefined when the file has none.
 */
async function personaOf(preset: string): Promise<string | undefined> {
  const file = dshHomePath('.agent-presets', preset, 'agent.cordis.yml')
  const rows = yaml.load(await readFile(file, 'utf8'), { schema: PRESET_SCHEMA })
  if (!Array.isArray(rows)) return undefined
  for (const row of rows) {
    const record = row as { id?: unknown; config?: { prefix?: unknown } }
    if (record.id === PERSONA_ROW && typeof record.config?.prefix === 'string') return record.config.prefix.trim()
  }
  return undefined
}

/**
 * Apply each mode's tier and reasoning at session start; offer `/mode` for a soft switch.
 * @param ctx - host plugin context.
 * @param config - preset id → settings.
 */
export function apply(ctx: Context, config: Config): void {
  const overridesFile = config.overridesFile === '' ? dshHomePath('mode-overrides.json') : config.overridesFile
  const overrides = new Map<string, string>()
  const personas = new Map<string, { mtimeMs: number; text: string | undefined }>()

  const loadOverrides = async (): Promise<void> => {
    try {
      const parsed = JSON.parse(await readFile(overridesFile, 'utf8')) as Record<string, unknown>
      for (const [sessionId, mode] of Object.entries(parsed)) if (typeof mode === 'string') overrides.set(sessionId, mode)
    } catch {
      // no file yet
    }
  }
  const saveOverrides = async (): Promise<void> => {
    await writeFile(overridesFile, JSON.stringify(Object.fromEntries(overrides), null, 2))
  }
  const cachedPersona = async (preset: string): Promise<string | undefined> => {
    const file = dshHomePath('.agent-presets', preset, 'agent.cordis.yml')
    let mtimeMs = -1
    try {
      mtimeMs = (await stat(file)).mtimeMs
    } catch {
      return undefined
    }
    const cached = personas.get(preset)
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.text
    const text = await personaOf(preset).catch(() => undefined)
    personas.set(preset, { mtimeMs, text })
    return text
  }
  const rendered = new Map<string, string>()
  const prepareSection = async (sessionId: string, preset: string): Promise<void> => {
    const label = config.modes[preset]?.label ?? preset
    const persona = await cachedPersona(preset)
    rendered.set(sessionId, persona === undefined
      ? `The user switched this session to ${label} mode with /mode; follow that mode's way of working from here on. The tool set is unchanged.`
      : `The user switched this session to ${label} mode with /mode. The guidance below replaces the mode guidance above; the tool set is unchanged.\n\n${persona}`)
  }

  const applySettings = async (session: Session, preset: string): Promise<void> => {
    const mode = config.modes[preset]
    if (mode === undefined) return
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
  }

  const applyAtStart = async (session: Session, attempt: number): Promise<void> => {
    const preset = session.header.agentPreset
    if (preset === undefined || config.modes[preset] === undefined) return
    if (session.header.parentSession !== undefined) return
    if (ctx.sessions.get(session.id) !== session) return
    if (hasTurn(session)) return
    try {
      await applySettings(session, preset)
      const mode = config.modes[preset]
      ctx.logger.info(`vesta-modes: ${session.id} started as ${preset} (${mode.permission ?? 'permission unchanged'}, reasoning ${mode.reasoning ?? 'unchanged'})`)
    } catch (error: unknown) {
      if (attempt < RETRIES) {
        setTimeout(() => { void applyAtStart(session, attempt + 1) }, RETRY_DELAY_MS)
        return
      }
      ctx.logger.warn(`vesta-modes: could not apply ${preset} to ${session.id}: ${String(error)}`)
    }
  }
  ctx.effect(() => ctx.on('session/created', (session) => {
    setTimeout(() => { void applyAtStart(session, 0) }, 0)
    const override = overrides.get(session.id)
    if (override !== undefined) void prepareSection(session.id, override)
  }), 'vesta-modes: apply at session start')

  // The override persona, rendered only for switched sessions, right after the persona prefix.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'vesta:mode-override',
    order: OVERRIDE_SECTION_ORDER,
    text: (context) => {
      const sessionId = sessionIdOfScope(context.scope)
      return sessionId === undefined ? '' : rendered.get(sessionId) ?? ''
    },
  }), 'vesta-modes: override section')

  const resolveMode = (input: string): string | undefined => {
    const wanted = input.trim().toLowerCase()
    if (wanted === '') return undefined
    for (const preset of Object.keys(config.modes)) {
      const label = (config.modes[preset]?.label ?? preset).toLowerCase()
      if (wanted === preset || wanted === label || `vesta-${wanted}` === preset) return preset
    }
    return undefined
  }

  const switchMode = async (invocation: CommandInvocation): Promise<CommandResult> => {
    const session = invocation.agent.session
    const choices = Object.entries(config.modes)
      .filter(([, mode]) => mode.switchable !== false)
      .map(([preset, mode]) => mode.label ?? preset)
      .join(', ')
    const preset = resolveMode(invocation.rawInput)
    if (preset === undefined) {
      const current = overrides.get(session.id) ?? session.header.agentPreset ?? 'unknown'
      return { kind: 'error', text: `Usage: /mode <${choices}>. This session runs as ${config.modes[current]?.label ?? current}.` }
    }
    const mode = config.modes[preset]
    if (mode === undefined) return { kind: 'error', text: `Usage: /mode <${choices}>.` }
    if (mode.switchable === false) {
      return { kind: 'error', text: `${mode.label ?? preset} cannot be switched to mid-session; start a new session in that mode.` }
    }
    await applySettings(session, preset)
    if (preset === session.header.agentPreset) {
      overrides.delete(session.id)
      rendered.delete(session.id)
    } else {
      overrides.set(session.id, preset)
      await prepareSection(session.id, preset)
    }
    await saveOverrides()
    ctx.logger.info(`vesta-modes: ${session.id} switched to ${preset} by /mode`)
    return {
      kind: 'success',
      text: `Switched to ${mode.label ?? preset}: ${mode.permission ?? 'tier unchanged'}, reasoning ${mode.reasoning ?? 'unchanged'}. The persona guidance changes from the next reply; the tools stay those of ${session.header.agentPreset ?? 'the original mode'}.`,
    }
  }

  ctx.effect(() => ctx.commands.register({
    name: 'mode',
    description: 'Switch this session to another mode (guidance, permission tier and reasoning); the tools stay',
    input: { hint: 'ops | build | research | companion' },
    handler: invocation => switchMode(invocation),
  }), 'vesta-modes: /mode command')

  ctx.effect(() => {
    void loadOverrides().then(async () => {
      for (const [sessionId, preset] of overrides) {
        if (ctx.sessions.get(sessionId as SessionId) !== undefined) await prepareSection(sessionId, preset)
      }
    })
    return () => { overrides.clear() }
  }, 'vesta-modes: overrides')
}
