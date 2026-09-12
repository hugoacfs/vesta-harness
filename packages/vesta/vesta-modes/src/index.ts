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
 *
 * Auto (roadmap M5): a session created on the `auto.preset` never runs a turn as
 * itself. The `vestaPromptRouter` service (called by the session controller's
 * fork hook before a prompt is admitted) classifies the first message with one
 * short model call, swaps the blank session to the chosen mode through
 * upstream's own blank-session preset switch (`agentPresets.select`) and applies
 * that mode's tier and reasoning; a `/mode` typed before the first message wins
 * over the classifier, and a failed classification lands on `auto.fallback`.
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { scopeChainOf } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import yaml from 'js-yaml'
import z from '@deepseek-ai/schemastery'

export const name = 'vesta-modes'

/** Required services: Session store, Session controller, permission presets, the system prompt and the command registry. */
export const inject = ['sessions', 'sessionController', 'permissionPresets', 'systemPrompt', 'commands', 'agentPresets', 'llm']

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
/** Auto mode (roadmap M5): the placeholder preset and how its first message is routed. */
export interface AutoConfig {
  /** Route first messages of sessions on `preset`. @default true */
  enabled: boolean
  /** The placeholder preset New Session offers as Auto. @default 'vesta-auto' */
  preset: string
  /** The mode chosen when the classifier fails or answers nonsense. @default 'vesta-ops' */
  fallback: string
  /** The presets the classifier may choose (each must be in `modes`). */
  choices: string[]
  /** One line per choice, keyed by preset id, telling the classifier what the mode is for. */
  descriptions: Record<string, string>
  /** Classifier deadline. @default 8000 */
  timeoutMs: number
  /** Longest prefix of the first message shown to the classifier. @default 2000 */
  maxChars: number
}

export interface Config {
  modes: Record<string, ModeSettings>
  /** Where `/mode` overrides are kept; empty = `$DSH_HOME/mode-overrides.json`. @default '' */
  overridesFile: string
  auto: AutoConfig
}

const DEFAULT_CHOICES = ['vesta-ops', 'vesta-build', 'vesta-research', 'vesta-companion']
const DEFAULT_DESCRIPTIONS: Record<string, string> = {
  'vesta-ops': 'this machine or the user\'s other boxes and services: docker, systemd, disks, network, backups, logs, status checks, running commands, fixing what is broken, files on the server',
  'vesta-build': 'writing or changing code in a repository: features, bugs, tests, refactors, git, reviewing or explaining a codebase',
  'vesta-research': 'finding out and explaining: questions to look up, reading or comparing sources, PDFs, summaries, advice on a topic — nothing on the machine changes',
  'vesta-companion': 'conversation and everyday help: chat, feelings, plans, reminders, brainstorming, anything that is not about this machine or code',
}

const DEFAULT_AUTO: AutoConfig = {
  enabled: true, preset: 'vesta-auto', fallback: 'vesta-ops', choices: DEFAULT_CHOICES, descriptions: DEFAULT_DESCRIPTIONS, timeoutMs: 8000, maxChars: 2000,
}

