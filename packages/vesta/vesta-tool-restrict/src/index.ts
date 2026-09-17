/**
 * Vesta tool surfaces, host plugin (roadmap T12 v2 and the engine-fit phase E2).
 *
 * Two jobs, both applied per agent at `agent/created` from the agent's own scope
 * (upstream's `tools.restrict` mask filters what a scope inherits, never its own
 * registrations, and is validated from the registering scope — so a preset row
 * cannot do this, while the host can for the agents below the preset):
 *
 * 1. Static allow lists (`presets`): agents of a listed preset see only the named
 *    tools — the Batch mode's lean surface for its generated SDK.
 * 2. Tool groups on demand (`groups` + `onDemand`): for the listed presets, the
 *    heavy, rarely used groups (Home Assistant, PDF, vision) are dormant — their
 *    tools are masked at creation, so every request stays small — and come back
 *    when the task needs them: a keyword in the user's message (through the
 *    modes plugin's prompt router), the `tools_enable` tool the model can call,
 *    or `/tools <group>`. A prompt section lists the dormant groups so the model
 *    knows what it can ask for. Nothing is removed from the deployment; it is
 *    deferred, and enabling costs one prompt-cache miss for that session.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'vesta-tool-restrict'

/** Required services: the agent registry, the preset roster, the tool registry, the system prompt and the command registry. */
export const inject = ['agents', 'agentPresets', 'tools', 'systemPrompt', 'commands']

/** One preset's static visible tool list. */
export interface PresetRule {
  /** Tool names that stay visible; every other inherited tool is hidden. */
  allow: string[]
}

/** One dormant tool group. */
export interface GroupConfig {
  /** One line telling the model what the group is for. */
  label: string
  /** Tool names or `prefix*` patterns. */
  tools: string[]
  /** Words or phrases in a user message that enable the group before the turn. */
  keywords: string[]
}

export interface Config {
  /** Preset id → static allow list. Presets absent from the map are left alone. */
  presets: Record<string, PresetRule>
  /** Group name → definition. */
  groups: Record<string, GroupConfig>
  /** Preset id → groups enabled at start; every other group is dormant for that preset. Presets absent are not managed. */
  onDemand: Record<string, string[]>
  /** Name of the tool the model calls to enable a group. @default 'tools_enable' */
  enableTool: string
}

export const Config: z<Config> = z.object({
  presets: z.dict(z.object({ allow: z.array(z.string()).default([]) })).default({}),
  groups: z.dict(z.object({
    label: z.string().default(''),
    tools: z.array(z.string()).default([]),
    keywords: z.array(z.string()).default([]),
  })).default({}),
  onDemand: z.dict(z.array(z.string())).default({}),
  enableTool: z.string().default('tools_enable'),
})

/** What the modes plugin's prompt router and the page consume. */
export interface VestaToolGroupsService {
  /** Enable every dormant group whose keywords appear in the text; returns the groups enabled. */
  autoEnable(agentId: string, text: string): string[]
  /** Enable one group for one agent; returns the number of tools released, or undefined when unknown or not dormant. */
  enable(agentId: string, group: string): number | undefined
  /** Put one group back to sleep; returns whether anything changed. */
  disable(agentId: string, group: string): boolean
  /** The groups' state for one agent. */
  state(agentId: string): { enabled: string[]; dormant: string[] } | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Vesta tool groups on demand. */
    vestaToolGroups: VestaToolGroupsService
  }
}

interface AgentState {
  readonly agent: Agent
  /** Group → the disposer of its deny mask while dormant. */
  readonly masks: Map<string, () => void>
  /** Group → the tool names it covered at creation. */
  readonly covered: Map<string, string[]>
  readonly enabled: Set<string>
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

function sessionIdOfScope(scope: object | undefined): string | undefined {
  for (const key of scopeChainOf(scope)) {
    const candidate = key as { id?: unknown; session?: { id?: unknown } }
    if (typeof candidate.session?.id === 'string') return candidate.session.id
    if (typeof candidate.id === 'string' && candidate.id.startsWith('session-')) return candidate.id
  }
  return undefined
}

function matches(pattern: string, toolName: string): boolean {
  return pattern.endsWith('*') ? toolName.startsWith(pattern.slice(0, -1)) : toolName === pattern
}

function mentions(text: string, keyword: string): boolean {
  const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'u').test(text.toLowerCase())
}

