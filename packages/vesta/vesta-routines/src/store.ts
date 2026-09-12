/**
 * The routines folder store: one directory per routine under
 * `$DSH_HOME/routines/<name>/` with `routine.yaml` (definition), `notes.md`
 * (the agent's notes), `runs.jsonl` (history), `thread.json` (thread and run
 * state) and `archive/` (rotated threads).
 * @module @deepseek-ai/dsh-vesta-routines/store
 */
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { parseCron } from './cron.ts'
import type { Notify, Permission, Routine, RunRecord, Thread } from './types.ts'

export const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u
const NOTIFY: ReadonlySet<string> = new Set(['always', 'failure', 'never', 'agent'])
const PERMISSION: ReadonlySet<string> = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const REASONING: ReadonlySet<string> = new Set(['off', 'xhigh'])

export const ROUTINE_FILE = 'routine.yaml'
export const NOTES_FILE = 'notes.md'
export const RUNS_FILE = 'runs.jsonl'
export const THREAD_FILE = 'thread.json'
export const ARCHIVE_DIR = 'archive'

/** A routine directory as read from disk. */
export interface RoutineFolder {
  readonly name: string
  readonly dir: string
  readonly routine?: Routine
  readonly errors: readonly string[]
  readonly mtimeMs: number
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Validate one definition; problems become messages, never crashes.
 * @param folderName - the directory name, the routine's identity.
 * @param parsed - the YAML document (or a JSON body from the page).
 * @param defaultTimeout - minutes for a routine that names none.
 * @returns the routine when valid, else the problems.
 */
export function validateRoutine(folderName: string, parsed: unknown, defaultTimeout: number): { routine?: Routine; errors: string[] } {
  const record = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>
  const problems: string[] = []
  if (!NAME.test(folderName)) problems.push('name must be lowercase letters, digits and dashes (1-64)')
  const declared = text(record['name'])
  if (declared !== undefined && declared !== folderName) problems.push(`name "${declared}" does not match the folder "${folderName}"`)
  const title = text(record['title']) ?? folderName
  const schedule = text(record['schedule'])
  const at = text(record['at'])
  if (schedule !== undefined && at !== undefined) problems.push('schedule and at cannot both be set')
  if (schedule !== undefined) {
    try { parseCron(schedule) } catch (error: unknown) { problems.push(error instanceof Error ? error.message : String(error)) }
  }
  if (at !== undefined && Number.isNaN(Date.parse(at))) problems.push(`at "${at}" is not a date-time`)
  const workspace = text(record['workspace'])
  if (workspace === undefined || !workspace.startsWith('/')) problems.push('workspace must be an absolute path')
  const permission = text(record['permission'])
  if (permission === undefined || !PERMISSION.has(permission)) problems.push('permission is required: read-only, workspace-write or danger-full-access')
  const reasoning = text(record['reasoning'])
  if (reasoning !== undefined && !REASONING.has(reasoning)) problems.push('reasoning must be off or xhigh')
  const brief = text(record['brief'])
  if (brief === undefined) problems.push('brief is required')
  const notify = text(record['notify']) ?? 'agent'
  if (!NOTIFY.has(notify)) problems.push('notify must be always, failure, never or agent')
  const timeoutRaw = record['timeoutMinutes']
  const timeoutMinutes = timeoutRaw === undefined || timeoutRaw === '' ? defaultTimeout : Number(timeoutRaw)
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) problems.push('timeoutMinutes must be a positive number')
  const rotateRaw = record['rotateAfterRuns']
  const rotateAfterRuns = rotateRaw === undefined || rotateRaw === '' ? undefined : Number(rotateRaw)
  if (rotateAfterRuns !== undefined && (!Number.isInteger(rotateAfterRuns) || rotateAfterRuns < 1)) problems.push('rotateAfterRuns must be a positive integer')
  const enabled = record['enabled'] === undefined ? true : record['enabled'] === true
  if (problems.length > 0) return { errors: problems }
  return {
    errors: [],
    routine: {
      name: folderName,
      title,
      ...(schedule === undefined ? {} : { schedule }),
      ...(at === undefined ? {} : { at }),
      workspace: workspace as string,
      permission: permission as Permission,
      ...(reasoning === undefined ? {} : { reasoning: reasoning as 'off' | 'xhigh' }),
      brief: brief as string,
      notify: notify as Notify,
      timeoutMinutes,
      enabled,
      ...(rotateAfterRuns === undefined ? {} : { rotateAfterRuns }),
    },
  }
}

/**
 * Read every routine directory.
 * @param root - the routines directory.
 * @param defaultTimeout - minutes for routines that name none.
 * @param cache - previous folders by name, reused when the file is unchanged.
 * @returns the folders, sorted by name.
 */
