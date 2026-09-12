/**
 * Vesta routines, host plugin (v2, roadmap R8–R11): a routine is a standing
 * agent with one hidden thread session. Each routine is a folder under
 * `$DSH_HOME/routines/<name>/` (`routine.yaml`, `notes.md`, `runs.jsonl`,
 * `thread.json`, `archive/`). Its thread is created on the `vesta-routine`
 * preset in the routine's workspace, at the routine's permission tier, titled
 * after the routine and archived at creation so the sidebar never lists it.
 * The brief is a pinned prompt section (`vesta:routine-brief`), so compaction
 * cannot lose it. A run is one queued message into the thread carrying the
 * run number, the trigger, the local time, any new information and the
 * agent's notes; every turn in the thread (scheduled, one-off, manual, a
 * reminder the routine set itself, a chat by the user) is logged as a run.
 * After an unattended run the plugin records the outcome and the `Summary:`
 * line, sends the `NOTIFY:` line per policy, compacts the thread once the
 * run's last request grew past `compactAboveTokens`, and rotates the thread
 * into `archive/` after `rotateAfterRuns` runs. Due routines queue one at a
 * time. Cookie-authenticated routes feed the Routines page.
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-commands'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { scopeChainOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { cronMatches, cronNext, describeCron, parseCron } from './cron.ts'
import type { CronSchedule } from './cron.ts'
import {
  ARCHIVE_DIR, NAME, appendRun, importLegacy, readFolders, readNotes, readRuns, readThread, validateRoutine, writeNotes, writeRoutine,
  writeThread,
} from './store.ts'
import type { RoutineFolder } from './store.ts'
import type { Outcome, Routine, RunRecord, Thread, Trigger, VestaRoutinesService } from './types.ts'

export type { Notify, Outcome, Permission, Routine, RunRecord, Thread, Trigger, VestaRoutinesService } from './types.ts'
export { describeCron } from './cron.ts'

export const name = 'vesta-routines'

/**
 * Required services: the `/api` Connection, the Session store and controller,
 * permission presets, the workspace registry, session persistence (does a
 * thread still exist), the system prompt (the pinned brief), the agent
 * registry and commands (`/compact` after a run).
 */
export const inject = [
  'connection', 'sessions', 'sessionController', 'permissionPresets', 'workspaceRegistry', 'sessionPersistence', 'systemPrompt', 'agents', 'commands',
]

export const LIST_PATH = '/api/vesta/routines'
export const DETAIL_PATH = '/api/vesta/routines/detail'
export const SAVE_PATH = '/api/vesta/routines/save'
export const DELETE_PATH = '/api/vesta/routines/delete'
export const RUN_PATH = '/api/vesta/routines/run'
export const PAUSE_PATH = '/api/vesta/routines/pause'
export const RESET_PATH = '/api/vesta/routines/reset'
export const NOTES_PATH = '/api/vesta/routines/notes'

/** The prompt section carrying the brief into every run of a thread. */
export const BRIEF_SECTION = 'vesta:routine-brief'

/** Where routines live, how often the clock ticks, thread hygiene, the notifier. */
export interface Config {
  /** The routines directory; empty = `$DSH_HOME/routines`. @default '' */
  dir: string
  /** The v1 file imported once into folders; empty = `$DSH_HOME/routines.yaml`. @default '' */
  legacyFile: string
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
  /** The agent preset threads are composed from. @default 'vesta-routine' */
  preset: string
  /** Compact the thread after a run whose last request used more input tokens than this. @default 24000 */
  compactAboveTokens: number
  /** Rotate the thread into the archive after this many runs (a routine may override). @default 100 */
  rotateAfterRuns: number
  /** Runs in flight at once. @default 1 */
  maxConcurrent: number
  /** Size cap of `notes.md`. @default 16384 */
  notesMaxBytes: number
  /** Longest NOTIFY line sent to the phone. @default 1000 */
  notifyMaxChars: number
  /** Where a deleted routine (folder + thread) is exported first; `~/` is the home directory. @default '~/backups/routines-deleted' */
  exportDir: string
  /** Run records returned by the detail route. @default 50 */
  runsShown: number
}

export const Config: z<Config> = z.object({
  dir: z.string().default(''),
  legacyFile: z.string().default(''),
  tickSeconds: z.number().default(30),
  defaultTimeoutMinutes: z.number().default(30),
  notifyUrl: z.string().default('http://127.0.0.1:7335/mcp'),
  notifyTool: z.string().default('notify'),
  linkBase: z.string().default(''),
  preset: z.string().default('vesta-routine'),
  compactAboveTokens: z.number().default(24000),
  rotateAfterRuns: z.number().default(100),
  maxConcurrent: z.number().default(1),
  notesMaxBytes: z.number().default(16384),
  notifyMaxChars: z.number().default(1000),
  exportDir: z.string().default('~/backups/routines-deleted'),
  runsShown: z.number().default(50),
})

interface Run {
  readonly name: string
  readonly routine: Routine
  readonly trigger: Trigger
  readonly info: string
  readonly startedAt: number
  readonly runNumber: number
  /** Set for runs the plugin started; passive runs (chat, reminder) have none. */
  readonly requestId?: string
  sessionId?: SessionId
  turn?: number
  seqFrom?: number
  text: string
  inputTokens?: number
  timer?: ReturnType<typeof setTimeout>
  timedOut?: boolean
  finished?: boolean
}