/**
 * Mask each new agent per its preset; offer the groups service, tool, section and command.
 * @param ctx - host plugin context.
 * @param config - static allow lists, groups and the on-demand presets.
 */
export function apply(ctx: Context, config: Config): void {
  const agents = new Map<string, AgentState>()
  const groupNames = Object.keys(config.groups)

  const visibleNames = (agent: Agent): string[] => ctx.tools.schemas(scopeOf(agent.ctx)).map(schema => schema.name)

  const mask = (state: AgentState, group: string): void => {
    const definition = config.groups[group]
    if (definition === undefined || state.masks.has(group)) return
    const names = visibleNames(state.agent).filter(toolName => definition.tools.some(pattern => matches(pattern, toolName)))
    if (names.length === 0) return
    try {
      const dispose = state.agent.ctx.tools.restrict({ deny: names })
      state.masks.set(group, dispose)
      state.covered.set(group, names)
      state.enabled.delete(group)
    } catch (error: unknown) {
      ctx.logger.warn(`vesta-tool-restrict: ${state.agent.id}: group ${group} not masked: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const service: VestaToolGroupsService = {
    enable: (agentId, group) => {
      const state = agents.get(agentId)
      const dispose = state?.masks.get(group)
      if (state === undefined || dispose === undefined) return undefined
      dispose()
      state.masks.delete(group)
      state.enabled.add(group)
      const count = state.covered.get(group)?.length ?? 0
      ctx.logger.info(`vesta-tool-restrict: ${agentId}: group ${group} enabled (${String(count)} tools)`)
      return count
    },
    disable: (agentId, group) => {
      const state = agents.get(agentId)
      if (state === undefined || !state.enabled.has(group)) return false
      mask(state, group)
      return state.masks.has(group)
    },
    autoEnable: (agentId, text) => {
      const state = agents.get(agentId)
      if (state === undefined) return []
      const hits: string[] = []
      for (const group of state.masks.keys()) {
        const definition = config.groups[group]
        if (definition !== undefined && definition.keywords.some(keyword => mentions(text, keyword))) hits.push(group)
      }
      for (const group of hits) service.enable(agentId, group)
      return hits
    },
    state: (agentId) => {
      const state = agents.get(agentId)
      if (state === undefined) return undefined
      return { enabled: [...state.enabled].sort(), dormant: [...state.masks.keys()].sort() }
    },
  }
  ctx.provide('vestaToolGroups', service)

  ctx.effect(() => ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    const preset = ctx.agentPresets.composedPreset(agent.ctx) ?? agent.session.header.agentPreset
    if (preset === undefined) return
    const rule = config.presets[preset]
    if (rule !== undefined) {
      try {
        agent.ctx.tools.restrict({ allow: rule.allow })
        ctx.logger.info(`vesta-tool-restrict: ${agent.id} (${preset}) sees ${rule.allow.length === 0 ? 'no inherited tool' : rule.allow.join(', ')}`)
      } catch (error: unknown) {
        ctx.logger.warn(`vesta-tool-restrict: ${agent.id} (${preset}): allow list not applied: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const startEnabled = config.onDemand[preset]
    if (startEnabled === undefined) return
    const state: AgentState = { agent, masks: new Map(), covered: new Map(), enabled: new Set(startEnabled) }
    agents.set(agent.id, state)
    for (const group of groupNames) if (!startEnabled.includes(group)) mask(state, group)
    if (state.masks.size > 0) {
      ctx.logger.info(`vesta-tool-restrict: ${agent.id} (${preset}) dormant groups: ${[...state.masks.keys()].join(', ')}`)
    }
  }), 'vesta-tool-restrict: agent masks')

  ctx.effect(() => ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => { agents.delete(agent.id) }), 'vesta-tool-restrict: forget')

  // The catalog the model reads: which groups sleep, which are awake.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'vesta:tool-groups',
    order: 3,
    text: (context) => {
      const sessionId = sessionIdOfScope(context.scope)
      const state = sessionId === undefined ? undefined : agents.get(sessionId)
      if (state === undefined || (state.masks.size === 0 && state.enabled.size === 0)) return ''
      const dormant = [...state.masks.keys()].map(group => `${group} — ${config.groups[group]?.label ?? ''}`)
      const enabled = [...state.enabled]
      return [
        dormant.length === 0 ? '' : `Dormant tool groups, kept out of the request until needed: ${dormant.join('; ')}. `
          + `Enable one with ${config.enableTool} when the task needs it; its tools are available from the next step.`,
        enabled.length === 0 ? '' : `Tool groups enabled in this session: ${enabled.join(', ')}.`,
      ].filter(part => part !== '').join(' ')
    },
  }), 'vesta-tool-restrict: catalog section')

  // The tool the model calls.
  if (groupNames.length > 0) {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: config.enableTool,
      description: 'Enable a dormant tool group for the rest of this session (its tools become available from your next step). '
        + `Groups: ${groupNames.map(group => `${group} — ${config.groups[group]?.label ?? ''}`).join('; ')}.`,
      parameters: {
        group: { type: 'string', enum: groupNames, required: true, description: 'The group to enable.' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      execute: (args, exec) => {
        const agentId = exec.agent?.session.id
        if (agentId === undefined) return Promise.resolve('No session; nothing enabled.')
        const current = service.state(agentId)
        if (current === undefined) return Promise.resolve('This session does not use dormant tool groups; every tool it has is already visible.')
        if (current.enabled.includes(args.group)) return Promise.resolve(`${args.group} is already enabled.`)
        const count = service.enable(agentId, args.group)
        return Promise.resolve(count === undefined
          ? `${args.group} is not dormant in this session (nothing to enable).`
          : `Enabled ${args.group}: ${String(count)} tools are available from your next step.`)
      },
    })), 'vesta-tool-restrict: enable tool')
  }

  // /tools [group] [off]
  const toolsCommand = (invocation: CommandInvocation): CommandResult => {
    const agentId = invocation.agent.session.id
    const current = service.state(agentId)
    if (current === undefined) return { kind: 'success', text: 'This session does not use dormant tool groups.' }
    const [groupArg, offArg] = invocation.rawInput.trim().split(/\s+/u).filter(part => part !== '')
    if (groupArg === undefined) {
      return {
        kind: 'success',
        text: `Enabled: ${current.enabled.length === 0 ? 'none' : current.enabled.join(', ')}. `
          + `Dormant: ${current.dormant.length === 0 ? 'none' : current.dormant.join(', ')}. Usage: /tools <group> [off]`,
      }
    }
    if (config.groups[groupArg] === undefined) return { kind: 'error', text: `Unknown group "${groupArg}". Groups: ${groupNames.join(', ')}.` }
    if (offArg === 'off') {
      return service.disable(agentId, groupArg)
        ? { kind: 'success', text: `${groupArg} is dormant again from the next reply.` }
        : { kind: 'error', text: `${groupArg} was not enabled.` }
    }
    const count = service.enable(agentId, groupArg)
    return count === undefined
      ? { kind: 'error', text: `${groupArg} is not dormant in this session.` }
      : { kind: 'success', text: `Enabled ${groupArg}: ${String(count)} tools from the next reply.` }
  }
  ctx.effect(() => ctx.commands.register({
    name: 'tools',
    description: 'Show, enable or sleep the dormant tool groups of this session',
    input: { hint: '[group] [off]' },
    handler: invocation => toolsCommand(invocation),
  }), 'vesta-tool-restrict: /tools')
}