export async function readFolders(
  root: string, defaultTimeout: number, cache: ReadonlyMap<string, RoutineFolder>,
): Promise<RoutineFolder[]> {
  let names: string[]
  try {
    names = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
  const folders: RoutineFolder[] = []
  for (const folderName of names.sort()) {
    const dir = join(root, folderName)
    const file = join(dir, ROUTINE_FILE)
    let mtimeMs: number
    try {
      mtimeMs = (await stat(file)).mtimeMs
    } catch {
      continue // a directory without a definition is not a routine (archive litter, work in progress)
    }
    const previous = cache.get(folderName)
    if (previous !== undefined && previous.mtimeMs === mtimeMs) {
      folders.push(previous)
      continue
    }
    let parsed: unknown
    try {
      parsed = yaml.load(await readFile(file, 'utf8'))
    } catch (error: unknown) {
      folders.push({ name: folderName, dir, errors: [`${ROUTINE_FILE}: ${error instanceof Error ? error.message : String(error)}`], mtimeMs })
      continue
    }
    const { routine, errors } = validateRoutine(folderName, parsed, defaultTimeout)
    folders.push({ name: folderName, dir, ...(routine === undefined ? {} : { routine }), errors, mtimeMs })
  }
  return folders
}

/**
 * Write a definition file (the page's save and the legacy import).
 * @param dir - the routine directory (created when missing).
 * @param routine - the validated routine.
 */
export async function writeRoutine(dir: string, routine: Routine): Promise<void> {
  await mkdir(dir, { recursive: true })
  const body = yaml.dump({
    name: routine.name,
    title: routine.title,
    ...(routine.schedule === undefined ? {} : { schedule: routine.schedule }),
    ...(routine.at === undefined ? {} : { at: routine.at }),
    workspace: routine.workspace,
    permission: routine.permission,
    ...(routine.reasoning === undefined ? {} : { reasoning: routine.reasoning }),
    brief: routine.brief,
    notify: routine.notify,
    timeoutMinutes: routine.timeoutMinutes,
    enabled: routine.enabled,
    ...(routine.rotateAfterRuns === undefined ? {} : { rotateAfterRuns: routine.rotateAfterRuns }),
  }, { lineWidth: -1, quotingType: '"' })
  await writeFile(join(dir, ROUTINE_FILE), body)
}

/** Read `thread.json`, or a fresh record. */
export async function readThread(dir: string): Promise<Thread> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, THREAD_FILE), 'utf8')) as Partial<Thread> | null
    if (parsed !== null && typeof parsed === 'object') {
      const rotations = Array.isArray(parsed.rotations) ? parsed.rotations : []
      return { runs: 0, threadRuns: 0, ...parsed, rotations }
    }
  } catch {
    // missing or unreadable: start fresh
  }
  return { runs: 0, threadRuns: 0, rotations: [] }
}

/** Write `thread.json`. */
export async function writeThread(dir: string, thread: Thread): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, THREAD_FILE), JSON.stringify(thread, null, 2))
}

/** Read the notes, empty when absent. */
export async function readNotes(dir: string): Promise<string> {
  try {
    return await readFile(join(dir, NOTES_FILE), 'utf8')
  } catch {
    return ''
  }
}

/** Write the notes. */
export async function writeNotes(dir: string, notes: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, NOTES_FILE), notes)
}

/** Append one run record. */
export async function appendRun(dir: string, record: RunRecord): Promise<void> {
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, RUNS_FILE), `${JSON.stringify(record)}\n`)
}

/**
 * The last `limit` run records, newest first.
 * @param dir - the routine directory.
 * @param limit - how many to return.
 * @returns the records.
 */
export async function readRuns(dir: string, limit: number): Promise<RunRecord[]> {
  let body: string
  try {
    body = await readFile(join(dir, RUNS_FILE), 'utf8')
  } catch {
    return []
  }
  const lines = body.split('\n').filter(line => line.trim() !== '')
  const out: RunRecord[] = []
  for (const line of lines.slice(-limit).reverse()) {
    try {
      out.push(JSON.parse(line) as RunRecord)
    } catch {
      // a torn line is skipped
    }
  }
  return out
}

/**
 * Import the v1 `routines.yaml` once: every entry without a folder becomes one
 * (`prompt` → `brief`, `mode` dropped, `title` = name); the file is then renamed.
 * @param file - the v1 file.
 * @param root - the routines directory.
 * @param defaultTimeout - minutes for entries that name none.
 * @returns names created and problems found.
 */
export async function importLegacy(file: string, root: string, defaultTimeout: number): Promise<{ created: string[]; errors: string[] }> {
  let parsed: unknown
  try {
    parsed = yaml.load(await readFile(file, 'utf8'))
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return { created: [], errors: [] }
    return { created: [], errors: [`${file}: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { routines?: unknown } | null)?.routines
  const created: string[] = []
  const errors: string[] = []
  if (Array.isArray(list)) {
    for (const entry of list) {
      const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
      const legacyName = text(record['name']) ?? ''
      const mapped: Record<string, unknown> = { ...record, brief: record['brief'] ?? record['prompt'], title: record['title'] ?? legacyName }
      delete mapped['prompt']
      delete mapped['mode']
      const { routine, errors: problems } = validateRoutine(legacyName, mapped, defaultTimeout)
      if (routine === undefined) {
        errors.push(`${legacyName || 'entry'}: ${problems.join('; ')}`)
        continue
      }
      const dir = join(root, routine.name)
      try {
        await stat(join(dir, ROUTINE_FILE))
        continue // a folder already exists; the file's copy is stale
      } catch {
        // no folder yet
      }
      await writeRoutine(dir, routine)
      created.push(routine.name)
    }
  } else {
    errors.push(`${file}: expected a list of routines`)
  }
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z')
  await rename(file, `${file}.imported-${stamp}`)
  return { created, errors }
}
