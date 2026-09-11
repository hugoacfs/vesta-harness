/**
 * Vesta routines, host plugin: scheduled agent jobs. `$DSH_HOME/routines.yaml`
 * lists routines (a cron schedule or a one-off `at`, a workspace, a mode, a
 * permission tier, a prompt, a notify policy). A tick every `tickSeconds`
 * starts what is due, one run at a time: an ordinary session in the workspace,
 * titled `routine: <name> <stamp>`, on the mode's preset, at the routine's tier,
 * prompted once. The run ends at the session's `turn/end` (or at the timeout,
 * which closes the session) and is reported on Telegram through the send-only
 * notifier MCP. State (last run, outcome, pause) lives in
 * `$DSH_HOME/routines.state.json`, the history in `$DSH_HOME/routines.log.jsonl`.
 * Three cookie-authenticated routes feed the Routines panel. Roadmap R1–R3.
 */
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import yaml from 'js-yaml'
import z from '@deepseek-ai/schemastery'
import { cronMatches, cronNext, parseCron } from './cron.ts'
import type { CronSchedule } from './cron.ts'

export const name = 'vesta-routines'

/** Required services: the `/api` Connection, the Session store and controller, permission presets, the workspace registry. */
export const inject = ['connection', 'sessions', 'sessionController', 'permissionPresets', 'workspaceRegistry']

export const LIST_PATH = '/api/vesta/routines'
export const RUN_PATH = '/api/vesta/routines/run'
export const PAUSE_PATH = '/api/vesta/routines/pause'

/** Files, cadence and the notifier. */
export interface Config {
  /** The routines file; empty = `$DSH_HOME/routines.yaml`. @default '' */
  file: string
  /** Run state (last run, outcome, pause); empty = `$DSH_HOME/routines.state.json`. @default '' */
  stateFile: string
  /** Append-only run history; empty = `$DSH_HOME/routines.log.jsonl`. @default '' */
  logFile: string
  /** Seconds between checks for due routines. @default 30 */
  tickSeconds: number
  /** Timeout for a routine that names none, in minutes. @default 30 */
  defaultTimeoutMinutes: number
  /** Streamable-HTTP endpoint of the notifier MCP; empty disables reporting. @default 'http://127.0.0.1:7335/mcp' */
  notifyUrl: string
  /** Tool name on that server. @default 'notify' */
  notifyTool: string
  /** Appended to every report so the phone can open the harness. @default '' */
  linkBase: string
}

export const Config: z<Config> = z.object({
  file: z.string().default(''),
  stateFile: z.string().default(''),
  logFile: z.string().default(''),
  tickSeconds: z.number().default(30),
  defaultTimeoutMinutes: z.number().default(30),
  notifyUrl: z.string().default('http://127.0.0.1:7335/mcp'),
  notifyTool: z.string().default('notify'),
  linkBase: z.string().default(''),
})

/** One routine as declared in the file, validated. */
export interface Routine {
  readonly name: string
  readonly schedule?: string
  readonly at?: string
  readonly workspace: string
  readonly mode: string
  readonly permission: string
  readonly prompt: string
  readonly notify: 'always' | 'failure' | 'never'
  readonly timeoutMinutes: number
  readonly enabled: boolean
}

/** What one run recorded. */
export type Outcome = 'finished' | 'timeout' | 'failed'

interface RunState {
  lastRun?: number
  lastOutcome?: Outcome | 'started'
  lastSessionId?: string
  lastDetail?: string
  lastMinute?: string
  consumedAt?: string
  paused?: boolean
}

interface State {
  runs: Record<string, RunState>
}

interface ActiveRun {
  readonly routine: Routine
  readonly trigger: 'schedule' | 'manual'
  readonly startedAt: number
  sessionId?: SessionId
  timer?: ReturnType<typeof setTimeout>
  text: string
}

interface RoutinesConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u
const NOTIFY = new Set(['always', 'failure', 'never'])
const DETAIL_CHARS = 400

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Validate the file's routine list; bad entries become messages, not crashes.
 * @param parsed - the YAML document.
 * @param defaultTimeout - minutes for routines that name none.
 * @returns the valid routines and one message per rejected entry.
 */
