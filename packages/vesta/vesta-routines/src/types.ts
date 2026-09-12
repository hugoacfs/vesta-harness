/**
 * Shared shapes of the routines plugin: the validated definition, the thread
 * record, one run record and the host service other plugins consume.
 * @module @deepseek-ai/dsh-vesta-routines/types
 */

/** Permission tier a routine runs at; required, no implicit default. */
export type Permission = 'read-only' | 'workspace-write' | 'danger-full-access'

/** When the plugin sends a Telegram message about a run. */
export type Notify = 'always' | 'failure' | 'never' | 'agent'

/** Why a turn ran in the thread. */
export type Trigger = 'schedule' | 'at' | 'manual' | 'event' | 'reminder' | 'chat'

/** How a run ended. */
export type Outcome = 'finished' | 'timeout' | 'failed' | 'aborted'

/** One routine as declared in `routine.yaml`, validated. */
export interface Routine {
  readonly name: string
  readonly title: string
  readonly schedule?: string
  readonly at?: string
  readonly workspace: string
  readonly permission: Permission
  readonly reasoning?: 'off' | 'xhigh'
  readonly brief: string
  readonly notify: Notify
  readonly timeoutMinutes: number
  readonly enabled: boolean
  readonly rotateAfterRuns?: number
}

/** One archived thread. */
export interface Rotation {
  readonly sessionId: string
  readonly archivedAt: string
  readonly file: string
  readonly runs: number
  readonly reason: string
}

/** The routine's thread and run state (`thread.json`). */
export interface Thread {
  sessionId?: string | undefined
  createdAt?: string | undefined
  /** Runs counted over the routine's life, rotations included. */
  runs: number
  /** Runs in the current thread. */
  threadRuns: number
  lastRunAt?: number
  lastOutcome?: Outcome | 'started'
  lastRunSummary?: string
  /** The latest compaction summary seen in the thread, for the archive and the next thread. */
  lastCompaction?: string | undefined
  /** Summary handed to the first run after a rotation. */
  handover?: string | undefined
  lastMinute?: string
  consumedAt?: string
  paused?: boolean
  rotations: Rotation[]
}

/** One line of `runs.jsonl`. */
export interface RunRecord {
  readonly time: string
  readonly run: number
  readonly trigger: Trigger
  readonly outcome: Outcome
  readonly seconds: number
  readonly sessionId: string
  readonly turn?: number
  readonly seqFrom?: number
  readonly seqTo?: number
  readonly summary: string
  readonly notified: boolean
  readonly inputTokens?: number
  readonly info?: string
  readonly detail?: string
}

/** The host service the routine tools consume (`ctx.vestaRoutines`). */
export interface VestaRoutinesService {
  /** The routine whose thread is this session, if any. */
  routineOfSession(sessionId: string): Routine | undefined
  /** Every thread session id, so other surfaces can hide them. */
  threadSessionIds(): ReadonlySet<string>
  /** The agent's notes for a routine. */
  readNotes(name: string): Promise<string>
  /** Replace the notes; rejects text over the cap with a message the model can act on. */
  writeNotes(name: string, text: string): Promise<void>
  /** Append one block to the notes, same cap. */
  appendNotes(name: string, text: string): Promise<void>
  readonly notesMaxBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Vesta routines: thread lookup and notes for the routine tools. */
    vestaRoutines: VestaRoutinesService
  }
}