export const Config: z<Config> = z.object({
  modes: z.dict(z.object({
    permission: z.string(),
    reasoning: z.string(),
    label: z.string(),
    switchable: z.boolean().default(true),
  })).default({}),
  overridesFile: z.string().default(''),
  auto: z.object({
    enabled: z.boolean().default(true),
    preset: z.string().default('vesta-auto'),
    fallback: z.string().default('vesta-ops'),
    choices: z.array(z.string()).default(DEFAULT_CHOICES),
    descriptions: z.dict(z.string()).default(DEFAULT_DESCRIPTIONS),
    timeoutMs: z.number().default(8000),
    maxChars: z.number().default(2000),
  }).default(DEFAULT_AUTO),
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

  // Auto (roadmap M5): route the first message of a blank Auto session to a mode.
  const auto: AutoConfig = { ...DEFAULT_AUTO, ...config.auto }
  const labelOf = (preset: string): string => (config.modes[preset]?.label ?? preset).toLowerCase()
  const routerSystem = (cwd: string | undefined): string => {
    const lines = auto.choices.map(preset => `${labelOf(preset)} — ${auto.descriptions[preset] ?? preset}`)
    return [
      'You route the first message of a new conversation with Vesta, a personal AI operator on the user\'s home server, to one mode.',
      `Answer with exactly one word, the mode name: ${auto.choices.map(labelOf).join(', ')}. Nothing else.`,
      ...lines,
      cwd === undefined ? '' : `The conversation's working directory is ${cwd} (a code repository suggests ${labelOf(auto.choices[1] ?? 'build')}; a home directory suggests ${labelOf(auto.choices[0] ?? 'ops')}).`,
    ].filter(line => line !== '').join('\n')
  }
  const parseChoice = (answer: string): string | undefined => {
    const word = answer.toLowerCase().replace(/[^a-z-]+/gu, ' ').trim().split(/\s+/u)[0] ?? ''
    if (word === '') return undefined
    for (const preset of auto.choices) {
      if (word === labelOf(preset) || word === preset || `vesta-${word}` === preset) return preset
    }
    return undefined
  }
  const classify = async (text: string, cwd: string | undefined): Promise<{ preset: string | undefined; answer: string }> => {
    const route = ctx.get('agentDefaultModel')?.currentSelection()
    if (route === undefined) throw new Error('no default model selection yet')
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      reasoningEffort: ReasoningEffortId('off'),
      system: routerSystem(cwd),
      messages: [createUserMessage({
        content: [{ type: 'text', text: text.slice(0, auto.maxChars) }],
        source: { kind: 'plugin', plugin: 'vesta-modes' },
      })],
      temperature: 0,
      maxTokens: 8,
      signal: AbortSignal.timeout(auto.timeoutMs),
    }
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    const answer = assembler.blocks()
      .map(block => (block.type === 'text' ? block.text : ''))
      .join(' ')
      .trim()
    return { preset: parseChoice(answer), answer }
  }
  const beforePrompt = async (agent: Agent, request: SessionPromptRequest): Promise<Agent> => {
    if (!auto.enabled) return agent
    const session = agent.session
    const composed = ctx.agentPresets.composedPreset(agent.ctx) ?? session.header.agentPreset
    if (composed !== auto.preset || hasTurn(session)) return agent
    const started = Date.now()
    const text = request.content.map(part => (part.type === 'text' ? part.text : '')).join('\n').trim()
    const override = overrides.get(session.id)
    let chosen = override
    let answer = override === undefined ? '' : `/mode ${override}`
    if (chosen === undefined) {
      try {
        const verdict = await classify(text, session.header.cwd)
        chosen = verdict.preset
        answer = verdict.answer
      } catch (error: unknown) {
        ctx.logger.warn(`vesta-modes: auto classifier failed for ${session.id}: ${String(error)}`)
      }
    }
    const preset = chosen !== undefined && config.modes[chosen] !== undefined ? chosen : auto.fallback
    try {
      await ctx.agentPresets.select(agent, preset)
    } catch (error: unknown) {
      ctx.logger.warn(`vesta-modes: auto could not switch ${session.id} to ${preset}: ${String(error)}`)
      return agent
    }
    if (override !== undefined) {
      // The composition now is the override; the soft-switch section would be wrong.
      overrides.delete(session.id)
      rendered.delete(session.id)
      await saveOverrides()
    }
    try {
      await applySettings(session, preset)
    } catch (error: unknown) {
      ctx.logger.warn(`vesta-modes: auto applied ${preset} to ${session.id} but not its settings: ${String(error)}`)
    }
    const ms = Date.now() - started
    ctx.logger.info(`vesta-modes: auto routed ${session.id} → ${preset} in ${String(ms)} ms (answer "${answer.slice(0, 40)}")`)
    return ctx.get('agents')?.get(session.id) ?? agent
  }
  ctx.provide('vestaPromptRouter', { beforePrompt })

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