/** The fields of thread events the observer reads. */
interface ThreadEventData {
  readonly turn?: number
  readonly reason?: { readonly kind?: string; readonly error?: { readonly message?: string } }
  readonly source?: { readonly kind?: string; readonly plugin?: string; readonly rpcId?: string }
  readonly usage?: { readonly inputTokens?: number }
}

interface Queued {
  readonly name: string
  readonly trigger: Trigger
  readonly info: string
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

const SUMMARY_CHARS = 300
const COMPACTION_CHARS = 6000
const run = promisify(execFile)

function localMinute(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function stampNow(): string {
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z')
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function nowText(date: Date): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const text = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short' }).format(date)
  return `${text} ${zone}`
}

function sessionIdOfScope(scope: object | undefined): string | undefined {
  for (const key of scopeChainOf(scope)) {
    const candidate = key as { id?: unknown; session?: { id?: unknown } }
    if (typeof candidate.session?.id === 'string') return candidate.session.id
    if (typeof candidate.id === 'string' && candidate.id.startsWith('session-')) return candidate.id
  }
  return undefined
}

/** The on-disk directory of a stored session: `$DSH_HOME/sessions/<workspace>/<sessionId>`. */
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

const SUMMARY_LINE = /^[*_#\s]*summary[*_]*\s*:\s*/iu
const NOTIFY_LINE = /^[*_#\s]*notify[*_]*\s*:\s*/iu

/** The `Summary:` line of a final message, else its first line. */
export function summaryOf(text: string): string {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  const tagged = [...lines].reverse().find(line => SUMMARY_LINE.test(line))
  const line = tagged === undefined ? (lines.find(candidate => !NOTIFY_LINE.test(candidate)) ?? '') : tagged.replace(SUMMARY_LINE, '')
  return line.replace(/[*_]+$/u, '').trim().slice(0, SUMMARY_CHARS)
}

/** The `NOTIFY:` line of a final message, when the agent wrote one. */
export function notifyOf(text: string): string | undefined {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  const tagged = [...lines].reverse().find(line => NOTIFY_LINE.test(line))
  if (tagged === undefined) return undefined
  const body = tagged.replace(NOTIFY_LINE, '').replace(/[*_]+$/u, '').trim()
  return body === '' ? undefined : body
}

/** The standing brief as the model sees it in every run. */
export function renderBrief(routine: Routine, tierNote: string): string {
  const when = routine.schedule === undefined
    ? routine.at === undefined ? 'only when started by hand or by an event' : `once, at ${routine.at}`
    : `on the schedule "${routine.schedule}" (${describeCron(routine.schedule)})`
  const policy = routine.notify === 'agent'
    ? 'Hugo is told only when you end a run with a final line starting "NOTIFY:" — exactly that text reaches his phone, so write it for him; failures are reported by the harness.'
    : routine.notify === 'always'
      ? 'the harness sends Hugo the outcome and your Summary line after every run; a final "NOTIFY:" line, if you write one, is sent as well.'
      : routine.notify === 'failure'
        ? 'the harness tells Hugo only about failures; a final "NOTIFY:" line, if you write one, is sent as well.'
        : 'nothing is sent to Hugo from this routine, not even a NOTIFY line; report in the thread only.'
  return [
    `# Routine: ${routine.title} (${routine.name})`,
    `You are the standing agent of this routine, which runs ${when}. Every run arrives as a message headed "Routine run"`
    + ' with the trigger, the local time, any new information and your notes. You are the same agent every time: your context holds a'
    + ' compacted memory of earlier runs, and for exact detail from earlier runs call session_event_search on this session with'
    + ' surfaces ["current", "shadowed"] (older, summarised turns stay searchable).',
    'Standing brief:',
    routine.brief,
    'Rules: work only within the brief. Keep facts the next run will need — numbers to compare, items already seen, open threads —'
    + ' with routine_note (read, append or replace); the notes are handed to you at the start of every run and are the one place'
    + ' that survives compaction verbatim, so keep them short and current. End every run with one line "Summary: …" describing what'
    + ' you found and did. Do not ask questions: there is nobody at the keyboard during a run; decide, act within the brief, and'
    + ' record open questions in your notes.',
    `Notify policy (${routine.notify}): ${policy}`,
    tierNote,
  ].join('\n\n')
}

/** The message that starts one run. */
export function renderRunMessage(
  routine: Routine, runNumber: number, trigger: Trigger, info: string, notes: string, handover: string | undefined, date: Date,
): string {
  const why = trigger === 'schedule' && routine.schedule !== undefined
    ? `schedule "${routine.schedule}" (${describeCron(routine.schedule)})`
    : trigger === 'at' ? `one-off at ${routine.at ?? ''}` : trigger
  const lines = [
    `Routine run ${String(runNumber)} of "${routine.title}" — trigger: ${why}; time: ${nowText(date)}.`,
    `New information: ${info === '' ? 'none' : info}`,
  ]
  if (handover !== undefined && handover !== '') {
    lines.push(`This thread was started fresh after a history rotation. What the previous thread knew:\n${handover}`)
  }
  const size = Buffer.byteLength(notes)
  lines.push(notes.trim() === ''
    ? 'Your notes: (empty — use routine_note to keep what the next run needs)'
    : `Your notes (${String(size)} bytes; edit with routine_note):\n${notes.trim()}`)
  lines.push('Do the brief now. First recall: what did earlier runs find and do, and does any of it bear on this run?'
    + ' End with "Summary: …" on one line and, only when the brief says Hugo must be told, a last line "NOTIFY: …".')
  return lines.join('\n\n')
}

function assistantText(data: unknown): string | undefined {
  const content = (data as { message?: { content?: unknown } } | undefined)?.message?.content
  if (!Array.isArray(content)) return undefined
  let last: string | undefined
  for (const part of content) {
    const piece = part as { type?: string; text?: string }
    if (piece.type === 'text' && typeof piece.text === 'string' && piece.text.trim() !== '') last = piece.text.trim()
  }
  return last
}

function userText(data: unknown): string {
  const content = (data as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (part as { type?: string; text?: string }))
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text ?? '')
    .join('\n')
}

/**
 * Run routines on their threads, expose the page routes and the notes service.
 * @param ctx - host plugin context.
 * @param config - directory, cadence, thread hygiene, notifier.
 */
export function apply(ctx: Context, config: Config): void {
  const connection = Reflect.get(ctx, 'connection') as RoutinesConnection
  const root = config.dir === '' ? dshHomePath('routines') : expandHome(config.dir)
  const legacyFile = config.legacyFile === '' ? dshHomePath('routines.yaml') : expandHome(config.legacyFile)

  let cache = new Map<string, RoutineFolder>()
  const threads = new Map<string, Thread>()
  const sessionToRoutine = new Map<string, string>()
  const active = new Map<string, Run>()
  const passive = new Map<string, Run>()
  /** The turn most recently opened in each thread: `turn/start` precedes the turn's `user/message`. */
  const lastTurn = new Map<string, number>()
  const queue: Queued[] = []
  const schedules = new Map<string, CronSchedule>()
  let importErrors: string[] = []
  let booted = false

  const load = async (): Promise<RoutineFolder[]> => {
    const folders = await readFolders(root, config.defaultTimeoutMinutes, cache)
    cache = new Map(folders.map(folder => [folder.name, folder]))
    schedules.clear()
    for (const folder of folders) {
      if (folder.routine?.schedule !== undefined) {
        try { schedules.set(folder.name, parseCron(folder.routine.schedule)) } catch { /* reported by validation */ }
      }
    }
    return folders
  }

  const threadOf = async (folder: RoutineFolder): Promise<Thread> => {
    const known = threads.get(folder.name)
    if (known !== undefined) return known
    const thread = await readThread(folder.dir)
    threads.set(folder.name, thread)
    if (thread.sessionId !== undefined) sessionToRoutine.set(thread.sessionId, folder.name)
    return thread
  }
  const passiveRun = (session: { id: SessionId }, folder: RoutineFolder, trigger: 'chat' | 'reminder', info: string, seq: number): void => {
    const thread = threads.get(folder.name)
    const routine = folder.routine
    if (thread === undefined || routine === undefined || passive.has(session.id)) return
    thread.runs += 1
    const turn = lastTurn.get(session.id)
    passive.set(session.id, {
      name: folder.name, routine, trigger, info, startedAt: Date.now(), runNumber: thread.runs, sessionId: session.id, seqFrom: seq, text: '',
      ...(turn === undefined ? {} : { turn }),
    })
  }
  const saveThread = async (folder: RoutineFolder): Promise<void> => {
    const thread = threads.get(folder.name)
    if (thread !== undefined) await writeThread(folder.dir, thread)
  }

  const sessionExists = async (sessionId: SessionId): Promise<boolean> => {
    if (ctx.sessions.get(sessionId) !== undefined) return true
    const stored = await ctx.sessionPersistence.list()
    return stored.some(snapshot => snapshot.header.id === sessionId)
  }

  const applySettings = async (sessionId: SessionId, routine: Routine): Promise<void> => {
    const route = ctx.get('agentDefaultModel')?.currentSelection()
    if (route !== undefined) {
      await ctx.sessionController.selectModel({
        sessionId, provider: route.provider, model: route.model, reasoningEffort: routine.reasoning ?? 'xhigh',
      })
    }
    const session = ctx.sessions.get(sessionId)
    if (session !== undefined) ctx.permissionPresets.set(session, routine.permission)
  }

  const ensureThread = async (folder: RoutineFolder, routine: Routine): Promise<SessionId> => {
    const thread = await threadOf(folder)
    if (thread.sessionId !== undefined) {
      const existing = thread.sessionId as SessionId
      if (await sessionExists(existing)) return existing
      ctx.logger.warn(`vesta-routines: thread ${existing} of ${folder.name} is gone; starting a fresh one`)
      sessionToRoutine.delete(existing)
      thread.sessionId = undefined
      thread.threadRuns = 0
    }
    await ctx.workspaceRegistry.create(routine.workspace)
    const { sessionId } = await ctx.sessionController.create({ cwd: routine.workspace, agentPreset: config.preset })
    sessionToRoutine.set(sessionId, folder.name)
    thread.sessionId = sessionId
    thread.createdAt = new Date().toISOString()
    thread.threadRuns = 0
    await saveThread(folder)
    await ctx.sessionController.rename({ sessionId, title: routine.title })
    await ctx.workspaceRegistry.archiveSession(sessionId)
    ctx.logger.info(`vesta-routines: thread ${sessionId} created for ${folder.name}`)
    return sessionId
  }

  const deliver = async (title: string, message: string): Promise<boolean> => {
    if (config.notifyUrl === '') return false
    const body = `${message}${config.linkBase === '' ? '' : `\n${config.linkBase}`}`
    try {
      const response = await fetch(config.notifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: config.notifyTool, arguments: { title, message: body } },
        }),
      })
      if (!response.ok) throw new Error(`notifier answered ${String(response.status)}`)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`vesta-routines: report failed: ${String(error)}`)
      return false
    }
  }

  const compactThread = async (folder: RoutineFolder, sessionId: SessionId): Promise<void> => {
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) {
      ctx.logger.warn(`vesta-routines: ${folder.name}: thread not live, compaction skipped`)
      return
    }
    try {
      const execution = await ctx.commands.execute(agent, '/compact', [], AbortSignal.timeout(300000))
      ctx.logger.info(`vesta-routines: ${folder.name}: /compact → ${execution?.result.text ?? 'no such command'}`)
    } catch (error: unknown) {
      ctx.logger.warn(`vesta-routines: ${folder.name}: /compact failed: ${String(error)}`)
    }
  }

  const archiveSummary = async (folder: RoutineFolder, routine: Routine | undefined, thread: Thread, reason: string): Promise<string> => {
    const notes = await readNotes(folder.dir)
    const runs = await readRuns(folder.dir, 20)
    const parts = [
      `# ${routine?.title ?? folder.name} — thread ${thread.sessionId ?? '(none)'} archived ${new Date().toISOString()} (${reason})`,
      `Runs in this thread: ${String(thread.threadRuns)}; runs over the routine's life: ${String(thread.runs)}.`,
      '## Last compaction summary',
      thread.lastCompaction ?? '(the thread was never compacted)',
      '## Notes at rotation',
      notes.trim() === '' ? '(empty)' : notes.trim(),
      '## Last runs',
      runs.length === 0 ? '(none)' : runs.map(record => `- ${record.time} run ${String(record.run)} ${record.trigger} ${record.outcome}: ${record.summary}`).join('\n'),
    ]
    return `${parts.join('\n\n')}\n`
  }

  const retire = async (sessionId: SessionId): Promise<string | undefined> => {
    try { await ctx.sessionController.close(sessionId) } catch (error: unknown) { ctx.logger.warn(`vesta-routines: close ${sessionId}: ${String(error)}`) }
    const directory = await sessionDirectory(sessionId)
    return directory
  }

  const forget = async (sessionId: SessionId, directory: string | undefined): Promise<void> => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    await ctx.workspaceRegistry.forgetSession(sessionId)
    ctx.emit('api-session/removed', sessionId)
    sessionToRoutine.delete(sessionId)
  }

  const rotate = async (folder: RoutineFolder, reason: string): Promise<void> => {
    const thread = await threadOf(folder)
    const sessionId = thread.sessionId as SessionId | undefined
    if (sessionId !== undefined) {
      const stamp = stampNow()
      const archive = join(folder.dir, ARCHIVE_DIR)
      await mkdir(archive, { recursive: true })
      const summary = await archiveSummary(folder, folder.routine, thread, reason)
      await writeFile(join(archive, `summary-${stamp}.md`), summary)
      const directory = await retire(sessionId)
      const file = join(archive, `${sessionId}-${stamp}.tar.gz`)
      if (directory !== undefined) await run('tar', ['-czf', file, '-C', join(directory, '..'), sessionId])
      await forget(sessionId, directory)
      thread.rotations.push({
        sessionId, archivedAt: new Date().toISOString(), file: directory === undefined ? '' : file, runs: thread.threadRuns, reason,
      })
      thread.handover = [
        thread.lastCompaction === undefined ? undefined : `Compacted memory of the previous thread:\n${thread.lastCompaction}`,
        thread.lastRunSummary === undefined ? undefined : `Its last run summary: ${thread.lastRunSummary}`,
      ].filter((part): part is string => part !== undefined).join('\n\n')
      ctx.logger.info(`vesta-routines: ${folder.name}: thread ${sessionId} rotated (${reason})`)
    }
    thread.sessionId = undefined
    thread.threadRuns = 0
    thread.lastCompaction = undefined
    await saveThread(folder)
  }

  const finish = async (folder: RoutineFolder, current: Run, outcome: Outcome, detail: string): Promise<void> => {
    if (current.finished === true) return
    current.finished = true
    if (current.timer !== undefined) clearTimeout(current.timer)
    const unattended = current.requestId !== undefined
    if (unattended) {
      if (active.get(current.name) !== current) return
    } else if (current.sessionId !== undefined) {
      if (passive.get(current.sessionId) !== current) return
      passive.delete(current.sessionId)
    }
    const seconds = Math.round((Date.now() - current.startedAt) / 1000)
    const summary = outcome === 'finished' ? summaryOf(current.text) : `${outcome}: ${detail.slice(0, SUMMARY_CHARS)}`
    const notifyLine = notifyOf(current.text)
    const thread = await threadOf(folder)
    const session = current.sessionId === undefined ? undefined : ctx.sessions.get(current.sessionId)
    thread.threadRuns += 1
    thread.lastRunAt = current.startedAt
    thread.lastOutcome = outcome
    thread.lastRunSummary = summary
    await saveThread(folder)
    let notified = false
    if (unattended) {
      const policy = current.routine.notify
      const failed = outcome !== 'finished'
      const title = `Routine: ${current.routine.title}`
      if (policy === 'always' || (failed && (policy === 'failure' || policy === 'agent'))) {
        const head = `${outcome} after ${String(seconds)} s (run ${String(current.runNumber)}).`
        const extra = notifyLine === undefined ? '' : `\n${notifyLine.slice(0, config.notifyMaxChars)}`
        notified = await deliver(title, `${head}\n${summary}${extra}`)
      } else if (policy === 'agent' && notifyLine !== undefined) {
        notified = await deliver(title, notifyLine.slice(0, config.notifyMaxChars))
      }
    }
    const record: RunRecord = {
      time: new Date(current.startedAt).toISOString(),
      run: current.runNumber,
      trigger: current.trigger,
      outcome,
      seconds,
      sessionId: current.sessionId ?? '',
      ...(current.turn === undefined ? {} : { turn: current.turn }),
      ...(current.seqFrom === undefined ? {} : { seqFrom: current.seqFrom }),
      ...(session === undefined ? {} : { seqTo: session.seq }),
      summary,
      notified,
      ...(current.inputTokens === undefined ? {} : { inputTokens: current.inputTokens }),
      ...(current.info === '' ? {} : { info: current.info }),
      ...(detail === '' ? {} : { detail: detail.slice(0, SUMMARY_CHARS) }),
    }
    await appendRun(folder.dir, record)
    ctx.logger.info(`vesta-routines: ${current.name} run ${String(current.runNumber)} ${outcome} after ${String(seconds)} s (${current.trigger})`)
    if (unattended && current.sessionId !== undefined) {
      if (outcome === 'timeout') {
        try { await ctx.sessionController.close(current.sessionId) } catch (error: unknown) { ctx.logger.warn(`vesta-routines: close after timeout: ${String(error)}`) }
      } else {
        const compactAbove = current.routine.compactAboveTokens ?? config.compactAboveTokens
        if ((current.inputTokens ?? 0) > compactAbove) await compactThread(folder, current.sessionId)
        const limit = current.routine.rotateAfterRuns ?? config.rotateAfterRuns
        if (thread.threadRuns >= limit) await rotate(folder, `after ${String(thread.threadRuns)} runs`)
      }
    }
    // The routine stays busy until its thread maintenance is over: no run starts on a thread being compacted or rotated.
    if (unattended) active.delete(current.name)
    pump()
  }

  const start = async (queued: Queued): Promise<void> => {
    const folder = cache.get(queued.name)
    const routine = folder?.routine
    if (folder === undefined || routine === undefined) return
    const thread = await threadOf(folder)
    const startedAt = Date.now()
    thread.runs += 1
    thread.lastOutcome = 'started'
    const current: Run = {
      name: queued.name, routine, trigger: queued.trigger, info: queued.info, startedAt, runNumber: thread.runs,
      requestId: `routine-${queued.name}-${String(startedAt)}`, text: '',
    }
    active.set(queued.name, current)
    await saveThread(folder)
    try {
      const sessionId = await ensureThread(folder, routine)
      current.sessionId = sessionId
      await applySettings(sessionId, routine)
      const notes = await readNotes(folder.dir)
      const handover = thread.handover
      thread.handover = undefined
      const message = renderRunMessage(routine, current.runNumber, queued.trigger, queued.info, notes, handover, new Date(startedAt))
      await ctx.sessionController.prompt({
        requestId: brandString<SessionRequestId>(current.requestId ?? ''),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: message }],
      }, AbortSignal.timeout(60000))
      await saveThread(folder)
      current.timer = setTimeout(() => {
        current.timedOut = true
        void finish(folder, current, 'timeout', `no end of turn within ${String(routine.timeoutMinutes)} min`)
      }, routine.timeoutMinutes * 60 * 1000)
    } catch (error: unknown) {
      await finish(folder, current, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  const pump = (): void => {
    while (active.size < config.maxConcurrent) {
      const index = queue.findIndex(item => !active.has(item.name))
      if (index === -1) break
      const [next] = queue.splice(index, 1)
      if (next === undefined) break
      void start(next).catch((error: unknown) => { ctx.logger.warn(`vesta-routines: start ${next.name} failed: ${String(error)}`) })
    }
  }

  /** Queue one run; a routine already queued is refused, one that is running gets its next run queued. */
  const enqueue = (routineName: string, trigger: Trigger, info: string, front: boolean): 'queued' | 'busy' => {
    if (queue.some(item => item.name === routineName)) return 'busy'
    const item: Queued = { name: routineName, trigger, info }
    if (front) queue.unshift(item)
    else queue.push(item)
    pump()
    return 'queued'
  }

  // The thread observer: our runs by request id, everything else as a passive run.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const routineName = sessionToRoutine.get(session.id)
    if (routineName === undefined) return
    const folder = cache.get(routineName)
    if (folder === undefined) return
    const record = event as { readonly type: string; readonly seq: number; readonly data?: unknown }
    const data = record.data as ThreadEventData | undefined
    const own = active.get(routineName)
    const ours = own !== undefined && own.sessionId === session.id ? own : undefined
    if (record.type === 'turn/start' && typeof data?.turn === 'number') lastTurn.set(session.id, data.turn)
    if (record.type === 'user/message') {
      const source = data?.source
      if (source?.kind === 'user') {
        if (ours !== undefined && ours.seqFrom === undefined && source.rpcId === ours.requestId) {
          ours.seqFrom = record.seq
          const opened = lastTurn.get(session.id)
          if (ours.turn === undefined && opened !== undefined) ours.turn = opened
          return
        }
        passiveRun(session, folder, 'chat', '', record.seq)
        return
      }
      if (source?.kind === 'plugin' && source.plugin === 'schedule') {
        passiveRun(session, folder, 'reminder', userText(data).slice(0, SUMMARY_CHARS), record.seq)
        return
      }
      if (source?.kind === 'plugin' && source.plugin === 'compact') {
        const thread = threads.get(routineName)
        if (thread !== undefined) {
          thread.lastCompaction = userText(data).slice(0, COMPACTION_CHARS)
          void saveThread(folder)
        }
      }
      return
    }
    const turn = data?.turn
    if (typeof turn !== 'number') return
    const current = ours !== undefined && ours.seqFrom !== undefined && (ours.turn === undefined || ours.turn === turn)
      ? ours
      : passive.get(session.id)
    if (current === undefined) return
    if (current.turn === undefined) current.turn = turn
    if (current.turn !== turn) return
    if (record.type === 'assistant/message') {
      const text = assistantText(data)
      if (text !== undefined) current.text = text
      const tokens = data?.usage?.inputTokens
      if (typeof tokens === 'number') current.inputTokens = tokens
      return
    }
    if (record.type === 'turn/end') {
      const kind = data?.reason?.kind
      const outcome: Outcome = current.timedOut === true ? 'timeout' : kind === 'completed' ? 'finished' : kind === 'aborted' ? 'aborted' : 'failed'
      const detail = kind === 'error' ? (data?.reason?.error?.message ?? 'model error') : kind === 'blocked' ? 'blocked' : ''
      void finish(folder, current, outcome, detail)
    }
  }), 'vesta-routines: thread observer')

  // The pinned brief.
  ctx.systemPrompt.section({
    name: BRIEF_SECTION,
    order: 2,
    text: (context) => {
      const sessionId = sessionIdOfScope(context.scope)
      const routineName = sessionId === undefined ? undefined : sessionToRoutine.get(sessionId)
      const routine = routineName === undefined ? undefined : cache.get(routineName)?.routine
      if (routine === undefined) return ''
      const tier = routine.permission === 'danger-full-access'
        ? 'Permission tier: full access. Still: look before acting, back up before destructive edits.'
        : routine.permission === 'workspace-write'
          ? 'Permission tier: workspace-write — files outside the workspace are read-only; an escalation is refused unattended.'
          : 'Permission tier: read-only — you cannot write files or change the machine; an escalation is refused unattended.'
      return renderBrief(routine, tier)
    },
  })

  // The service the routine tools consume.
  const dirOf = (routineName: string): string => {
    const folder = cache.get(routineName)
    if (folder === undefined) throw new Error(`no routine "${routineName}"`)
    return folder.dir
  }
  const capped = (text: string): void => {
    const size = Buffer.byteLength(text)
    if (size > config.notesMaxBytes) {
      throw new Error(`the notes would be ${String(size)} bytes; the cap is ${String(config.notesMaxBytes)}. Condense them: keep only what the next run needs.`)
    }
  }
  const service: VestaRoutinesService = {
    routineOfSession: (sessionId) => {
      const routineName = sessionToRoutine.get(sessionId)
      return routineName === undefined ? undefined : cache.get(routineName)?.routine
    },
    threadSessionIds: () => new Set(sessionToRoutine.keys()),
    readNotes: routineName => readNotes(dirOf(routineName)),
    writeNotes: async (routineName, text) => {
      capped(text)
      await writeNotes(dirOf(routineName), text)
    },
    appendNotes: async (routineName, text) => {
      const dir = dirOf(routineName)
      const existing = await readNotes(dir)
      const joined = existing.trim() === '' ? `${text.trim()}\n` : `${existing.trimEnd()}\n${text.trim()}\n`
      capped(joined)
      await writeNotes(dir, joined)
    },
    notesMaxBytes: config.notesMaxBytes,
  }
  ctx.provide('vestaRoutines', service)

  // Boot: import the v1 file, learn every thread.
  const boot = async (): Promise<void> => {
    try {
      const imported = await importLegacy(legacyFile, root, config.defaultTimeoutMinutes)
      importErrors = imported.errors
      if (imported.created.length > 0) ctx.logger.info(`vesta-routines: imported ${imported.created.join(', ')} from ${legacyFile}`)
    } catch (error: unknown) {
      importErrors = [`import of ${legacyFile} failed: ${String(error)}`]
    }
    const folders = await load()
    for (const folder of folders) await threadOf(folder)
    booted = true
    ctx.logger.info(`vesta-routines: ${String(folders.length)} routine(s) in ${root}, ${String(sessionToRoutine.size)} thread(s)`)
  }

  const tick = async (): Promise<void> => {
    if (!booted) return
    const folders = await load()
    const now = new Date()
    for (const folder of folders) {
      const routine = folder.routine
      if (routine === undefined || !routine.enabled) continue
      const thread = await threadOf(folder)
      if (thread.paused === true) continue
      if (routine.schedule !== undefined) {
        const schedule = schedules.get(folder.name)
        if (schedule !== undefined && cronMatches(schedule, now) && thread.lastMinute !== localMinute(now)) {
          thread.lastMinute = localMinute(now)
          await saveThread(folder)
          enqueue(folder.name, 'schedule', '', false)
        }
      } else if (routine.at !== undefined && Date.parse(routine.at) <= now.getTime() && thread.consumedAt !== routine.at) {
        thread.consumedAt = routine.at
        await saveThread(folder)
        enqueue(folder.name, 'at', '', false)
      }
    }
  }

  ctx.effect(() => {
    void boot().catch((error: unknown) => { ctx.logger.warn(`vesta-routines: boot failed: ${String(error)}`) })
    const timer = setInterval(() => { tick().catch((error: unknown) => { ctx.logger.warn(`vesta-routines: tick failed: ${String(error)}`) }) }, config.tickSeconds * 1000)
    return () => { clearInterval(timer) }
  }, 'vesta-routines: ticker')

  // Routes.
  const itemOf = async (folder: RoutineFolder, now: Date): Promise<Record<string, unknown>> => {
    const thread = await threadOf(folder)
    const routine = folder.routine
    const schedule = schedules.get(folder.name)
    const next = routine === undefined
      ? undefined
      : routine.at !== undefined
        ? (thread.consumedAt === routine.at ? undefined : Date.parse(routine.at))
        : schedule === undefined ? undefined : cronNext(schedule, now)?.getTime()
    const live = routine !== undefined && routine.enabled && thread.paused !== true
    return {
      name: folder.name,
      title: routine?.title ?? folder.name,
      schedule: routine?.schedule,
      at: routine?.at,
      scheduleText: routine?.schedule === undefined ? (routine?.at === undefined ? 'manual' : `once at ${routine.at}`) : describeCron(routine.schedule),
      workspace: routine?.workspace,
      permission: routine?.permission,
      reasoning: routine?.reasoning ?? 'xhigh',
      notify: routine?.notify,
      timeoutMinutes: routine?.timeoutMinutes,
      enabled: routine?.enabled ?? false,
      rotateAfterRuns: routine?.rotateAfterRuns,
      compactAboveTokens: routine?.compactAboveTokens,
      paused: thread.paused === true,
      nextRun: live ? next : undefined,
      lastRunAt: thread.lastRunAt,
      lastOutcome: thread.lastOutcome,
      lastRunSummary: thread.lastRunSummary,
      runs: thread.runs,
      threadRuns: thread.threadRuns,
      sessionId: thread.sessionId,
      running: active.has(folder.name),
      queued: queue.some(item => item.name === folder.name),
      problems: folder.errors,
    }
  }

  const listResponse = async (): Promise<Response> => {
    const folders = await load()
    const now = new Date()
    const items: Record<string, unknown>[] = []
    for (const folder of folders) items.push(await itemOf(folder, now))
    return Response.json({ dir: root, items, errors: importErrors, active: [...active.keys()], queue: queue.map(item => item.name) })
  }

  const detailOf = async (folder: RoutineFolder): Promise<Response> => {
    const thread = await threadOf(folder)
    return Response.json({
      item: await itemOf(folder, new Date()),
      brief: folder.routine?.brief ?? '',
      notes: await readNotes(folder.dir),
      runs: await readRuns(folder.dir, config.runsShown),
      thread: {
        sessionId: thread.sessionId, createdAt: thread.createdAt, rotations: thread.rotations, lastCompaction: thread.lastCompaction,
      },
      dir: folder.dir,
    })
  }

  const detailResponse = async (request: Request): Promise<Response> => {
    const routineName = new URL(request.url).searchParams.get('name') ?? ''
    if (!NAME.test(routineName)) return new Response('expected ?name=<routine>', { status: 400 })
    await load()
    const folder = cache.get(routineName)
    if (folder === undefined) return new Response('no such routine', { status: 404 })
    return detailOf(folder)
  }

  const readJson = async (request: Request): Promise<Record<string, unknown> | Response> => {
    try {
      const body = (await request.json()) as unknown
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return new Response('body must be a JSON object', { status: 400 })
      return body as Record<string, unknown>
    } catch {
      return new Response('body must be JSON', { status: 400 })
    }
  }

  const named = async (request: Request): Promise<{ body: Record<string, unknown>; folder: RoutineFolder } | Response> => {
    const body = await readJson(request)
    if (body instanceof Response) return body
    const routineName = typeof body['name'] === 'string' ? body['name'] : ''
    if (!NAME.test(routineName)) return new Response('expected { name }', { status: 400 })
    await load()
    const folder = cache.get(routineName)
    if (folder === undefined) return new Response('no such routine', { status: 404 })
    return { body, folder }
  }

  const saveResponse = async (request: Request): Promise<Response> => {
    const body = await readJson(request)
    if (body instanceof Response) return body
    const routineName = typeof body['name'] === 'string' ? body['name'].trim() : ''
    if (!NAME.test(routineName)) return Response.json({ errors: ['name must be lowercase letters, digits and dashes (1-64)'] }, { status: 400 })
    const { routine, errors } = validateRoutine(routineName, body, config.defaultTimeoutMinutes)
    if (routine === undefined) return Response.json({ errors }, { status: 400 })
    await load()
    const previous = cache.get(routineName)?.routine
    await writeRoutine(join(root, routineName), routine)
    const folders = await load()
    const folder = folders.find(candidate => candidate.name === routineName)
    if (folder === undefined) return new Response('saved, but the folder did not read back', { status: 500 })
    const thread = await threadOf(folder)
    if (previous !== undefined && previous.title !== routine.title && thread.sessionId !== undefined) {
      try {
        await ctx.sessionController.rename({ sessionId: thread.sessionId as SessionId, title: routine.title })
      } catch (error: unknown) {
        ctx.logger.warn(`vesta-routines: rename thread of ${routineName}: ${String(error)}`)
      }
    }
    ctx.logger.info(`vesta-routines: ${previous === undefined ? 'created' : 'updated'} ${routineName}`)
    return detailOf(folder)
  }

  const deleteResponse = async (request: Request): Promise<Response> => {
    const parsed = await named(request)
    if (parsed instanceof Response) return parsed
    const { folder } = parsed
    if (active.has(folder.name) || queue.some(item => item.name === folder.name)) return new Response('busy: a run is active or queued', { status: 409 })
    const thread = await threadOf(folder)
    const sessionId = thread.sessionId as SessionId | undefined
    const exportDir = expandHome(config.exportDir)
    await mkdir(exportDir, { recursive: true })
    const exported = join(exportDir, `${folder.name}-${stampNow()}.tar.gz`)
    const directory = sessionId === undefined ? undefined : await retire(sessionId)
    const args = ['-czf', exported, '-C', root, folder.name]
    if (directory !== undefined && sessionId !== undefined) args.push('-C', join(directory, '..'), sessionId)
    await run('tar', args)
    if (sessionId !== undefined) await forget(sessionId, directory)
    await rm(folder.dir, { recursive: true, force: true })
    threads.delete(folder.name)
    cache.delete(folder.name)
    ctx.logger.info(`vesta-routines: deleted ${folder.name} (exported to ${exported})`)
    return Response.json({ ok: true, exported })
  }

  const runResponse = async (request: Request): Promise<Response> => {
    const parsed = await named(request)
    if (parsed instanceof Response) return parsed
    const { folder, body } = parsed
    if (folder.routine === undefined) return new Response(`the definition has problems: ${folder.errors.join('; ')}`, { status: 400 })
    const info = typeof body['info'] === 'string' ? body['info'].trim().slice(0, 4000) : ''
    const state = enqueue(folder.name, 'manual', info, true)
    if (state === 'busy') return new Response('busy: a run is already queued', { status: 409 })
    return Response.json({ ok: true, queued: queue.length })
  }

  const pauseResponse = async (request: Request): Promise<Response> => {
    const parsed = await named(request)
    if (parsed instanceof Response) return parsed
    const { folder, body } = parsed
    if (typeof body['paused'] !== 'boolean') return new Response('expected { name, paused }', { status: 400 })
    const thread = await threadOf(folder)
    thread.paused = body['paused']
    await saveThread(folder)
    return Response.json({ ok: true, paused: thread.paused })
  }

  const resetResponse = async (request: Request): Promise<Response> => {
    const parsed = await named(request)
    if (parsed instanceof Response) return parsed
    const { folder } = parsed
    if (active.has(folder.name)) return new Response('busy: a run is active', { status: 409 })
    await rotate(folder, 'reset from the page')
    return Response.json({ ok: true })
  }

  const notesResponse = async (request: Request): Promise<Response> => {
    const parsed = await named(request)
    if (parsed instanceof Response) return parsed
    const { folder, body } = parsed
    if (typeof body['text'] !== 'string') return new Response('expected { name, text }', { status: 400 })
    try {
      await service.writeNotes(folder.name, body['text'])
    } catch (error: unknown) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 400 })
    }
    return Response.json({ ok: true })
  }

  ctx.effect(() => {
    const disposers = [
      connection.fetch.register({ path: LIST_PATH, methods: ['GET'], requestBody: 'buffered', fetch: () => listResponse() }),
      connection.fetch.register({ path: DETAIL_PATH, methods: ['GET'], requestBody: 'buffered', fetch: request => detailResponse(request) }),
      connection.fetch.register({ path: SAVE_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => saveResponse(request) }),
      connection.fetch.register({ path: DELETE_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => deleteResponse(request) }),
      connection.fetch.register({ path: RUN_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => runResponse(request) }),
      connection.fetch.register({ path: PAUSE_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => pauseResponse(request) }),
      connection.fetch.register({ path: RESET_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => resetResponse(request) }),
      connection.fetch.register({ path: NOTES_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => notesResponse(request) }),
    ]
    return () => {
      for (const dispose of disposers) void dispose()
    }
  }, 'vesta-routines: routes')
}
