/**
 * A small five-field cron matcher (minute hour day-of-month month day-of-week),
 * server local time. Supports `*`, lists, ranges, steps and the usual month and
 * weekday names; day-of-month and day-of-week combine the classic way (either
 * matches when both are restricted).
 */

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

/** A parsed schedule. */
export interface CronSchedule {
  readonly minute: ReadonlySet<number>
  readonly hour: ReadonlySet<number>
  readonly dayOfMonth: ReadonlySet<number>
  readonly month: ReadonlySet<number>
  readonly dayOfWeek: ReadonlySet<number>
  readonly dayOfMonthRestricted: boolean
  readonly dayOfWeekRestricted: boolean
}

function resolveName(token: string, names: Record<string, number> | undefined, min: number, max: number, field: string): number {
  const lower = token.toLowerCase()
  const named = names?.[lower]
  const value = named ?? Number(token)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`cron field "${field}": "${token}" is out of range ${String(min)}-${String(max)}`)
  return value
}

function parseField(field: string, min: number, max: number, names?: Record<string, number>): Set<number> {
  const out = new Set<number>()
  if (field.trim() === '') throw new Error('cron field is empty')
  for (const part of field.split(',')) {
    const [rangePart = '', stepPart] = part.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron field "${field}": bad step "${stepPart ?? ''}"`)
    let low = min
    let high = max
    if (rangePart !== '*') {
      const [a = '', b] = rangePart.split('-')
      low = resolveName(a, names, min, max, field)
      high = b === undefined ? (stepPart === undefined ? low : max) : resolveName(b, names, min, max, field)
      if (high < low) throw new Error(`cron field "${field}": range "${rangePart}" runs backwards`)
    }
    for (let value = low; value <= high; value += step) out.add(value)
  }
  return out
}

/**
 * Parse a five-field cron expression.
 * @param expression - e.g. `0 7 * * 1-5`.
 * @returns the schedule.
 */
export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/u)
  if (fields.length !== 5) throw new Error(`cron "${expression}" must have five fields (minute hour day month weekday)`)
  const [minute = '', hour = '', dayOfMonth = '', month = '', dayOfWeek = ''] = fields
  const dow = parseField(dayOfWeek, 0, 7, DAYS)
  if (dow.has(7)) dow.add(0)
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dayOfMonth: parseField(dayOfMonth, 1, 31),
    month: parseField(month, 1, 12, MONTHS),
    dayOfWeek: dow,
    dayOfMonthRestricted: dayOfMonth !== '*',
    dayOfWeekRestricted: dayOfWeek !== '*',
  }
}

/**
 * Whether a schedule fires at the given local minute.
 * @param schedule - parsed schedule.
 * @param date - the instant (seconds are ignored).
 * @returns true when every field matches.
 */
export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minute.has(date.getMinutes()) || !schedule.hour.has(date.getHours())) return false
  if (!schedule.month.has(date.getMonth() + 1)) return false
  const dom = schedule.dayOfMonth.has(date.getDate())
  const dow = schedule.dayOfWeek.has(date.getDay())
  return schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted ? dom || dow : dom && dow
}

/**
 * The next firing after a given instant, up to 400 days ahead.
 * @param schedule - parsed schedule.
 * @param from - search start (exclusive minute).
 * @returns the next firing, or undefined when none within 400 days.
 */
export function cronNext(schedule: CronSchedule, from: Date): Date | undefined {
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = from.getTime() + 400 * 24 * 60 * 60 * 1000
  while (cursor.getTime() <= limit) {
    if (cronMatches(schedule, cursor)) return new Date(cursor.getTime())
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return undefined
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function clock(minute: string, hour: string): string | undefined {
  if (!/^\d{1,2}$/u.test(minute) || !/^\d{1,2}$/u.test(hour)) return undefined
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
}

function dayList(field: string): string | undefined {
  const names: string[] = []
  for (const part of field.split(',')) {
    const lower = part.toLowerCase()
    const named = DAYS[lower]
    const value = named ?? Number(part)
    if (!Number.isInteger(value) || value < 0 || value > 7) return undefined
    names.push(DAY_NAMES[value === 7 ? 0 : value] ?? part)
  }
  return names.join(', ')
}

/**
 * A short English reading of the common shapes of a five-field cron
 * expression; anything else comes back as the expression itself.
 * @param expression - the cron expression.
 * @returns e.g. "weekdays at 07:00", "every 15 minutes", "monthly on day 1 at 09:00".
 */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/u)
  if (fields.length !== 5) return expression
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = fields
  if (month !== '*') return expression
  const time = clock(minute, hour)
  if (dom === '*' && dow === '*') {
    if (minute === '*' && hour === '*') return 'every minute'
    const everyMinutes = /^\*\/(\d+)$/u.exec(minute)
    if (everyMinutes !== null && hour === '*') return `every ${everyMinutes[1] ?? ''} minutes`
    const everyHours = /^\*\/(\d+)$/u.exec(hour)
    if (everyHours !== null && /^\d{1,2}$/u.test(minute)) return `every ${everyHours[1] ?? ''} hours at :${minute.padStart(2, '0')}`
    if (hour === '*' && /^\d{1,2}$/u.test(minute)) return `hourly at :${minute.padStart(2, '0')}`
    if (time !== undefined) return `daily at ${time}`
    return expression
  }
  if (time === undefined) return expression
  if (dom === '*') {
    if (dow === '1-5') return `weekdays at ${time}`
    if (dow === '0,6' || dow === '6,0' || dow === '6,7') return `weekends at ${time}`
    const days = dayList(dow)
    return days === undefined ? expression : `${days} at ${time}`
  }
  if (dow === '*' && /^\d{1,2}$/u.test(dom)) return `monthly on day ${dom} at ${time}`
  return expression
}