export function validateRoutines(parsed: unknown, defaultTimeout: number): { routines: Routine[]; errors: string[] } {
  const routines: Routine[] = []
  const errors: string[] = []
  const list = Array.isArray(parsed) ? parsed : (parsed as { routines?: unknown } | null)?.routines
  if (!Array.isArray(list)) return { routines, errors: [parsed === null || parsed === undefined ? 'the file is empty' : 'expected a list of routines (or a `routines:` list)'] }
  const seen = new Set<string>()
  list.forEach((entry, index) => {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const label = text(record['name']) ?? `entry ${String(index + 1)}`
    const problems: string[] = []
    const routineName = text(record['name'])
    if (routineName === undefined || !NAME.test(routineName)) problems.push('name must be lowercase letters, digits and dashes')
    else if (seen.has(routineName)) problems.push('duplicate name')
    const schedule = text(record['schedule'])
    const at = text(record['at'])
    if ((schedule === undefined) === (at === undefined)) problems.push('exactly one of schedule (cron) or at (date-time) is required')
    if (schedule !== undefined) {
      try { parseCron(schedule) } catch (error: unknown) { problems.push(error instanceof Error ? error.message : String(error)) }
    }
    if (at !== undefined && Number.isNaN(Date.parse(at))) problems.push(`at "${at}" is not a date-time`)
    const workspace = text(record['workspace'])
    if (workspace === undefined || !workspace.startsWith('/')) problems.push('workspace must be an absolute path')
    const mode = text(record['mode'])
    if (mode === undefined) problems.push('mode (preset id) is required')
    const permission = text(record['permission'])
    if (permission === undefined) problems.push('permission is required (read-only, workspace-write or danger-full-access)')
    const prompt = text(record['prompt'])
    if (prompt === undefined) problems.push('prompt is required')
    const notify = text(record['notify']) ?? 'always'
    if (!NOTIFY.has(notify)) problems.push('notify must be always, failure or never')
    const timeoutRaw = record['timeoutMinutes']
    const timeoutMinutes = timeoutRaw === undefined ? defaultTimeout : Number(timeoutRaw)
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) problems.push('timeoutMinutes must be a positive number')
    const enabled = record['enabled'] === undefined ? true : record['enabled'] === true
    if (problems.length > 0) {
      errors.push(`${label}: ${problems.join('; ')}`)
      return
    }
    seen.add(routineName as string)
    routines.push({
      name: routineName as string,
      ...(schedule === undefined ? {} : { schedule }),
      ...(at === undefined ? {} : { at }),
      workspace: workspace as string,
      mode: mode as string,
      permission: permission as string,
      prompt: prompt as string,
      notify: notify as Routine['notify'],
      timeoutMinutes,
      enabled,
    })
  })
  return { routines, errors }
}

function localMinute(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function deliver(config: Config, title: string, message: string): Promise<void> {
  if (config.notifyUrl === '') return
  const response = await fetch(config.notifyUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: config.notifyTool, arguments: { title, message } } }),
  })
  if (!response.ok) throw new Error(`notifier answered ${String(response.status)}`)
}

/**
 * Run due routines, expose the panel routes.
 * @param ctx - host plugin context.
 * @param config - files, cadence, notifier.
 */
