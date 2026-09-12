/**
 * The schedule builder: a few common shapes (every N minutes, hourly, daily,
 * weekdays, weekly, monthly), a raw cron, a one-off date-time or manual-only,
 * converted to and from the routine's `schedule` / `at` fields.
 */

/** The shapes the builder offers. */
export type ScheduleKind = 'manual' | 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'cron' | 'once'

/** Builder state; every field is kept so switching kinds loses nothing. */
export interface ScheduleForm {
  readonly kind: ScheduleKind
  readonly every: string
  readonly time: string
  readonly weekday: string
  readonly day: string
  readonly cron: string
  readonly at: string
}

export const DEFAULT_SCHEDULE: ScheduleForm = { kind: 'daily', every: '30', time: '07:00', weekday: '1', day: '1', cron: '0 7 * * 1-5', at: '' }

function clock(time: string): { minute: string; hour: string } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(time)
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined
  return { minute: String(minute), hour: String(hour) }
}

/**
 * The `schedule` and `at` fields for a builder state.
 * @param form - builder state.
 * @returns the fields, or an error key when the state is incomplete.
 */
export function toFields(form: ScheduleForm): { schedule?: string; at?: string } | { error: string } {
  const at = clock(form.time)
  switch (form.kind) {
    case 'manual':
      return {}
    case 'minutes': {
      const every = Number(form.every)
      if (!Number.isInteger(every) || every < 1 || every > 59) return { error: 'form.badEvery' }
      return { schedule: `*/${String(every)} * * * *` }
    }
    case 'hourly':
      return at === undefined ? { error: 'form.badTime' } : { schedule: `${at.minute} * * * *` }
    case 'daily':
      return at === undefined ? { error: 'form.badTime' } : { schedule: `${at.minute} ${at.hour} * * *` }
    case 'weekdays':
      return at === undefined ? { error: 'form.badTime' } : { schedule: `${at.minute} ${at.hour} * * 1-5` }
    case 'weekly':
      return at === undefined ? { error: 'form.badTime' } : { schedule: `${at.minute} ${at.hour} * * ${form.weekday}` }
    case 'monthly': {
      const day = Number(form.day)
      if (!Number.isInteger(day) || day < 1 || day > 31) return { error: 'form.badDay' }
      return at === undefined ? { error: 'form.badTime' } : { schedule: `${at.minute} ${at.hour} ${String(day)} * *` }
    }
    case 'cron':
      return form.cron.trim().split(/\s+/u).length === 5 ? { schedule: form.cron.trim() } : { error: 'form.badCron' }
    case 'once':
      return form.at === '' || Number.isNaN(Date.parse(form.at)) ? { error: 'form.badAt' } : { at: form.at }
    default:
      return {}
  }
}

function pad(value: string): string {
  return value.padStart(2, '0')
}

/**
 * Builder state for existing fields; unusual cron shapes land in the raw kind.
 * @param schedule - the cron expression, if any.
 * @param at - the one-off date-time, if any.
 * @returns the state.
 */
export function fromFields(schedule: string | undefined, at: string | undefined): ScheduleForm {
  if (at !== undefined && at !== '') return { ...DEFAULT_SCHEDULE, kind: 'once', at: at.slice(0, 16) }
  if (schedule === undefined || schedule.trim() === '') return { ...DEFAULT_SCHEDULE, kind: 'manual' }
  const fields = schedule.trim().split(/\s+/u)
  const base = { ...DEFAULT_SCHEDULE, cron: schedule.trim() }
  if (fields.length !== 5) return { ...base, kind: 'cron' }
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = fields
  const numeric = /^\d{1,2}$/u
  if (month !== '*') return { ...base, kind: 'cron' }
  const every = /^\*\/(\d+)$/u.exec(minute)
  if (every !== null && hour === '*' && dom === '*' && dow === '*') return { ...base, kind: 'minutes', every: every[1] ?? '30' }
  if (!numeric.test(minute)) return { ...base, kind: 'cron' }
  if (hour === '*' && dom === '*' && dow === '*') return { ...base, kind: 'hourly', time: `00:${pad(minute)}` }
  if (!numeric.test(hour)) return { ...base, kind: 'cron' }
  const time = `${pad(hour)}:${pad(minute)}`
  if (dom === '*' && dow === '*') return { ...base, kind: 'daily', time }
  if (dom === '*' && dow === '1-5') return { ...base, kind: 'weekdays', time }
  if (dom === '*' && /^[0-7]$/u.test(dow)) return { ...base, kind: 'weekly', time, weekday: dow === '7' ? '0' : dow }
  if (dow === '*' && numeric.test(dom)) return { ...base, kind: 'monthly', time, day: dom }
  return { ...base, kind: 'cron' }
}
