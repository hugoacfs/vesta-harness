/**
 * Vesta routine tools, a preset row (roadmap R8): `routine_note` reads,
 * appends to or replaces the calling routine's `notes.md` through the
 * `vestaRoutines` host service, so a thread can keep facts across runs at any
 * permission tier (the notes live outside the workspace and outside the
 * sandbox). Outside a routine thread the tool explains itself and does nothing.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-vesta-routines/types'

export const name = 'vesta-routine-tools'

/** Required services: the tool registry of this preset realm and the routines host service. */
export const inject = ['tools', 'vestaRoutines']

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/**
 * Register `routine_note`.
 * @param ctx - preset realm context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'routine_note',
    description: 'Your notes for this routine, kept across runs and shown to you at the start of every run: read them, append a block, or replace them. '
      + 'Keep numbers you will compare next time, items already handled, and open threads. Short and current beats long.',
    parameters: {
      action: { type: 'string', enum: ['read', 'append', 'replace'], required: true, description: 'read the notes, append text, or replace them.' },
      text: { type: 'string', description: 'The text to append or the full new notes (ignored for read).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: args => args.action === 'read',
    execute: async (args, exec) => {
      const sessionId = exec.agent?.session.id
      const routine = sessionId === undefined ? undefined : ctx.vestaRoutines.routineOfSession(sessionId)
      if (routine === undefined) return 'This session is not a routine thread; routine_note keeps nothing here.'
      if (args.action === 'read') {
        const notes = await ctx.vestaRoutines.readNotes(routine.name)
        return notes.trim() === '' ? '(no notes yet)' : notes
      }
      const text = args.text ?? ''
      if (text.trim() === '') return 'Nothing written: text is empty.'
      if (args.action === 'append') await ctx.vestaRoutines.appendNotes(routine.name, text)
      else await ctx.vestaRoutines.writeNotes(routine.name, text)
      const notes = await ctx.vestaRoutines.readNotes(routine.name)
      return `Notes ${args.action === 'append' ? 'appended' : 'replaced'} (${String(Buffer.byteLength(notes))} of ${String(ctx.vestaRoutines.notesMaxBytes)} bytes).`
    },
  }))
}