export function apply(ctx: Context, config: Config): void {
  const connection = Reflect.get(ctx, 'connection') as RoutinesConnection
  const file = config.file === '' ? dshHomePath('routines.yaml') : config.file
  const stateFile = config.stateFile === '' ? dshHomePath('routines.state.json') : config.stateFile
  const logFile = config.logFile === '' ? dshHomePath('routines.log.jsonl') : config.logFile

  let cached: { mtimeMs: number; routines: Routine[]; errors: string[]; schedules: Map<string, CronSchedule> } | undefined
  let state: State = { runs: {} }
  let stateLoaded = false
  let active: ActiveRun | undefined

  const loadState = async (): Promise<void> => {
    if (stateLoaded) return
    stateLoaded = true
    try {
      const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as Partial<State> | null
      if (parsed !== null && typeof parsed.runs === 'object') state = { runs: parsed.runs }
    } catch {
      state = { runs: {} }
    }
  }
  const saveState = async (): Promise<void> => {
    await mkdir(dirname(stateFile), { recursive: true })
    await writeFile(stateFile, JSON.stringify(state, null, 2))
  }
  const log = async (record: Record<string, unknown>): Promise<void> => {
    await mkdir(dirname(logFile), { recursive: true })
    await appendFile(logFile, `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`)
  }

  const loadRoutines = async (): Promise<{ routines: Routine[]; errors: string[]; schedules: Map<string, CronSchedule> }> => {
    let mtimeMs = -1
    try {
      mtimeMs = (await stat(file)).mtimeMs
    } catch {
      return { routines: [], errors: [`no routines file at ${file}`], schedules: new Map() }
    }
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached
    let parsed: unknown
    try {
      parsed = yaml.load(await readFile(file, 'utf8'))
    } catch (error: unknown) {
      const errors = [`${file}: ${error instanceof Error ? error.message : String(error)}`]
      cached = { mtimeMs, routines: [], errors, schedules: new Map() }
      return cached
    }
    const { routines, errors } = validateRoutines(parsed, config.defaultTimeoutMinutes)
    const schedules = new Map<string, CronSchedule>()
    for (const routine of routines) if (routine.schedule !== undefined) schedules.set(routine.name, parseCron(routine.schedule))
    cached = { mtimeMs, routines, errors, schedules }
    return cached
  }

  const runState = (routineName: string): RunState => {
    const existing = state.runs[routineName]
    if (existing !== undefined) return existing
    const created: RunState = {}
    state.runs[routineName] = created
    return created
  }

  const finish = async (run: ActiveRun, outcome: Outcome, detail: string): Promise<void> => {
    if (active !== run) return
    active = undefined
    if (run.timer !== undefined) clearTimeout(run.timer)
    const seconds = Math.round((Date.now() - run.startedAt) / 1000)
    const record = runState(run.routine.name)
    record.lastOutcome = outcome
    record.lastDetail = detail.slice(0, DETAIL_CHARS)
    await saveState()
    await log({
      routine: run.routine.name, trigger: run.trigger, outcome, seconds, sessionId: run.sessionId, detail: detail.slice(0, DETAIL_CHARS),
    })
    if (outcome === 'timeout' && run.sessionId !== undefined) {
      try { await ctx.sessionController.close(run.sessionId) } catch (error: unknown) { ctx.logger.warn(`vesta-routines: close after timeout failed: ${String(error)}`) }
    }
    const report = run.routine.notify === 'always' || (run.routine.notify === 'failure' && outcome !== 'finished')
    if (report) {
      const body = `${outcome} after ${String(seconds)} s.${detail === '' ? '' : `\n${detail.slice(0, DETAIL_CHARS)}`}${config.linkBase === '' ? '' : `\n${config.linkBase}`}`
      deliver(config, `Routine: ${run.routine.name}`, body).catch((error: unknown) => { ctx.logger.warn(`vesta-routines: report failed: ${String(error)}`) })
    }
    ctx.logger.info(`vesta-routines: ${run.routine.name} ${outcome} after ${String(seconds)} s (${run.sessionId ?? 'no session'})`)
  }

  const start = async (routine: Routine, trigger: ActiveRun['trigger']): Promise<void> => {
    if (active !== undefined) return
    const run: ActiveRun = { routine, trigger, startedAt: Date.now(), text: '' }
    active = run
    const record = runState(routine.name)
    const now = new Date()
    record.lastRun = now.getTime()
    record.lastOutcome = 'started'
    record.lastDetail = ''
    if (routine.schedule !== undefined) record.lastMinute = localMinute(now)
    if (routine.at !== undefined) record.consumedAt = routine.at
    await saveState()
    try {
      await ctx.workspaceRegistry.create(routine.workspace)
      const { sessionId } = await ctx.sessionController.create({
        cwd: routine.workspace,
        agentPreset: routine.mode,
      })
      run.sessionId = sessionId
      record.lastSessionId = sessionId
      const session = ctx.sessions.get(sessionId)
      if (session !== undefined) ctx.permissionPresets.set(session, routine.permission)
      await ctx.sessionController.rename({ sessionId, title: `routine: ${routine.name} ${localMinute(now)}` })
      await ctx.sessionController.prompt({
        requestId: brandString<SessionRequestId>(`routine-${routine.name}-${String(now.getTime())}`),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: routine.prompt }],
      }, AbortSignal.timeout(60000))
      await saveState()
      await log({ routine: routine.name, trigger, outcome: 'started', sessionId })
      run.timer = setTimeout(() => { void finish(run, 'timeout', `no end of turn within ${String(routine.timeoutMinutes)} min`) }, routine.timeoutMinutes * 60 * 1000)
    } catch (error: unknown) {
      await finish(run, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const run = active
    if (run === undefined || run.sessionId !== session.id) return
    const record = event as { readonly type: string; readonly data?: unknown }
    if (record.type === 'assistant/message') {
      const data = record.data as { message?: { content?: unknown } } | undefined
      const content = data?.message?.content
      if (Array.isArray(content)) {
        for (const part of content) {
          const piece = part as { type?: string; text?: string }
          if (piece.type === 'text' && typeof piece.text === 'string') run.text = piece.text.trim()
        }
      }
    }
    if (record.type === 'turn/end') void finish(run, 'finished', run.text)
  }), 'vesta-routines: run observer')

  const tick = async (): Promise<void> => {
    await loadState()
    const { routines, schedules } = await loadRoutines()
    const now = new Date()
    for (const routine of routines) {
      if (active !== undefined) return
      const record = runState(routine.name)
      if (!routine.enabled || record.paused === true) continue
      let due = false
      if (routine.schedule !== undefined) {
        const schedule = schedules.get(routine.name)
        due = schedule !== undefined && cronMatches(schedule, now) && record.lastMinute !== localMinute(now)
      } else if (routine.at !== undefined) {
        due = Date.parse(routine.at) <= now.getTime() && record.consumedAt !== routine.at
      }
      if (due) await start(routine, 'schedule')
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => { tick().catch((error: unknown) => { ctx.logger.warn(`vesta-routines: tick failed: ${String(error)}`) }) }, config.tickSeconds * 1000)
    return () => { clearInterval(timer) }
  }, 'vesta-routines: ticker')

  const listResponse = async (): Promise<Response> => {
    await loadState()
    const { routines, errors, schedules } = await loadRoutines()
    const now = new Date()
    const items = routines.map((routine) => {
      const record = state.runs[routine.name] ?? {}
      const schedule = schedules.get(routine.name)
      const next = routine.at !== undefined
        ? (record.consumedAt === routine.at ? undefined : Date.parse(routine.at))
        : schedule === undefined ? undefined : cronNext(schedule, now)?.getTime()
      return {
        ...routine,
        paused: record.paused === true,
        nextRun: routine.enabled && record.paused !== true ? next : undefined,
        lastRun: record.lastRun,
        lastOutcome: record.lastOutcome,
        lastSessionId: record.lastSessionId,
        lastDetail: record.lastDetail,
        running: active?.routine.name === routine.name,
      }
    })
    return Response.json({ file, items, errors, active: active?.routine.name })
  }

  const readName = async (request: Request): Promise<{ name: string; paused?: boolean } | Response> => {
    let body: { name?: unknown; paused?: unknown }
    try {
      body = (await request.json()) as { name?: unknown; paused?: unknown }
    } catch {
      return new Response('body must be JSON', { status: 400 })
    }
    const routineName = typeof body.name === 'string' ? body.name : ''
    if (!NAME.test(routineName)) return new Response('expected { name }', { status: 400 })
    return { name: routineName, ...(typeof body.paused === 'boolean' ? { paused: body.paused } : {}) }
  }

  const runResponse = async (request: Request): Promise<Response> => {
    const parsed = await readName(request)
    if (parsed instanceof Response) return parsed
    const { routines } = await loadRoutines()
    const routine = routines.find(candidate => candidate.name === parsed.name)
    if (routine === undefined) return new Response('no such routine', { status: 404 })
    if (active !== undefined) return new Response(`busy: ${active.routine.name} is running`, { status: 409 })
    await loadState()
    void start(routine, 'manual')
    return Response.json({ ok: true })
  }

  const pauseResponse = async (request: Request): Promise<Response> => {
    const parsed = await readName(request)
    if (parsed instanceof Response) return parsed
    if (parsed.paused === undefined) return new Response('expected { name, paused }', { status: 400 })
    await loadState()
    runState(parsed.name).paused = parsed.paused
    await saveState()
    return Response.json({ ok: true, paused: parsed.paused })
  }

  ctx.effect(() => {
    const disposers = [
      connection.fetch.register({ path: LIST_PATH, methods: ['GET'], requestBody: 'buffered', fetch: () => listResponse() }),
      connection.fetch.register({ path: RUN_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => runResponse(request) }),
      connection.fetch.register({ path: PAUSE_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => pauseResponse(request) }),
    ]
    return () => {
      for (const dispose of disposers) void dispose()
    }
  }, 'vesta-routines: routes')
}
