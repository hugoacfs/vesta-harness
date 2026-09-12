import clsx from 'clsx'
import { useCallback, useEffect, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Panel.module.css'
import type { RoutinesKey } from './locales.ts'
import { DEFAULT_SCHEDULE, fromFields, toFields } from './schedule.ts'
import type { ScheduleForm, ScheduleKind } from './schedule.ts'

/** Routes on the Host, base-relative so a reverse-proxy sub-path works. */
const LIST_ROUTE = 'api/vesta/routines'
const DETAIL_ROUTE = 'api/vesta/routines/detail'
const SAVE_ROUTE = 'api/vesta/routines/save'
const DELETE_ROUTE = 'api/vesta/routines/delete'
const RUN_ROUTE = 'api/vesta/routines/run'
const PAUSE_ROUTE = 'api/vesta/routines/pause'
const RESET_ROUTE = 'api/vesta/routines/reset'
const NOTES_ROUTE = 'api/vesta/routines/notes'

interface Item {
  readonly name: string
  readonly title: string
  readonly schedule?: string
  readonly at?: string
  readonly scheduleText: string
  readonly workspace?: string
  readonly permission?: string
  readonly reasoning: string
  readonly notify?: string
  readonly timeoutMinutes?: number
  readonly enabled: boolean
  readonly rotateAfterRuns?: number
  readonly compactAboveTokens?: number
  readonly paused: boolean
  readonly nextRun?: number
  readonly lastRunAt?: number
  readonly lastOutcome?: string
  readonly lastRunSummary?: string
  readonly runs: number
  readonly threadRuns: number
  readonly sessionId?: string
  readonly running: boolean
  readonly queued: boolean
  readonly problems: readonly string[]
}

interface RunRow {
  readonly time: string
  readonly run: number
  readonly trigger: string
  readonly outcome: string
  readonly seconds: number
  readonly summary: string
  readonly notified: boolean
}

interface Detail {
  readonly item: Item
  readonly brief: string
  readonly notes: string
  readonly runs: readonly RunRow[]
  readonly thread: {
    readonly sessionId?: string
    readonly createdAt?: string
    readonly rotations: readonly { readonly archivedAt: string; readonly reason: string; readonly runs: number }[]
    readonly lastCompaction?: string
  }
  readonly dir: string
}

interface Listing {
  readonly dir: string
  readonly items: readonly Item[]
  readonly errors: readonly string[]
}

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly listing: Listing }

interface FormState {
  readonly name: string
  readonly title: string
  readonly schedule: ScheduleForm
  readonly workspace: string
  readonly permission: string
  readonly reasoning: string
  readonly notify: string
  readonly timeoutMinutes: string
  readonly rotateAfterRuns: string
  readonly compactAboveTokens: string
  readonly enabled: boolean
  readonly brief: string
}

type Mode = { readonly kind: 'view' } | { readonly kind: 'new'; readonly form: FormState } | { readonly kind: 'edit'; readonly form: FormState }

/** What the plugin injects: open a session in the conversation column. */
export interface RoutinesInjected {
  readonly open: (sessionId: string) => void
}

/** Props: the locale face plus the injected navigation. */
export type RoutinesPanelProps = PropsLocale<'vesta.routines'> & InjectFace<RoutinesInjected>

const KINDS: readonly ScheduleKind[] = ['manual', 'minutes', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'cron', 'once']
const WEEKDAYS = ['1', '2', '3', '4', '5', '6', '0'] as const

const EMPTY_FORM: FormState = {
  name: '', title: '', schedule: DEFAULT_SCHEDULE, workspace: '/home/hugo', permission: 'read-only', reasoning: 'xhigh',
  notify: 'agent', timeoutMinutes: '30', rotateAfterRuns: '', compactAboveTokens: '', enabled: true, brief: '',
}

async function getJson<T>(route: string): Promise<T> {
  const response = await fetch(new URL(route, document.baseURI), { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`${String(response.status)} ${await response.text()}`)
  return (await response.json()) as T
}

interface PostResult {
  readonly ok: boolean
  readonly status: number
  readonly body: unknown
  readonly text: string
}

async function postJson(route: string, body: Record<string, unknown>): Promise<PostResult> {
  const response = await fetch(new URL(route, document.baseURI), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown = undefined
  try {
    parsed = JSON.parse(text)
  } catch {
    // plain text answer
  }
  return { ok: response.ok, status: response.status, body: parsed, text }
}

function when(ms: number | undefined, never: string): string {
  if (ms === undefined) return never
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function whenIso(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? iso : when(ms, iso)
}

function took(seconds: number): string {
  if (seconds < 90) return `${String(seconds)} s`
  return `${String(Math.round(seconds / 60))} min`
}

function formOf(detail: Detail): FormState {
  const item = detail.item
  return {
    name: item.name,
    title: item.title,
    schedule: fromFields(item.schedule, item.at),
    workspace: item.workspace ?? '',
    permission: item.permission ?? 'read-only',
    reasoning: item.reasoning,
    notify: item.notify ?? 'agent',
    timeoutMinutes: item.timeoutMinutes === undefined ? '30' : String(item.timeoutMinutes),
    rotateAfterRuns: item.rotateAfterRuns === undefined ? '' : String(item.rotateAfterRuns),
    compactAboveTokens: item.compactAboveTokens === undefined ? '' : String(item.compactAboveTokens),
    enabled: item.enabled,
    brief: detail.brief,
  }
}

/**
 * The Routines page: the list on the left, one routine on the right with its
 * definition, brief, notes, run history and actions; a form for new and edit.
 * @param props - locale face and navigation.
 * @returns the page.
 */
export function RoutinesPanel({ t, open }: RoutinesPanelProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: 'view' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [errors, setErrors] = useState<readonly string[]>([])
  const [confirming, setConfirming] = useState<'reset' | 'delete' | 'notes' | null>(null)

  const loadList = useCallback(async (quiet: boolean) => {
    if (!quiet) setPhase({ kind: 'loading' })
    try {
      const listing = await getJson<Listing>(LIST_ROUTE)
      setPhase({ kind: 'ready', listing })
    } catch (error: unknown) {
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  const loadDetail = useCallback(async (routineName: string) => {
    try {
      setDetail(await getJson<Detail>(`${DETAIL_ROUTE}?name=${encodeURIComponent(routineName)}`))
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void loadList(false)
  }, [loadList])

  useEffect(() => {
    if (selected === null) {
      setDetail(null)
      return
    }
    void loadDetail(selected)
  }, [selected, loadDetail])

  useEffect(() => {
    const timer = setInterval(() => {
      if (mode.kind !== 'view') return
      void loadList(true)
      if (selected !== null) void loadDetail(selected)
    }, 10000)
    return () => { clearInterval(timer) }
  }, [mode.kind, selected, loadList, loadDetail])

  const refresh = async (): Promise<void> => {
    await loadList(true)
    if (selected !== null) await loadDetail(selected)
  }

  const act = async (route: string, body: Record<string, unknown>): Promise<PostResult | undefined> => {
    setBusy(true)
    setFailure(null)
    try {
      const result = await postJson(route, body)
      if (!result.ok) setFailure(`${String(result.status)} ${result.text}`)
      await refresh()
      return result
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  const select = (routineName: string): void => {
    setSelected(routineName)
    setMode({ kind: 'view' })
    setErrors([])
    setConfirming(null)
  }

  const startNew = (): void => {
    setMode({ kind: 'new', form: EMPTY_FORM })
    setErrors([])
    setConfirming(null)
  }

  const startEdit = (): void => {
    if (detail === null) return
    setMode({ kind: 'edit', form: formOf(detail) })
    setErrors([])
    setConfirming(null)
  }

  const save = async (form: FormState, creating: boolean): Promise<void> => {
    const fields = toFields(form.schedule)
    if ('error' in fields) {
      setErrors([t(fields.error as RoutinesKey)])
      return
    }
    const optionalNumber = (value: string): number | undefined => (value.trim() === '' ? undefined : Number(value))
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      title: form.title.trim() === '' ? form.name.trim() : form.title.trim(),
      ...fields,
      workspace: form.workspace.trim(),
      permission: form.permission,
      reasoning: form.reasoning,
      notify: form.notify,
      timeoutMinutes: Number(form.timeoutMinutes),
      enabled: form.enabled,
      brief: form.brief,
    }
    const rotate = optionalNumber(form.rotateAfterRuns)
    if (rotate !== undefined) body['rotateAfterRuns'] = rotate
    const compact = optionalNumber(form.compactAboveTokens)
    if (compact !== undefined) body['compactAboveTokens'] = compact
    setBusy(true)
    setErrors([])
    try {
      const result = await postJson(SAVE_ROUTE, body)
      if (!result.ok) {
        const answer = result.body as { errors?: unknown } | undefined
        setErrors(Array.isArray(answer?.errors) ? (answer.errors as string[]) : [`${String(result.status)} ${result.text}`])
        return
      }
      setMode({ kind: 'view' })
      await loadList(true)
      if (creating) setSelected(form.name.trim())
      else await loadDetail(form.name.trim())
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (detail === null) return
    const result = await act(DELETE_ROUTE, { name: detail.item.name })
    if (result?.ok === true) {
      setSelected(null)
      setDetail(null)
    }
  }

  const listing = phase.kind === 'ready' ? phase.listing : undefined

  return (
    <section className={css.panel} aria-labelledby="vesta-routines-title">
      <div className={css.head}>
        <h2 id="vesta-routines-title" className={css.title}>{t('panel.title')}</h2>
        <button type="button" className={css.refresh} disabled={phase.kind === 'loading'} onClick={() => { void refresh() }}>
          {t('panel.refresh')}
        </button>
        <button type="button" className={css.action} disabled={busy} onClick={startNew}>{t('panel.new')}</button>
        {failure !== null && <span className={css.failure}>{failure}</span>}
      </div>
      {phase.kind === 'loading' && <p className={css.note}>{t('panel.loading')}</p>}
      {phase.kind === 'error' && <p className={css.note}>{t('panel.error')}: {phase.message}</p>}
      {listing !== undefined && listing.errors.length > 0 && (
        <div className={css.problems}>
          {t('panel.errors')}
          <ul>{listing.errors.map(problem => <li key={problem}>{problem}</li>)}</ul>
        </div>
      )}
      {listing !== undefined && (
        <div className={css.layout}>
          <nav className={css.side} aria-label={t('panel.title')}>
            {listing.items.length === 0 && <p className={css.note}>{t('panel.empty')}</p>}
            {listing.items.map(item => (
              <button
                key={item.name}
                type="button"
                className={clsx(css.sideRow, selected === item.name && css.sideRowActive)}
                onClick={() => { select(item.name) }}
              >
                <span className={css.sideTitle}>
                  {item.title}
                  {item.running && <span className={clsx(css.badge, css.badgeRunning)}>{t('badge.running')}</span>}
                  {item.queued && <span className={css.badge}>{t('badge.queued')}</span>}
                  {item.paused && <span className={css.badge}>{t('badge.paused')}</span>}
                  {!item.enabled && <span className={css.badge}>{t('badge.disabled')}</span>}
                  {item.problems.length > 0 && <span className={clsx(css.badge, css.badgeProblem)}>{t('badge.problems')}</span>}
                </span>
                <span className={css.sideMeta}>
                  {item.scheduleText === 'manual' ? t('list.manual') : item.scheduleText}
                  {' · '}{t('list.next')}: {when(item.nextRun, '—')}
                </span>
              </button>
            ))}
          </nav>
          <div className={css.main}>
            {mode.kind === 'view' && detail === null && <p className={css.note}>{t('panel.pick')}</p>}
            {mode.kind === 'view' && detail !== null && (
              <DetailView
                t={t}
                detail={detail}
                busy={busy}
                confirming={confirming}
                onConfirm={setConfirming}
                onRun={() => { void act(RUN_ROUTE, { name: detail.item.name }) }}
                onPause={() => { void act(PAUSE_ROUTE, { name: detail.item.name, paused: !detail.item.paused }) }}
                onOpen={() => { if (detail.item.sessionId !== undefined) open(detail.item.sessionId) }}
                onEdit={startEdit}
                onReset={() => { void act(RESET_ROUTE, { name: detail.item.name }) }}
                onDelete={() => { void remove() }}
                onClearNotes={() => { void act(NOTES_ROUTE, { name: detail.item.name, text: '' }) }}
              />
            )}
            {mode.kind !== 'view' && (
              <RoutineForm
                t={t}
                creating={mode.kind === 'new'}
                form={mode.form}
                busy={busy}
                errors={errors}
                onChange={(form) => { setMode(mode.kind === 'new' ? { kind: 'new', form } : { kind: 'edit', form }) }}
                onSave={() => { void save(mode.form, mode.kind === 'new') }}
                onCancel={() => { setMode({ kind: 'view' }); setErrors([]) }}
              />
            )}
          </div>
        </div>
      )}
    </section>
  )
}

interface DetailViewProps {
  readonly t: RoutinesPanelProps['t']
  readonly detail: Detail
  readonly busy: boolean
  readonly confirming: 'reset' | 'delete' | 'notes' | null
  readonly onConfirm: (value: 'reset' | 'delete' | 'notes' | null) => void
  readonly onRun: () => void
  readonly onPause: () => void
  readonly onOpen: () => void
  readonly onEdit: () => void
  readonly onReset: () => void
  readonly onDelete: () => void
  readonly onClearNotes: () => void
}

function DetailView(props: DetailViewProps) {
  const { t, detail, busy, confirming, onConfirm, onRun, onPause, onOpen, onEdit, onReset, onDelete, onClearNotes } = props
  const item = detail.item
  const confirmBox = (kind: 'reset' | 'delete' | 'notes', text: string, go: () => void) => confirming === kind && (
    <div className={css.confirm}>
      <span>{text}</span>
      <button type="button" className={clsx(css.action, css.danger)} disabled={busy} onClick={go}>{t('confirm.yes')}</button>
      <button type="button" className={css.action} disabled={busy} onClick={() => { onConfirm(null) }}>{t('confirm.no')}</button>
    </div>
  )
  const runsValue = t('detail.runsValue').replace('{total}', String(item.runs)).replace('{thread}', String(item.threadRuns))
  return (
    <article className={css.detail}>
      <div className={css.detailHead}>
        <h3 className={css.detailTitle}>
          {item.title}
          <span className={css.detailName}>{item.name}</span>
          {item.running && <span className={clsx(css.badge, css.badgeRunning)}>{t('badge.running')}</span>}
          {item.queued && <span className={css.badge}>{t('badge.queued')}</span>}
          {item.paused && <span className={css.badge}>{t('badge.paused')}</span>}
          {!item.enabled && <span className={css.badge}>{t('badge.disabled')}</span>}
        </h3>
        <div className={css.rowActions}>
          <button type="button" className={css.action} disabled={busy || item.running || item.queued || item.problems.length > 0} onClick={onRun}>{t('action.run')}</button>
          <button type="button" className={css.action} disabled={busy} onClick={onPause}>{item.paused ? t('action.resume') : t('action.pause')}</button>
          {item.sessionId !== undefined && <button type="button" className={css.action} onClick={onOpen}>{t('action.open')}</button>}
          <button type="button" className={css.action} disabled={busy} onClick={onEdit}>{t('action.edit')}</button>
          <button type="button" className={css.action} disabled={busy || item.running || item.sessionId === undefined} onClick={() => { onConfirm('reset') }}>{t('action.reset')}</button>
          <button type="button" className={clsx(css.action, css.danger)} disabled={busy || item.running || item.queued} onClick={() => { onConfirm('delete') }}>{t('action.delete')}</button>
        </div>
      </div>
      {confirmBox('reset', t('confirm.reset'), onReset)}
      {confirmBox('delete', t('confirm.delete'), onDelete)}
      {item.problems.length > 0 && (
        <div className={css.problems}>
          {t('detail.problems')}
          <ul>{item.problems.map(problem => <li key={problem}>{problem}</li>)}</ul>
        </div>
      )}
      <dl className={css.grid}>
        <dt>{t('detail.schedule')}</dt><dd>{item.scheduleText === 'manual' ? t('list.manual') : item.scheduleText}{item.schedule === undefined ? '' : ` (${item.schedule})`}</dd>
        <dt>{t('detail.next')}</dt><dd>{when(item.nextRun, '—')}</dd>
        <dt>{t('detail.last')}</dt><dd>{when(item.lastRunAt, t('list.never'))}{item.lastOutcome === undefined ? '' : ` · ${item.lastOutcome}`}</dd>
        <dt>{t('detail.workspace')}</dt><dd>{item.workspace ?? ''}</dd>
        <dt>{t('detail.permission')}</dt><dd>{item.permission ?? ''}</dd>
        <dt>{t('detail.reasoning')}</dt><dd>{item.reasoning}</dd>
        <dt>{t('detail.notify')}</dt><dd>{item.notify ?? ''}</dd>
        <dt>{t('detail.timeout')}</dt><dd>{item.timeoutMinutes === undefined ? '' : String(item.timeoutMinutes)}</dd>
        <dt>{t('detail.runs')}</dt><dd>{runsValue}</dd>
        <dt>{t('detail.thread')}</dt>
        <dd>
          {detail.thread.sessionId === undefined ? t('detail.noThread') : detail.thread.sessionId}
          {detail.thread.createdAt === undefined ? '' : ` · ${whenIso(detail.thread.createdAt)}`}
          {detail.thread.rotations.length > 0 ? ` · ${t('detail.rotations').replace('{count}', String(detail.thread.rotations.length))}` : ''}
        </dd>
      </dl>
      <h4 className={css.subTitle}>{t('detail.brief')}</h4>
      <pre className={css.block}>{detail.brief}</pre>
      <div className={css.subHead}>
        <h4 className={css.subTitle}>{t('detail.notes')}</h4>
        {detail.notes.trim() !== '' && (
          <button type="button" className={css.action} disabled={busy} onClick={() => { onConfirm('notes') }}>{t('action.clearNotes')}</button>
        )}
      </div>
      {confirmBox('notes', t('confirm.clearNotes'), onClearNotes)}
      <pre className={css.block}>{detail.notes.trim() === '' ? t('detail.noNotes') : detail.notes}</pre>
      {detail.thread.lastCompaction !== undefined && detail.thread.lastCompaction !== '' && (
        <>
          <h4 className={css.subTitle}>{t('detail.compaction')}</h4>
          <pre className={clsx(css.block, css.blockDim)}>{detail.thread.lastCompaction}</pre>
        </>
      )}
      <h4 className={css.subTitle}>{t('detail.history')}</h4>
      {detail.runs.length === 0 && <p className={css.note}>{t('detail.noHistory')}</p>}
      {detail.runs.length > 0 && (
        <div className={css.tableWrap}>
          <table className={css.table}>
            <thead>
              <tr>
                <th>{t('runs.time')}</th><th>{t('runs.run')}</th><th>{t('runs.trigger')}</th><th>{t('runs.outcome')}</th><th>{t('runs.seconds')}</th><th>{t('runs.summary')}</th><th>{t('runs.notified')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.runs.map(row => (
                <tr key={`${String(row.run)}-${row.time}`} className={clsx(row.outcome !== 'finished' && css.rowBad)}>
                  <td>{whenIso(row.time)}</td>
                  <td>{String(row.run)}</td>
                  <td>{row.trigger}</td>
                  <td>{row.outcome}</td>
                  <td>{took(row.seconds)}</td>
                  <td className={css.cellSummary}>{row.summary}</td>
                  <td>{row.notified ? '✓' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  )
}

interface RoutineFormProps {
  readonly t: RoutinesPanelProps['t']
  readonly creating: boolean
  readonly form: FormState
  readonly busy: boolean
  readonly errors: readonly string[]
  readonly onChange: (form: FormState) => void
  readonly onSave: () => void
  readonly onCancel: () => void
}

function RoutineForm({ t, creating, form, busy, errors, onChange, onSave, onCancel }: RoutineFormProps) {
  const set = (patch: Partial<FormState>): void => { onChange({ ...form, ...patch }) }
  const setSchedule = (patch: Partial<ScheduleForm>): void => { onChange({ ...form, schedule: { ...form.schedule, ...patch } }) }
  const preview = toFields(form.schedule)
  const schedule = form.schedule
  return (
    <form
      className={css.form}
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <h3 className={css.detailTitle}>{creating ? t('form.titleNew') : t('form.titleEdit')}</h3>
      {errors.length > 0 && (
        <div className={css.problems}>
          {t('form.problems')}
          <ul>{errors.map(problem => <li key={problem}>{problem}</li>)}</ul>
        </div>
      )}
      <div className={css.fields}>
        {creating && (
          <label className={css.field}>
            <span>{t('form.name')}</span>
            <input className={css.input} value={form.name} pattern="[a-z0-9][a-z0-9-]{0,63}" required onChange={(event) => { set({ name: event.target.value }) }} />
          </label>
        )}
        <label className={css.field}>
          <span>{t('form.title')}</span>
          <input className={css.input} value={form.title} onChange={(event) => { set({ title: event.target.value }) }} />
        </label>
        <label className={css.field}>
          <span>{t('form.schedule')}</span>
          <select
            className={css.input}
            value={schedule.kind}
            onChange={(event) => { setSchedule({ kind: event.target.value as ScheduleKind }) }}
          >
            {KINDS.map(kind => <option key={kind} value={kind}>{t(`form.kind.${kind}`)}</option>)}
          </select>
        </label>
        {schedule.kind === 'minutes' && (
          <label className={css.field}>
            <span>{t('form.every')}</span>
            <input className={css.input} type="number" min={1} max={59} value={schedule.every} onChange={(event) => { setSchedule({ every: event.target.value }) }} />
          </label>
        )}
        {(schedule.kind === 'hourly' || schedule.kind === 'daily' || schedule.kind === 'weekdays' || schedule.kind === 'weekly' || schedule.kind === 'monthly') && (
          <label className={css.field}>
            <span>{t('form.time')}</span>
            <input className={css.input} type="time" value={schedule.time} onChange={(event) => { setSchedule({ time: event.target.value }) }} />
          </label>
        )}
        {schedule.kind === 'weekly' && (
          <label className={css.field}>
            <span>{t('form.weekday')}</span>
            <select className={css.input} value={schedule.weekday} onChange={(event) => { setSchedule({ weekday: event.target.value }) }}>
              {WEEKDAYS.map(day => <option key={day} value={day}>{t(`day.${day}`)}</option>)}
            </select>
          </label>
        )}
        {schedule.kind === 'monthly' && (
          <label className={css.field}>
            <span>{t('form.day')}</span>
            <input className={css.input} type="number" min={1} max={31} value={schedule.day} onChange={(event) => { setSchedule({ day: event.target.value }) }} />
          </label>
        )}
        {schedule.kind === 'cron' && (
          <label className={css.field}>
            <span>{t('form.cron')}</span>
            <input className={css.input} value={schedule.cron} onChange={(event) => { setSchedule({ cron: event.target.value }) }} />
          </label>
        )}
        {schedule.kind === 'once' && (
          <label className={css.field}>
            <span>{t('form.at')}</span>
            <input className={css.input} type="datetime-local" value={schedule.at} onChange={(event) => { setSchedule({ at: event.target.value }) }} />
          </label>
        )}
        <p className={css.note}>{'error' in preview ? t(preview.error as RoutinesKey) : (preview.schedule ?? preview.at ?? t('list.manual'))}</p>
        <label className={css.field}>
          <span>{t('form.workspace')}</span>
          <input className={css.input} value={form.workspace} required onChange={(event) => { set({ workspace: event.target.value }) }} />
        </label>
        <label className={css.field}>
          <span>{t('form.permission')}</span>
          <select className={css.input} value={form.permission} onChange={(event) => { set({ permission: event.target.value }) }}>
            <option value="read-only">read-only</option>
            <option value="workspace-write">workspace-write</option>
            <option value="danger-full-access">danger-full-access</option>
          </select>
        </label>
        <label className={css.field}>
          <span>{t('form.reasoning')}</span>
          <select className={css.input} value={form.reasoning} onChange={(event) => { set({ reasoning: event.target.value }) }}>
            <option value="xhigh">xhigh</option>
            <option value="off">off</option>
          </select>
        </label>
        <label className={css.field}>
          <span>{t('form.notify')}</span>
          <select className={css.input} value={form.notify} onChange={(event) => { set({ notify: event.target.value }) }}>
            <option value="agent">{t('form.notify.agent')}</option>
            <option value="always">{t('form.notify.always')}</option>
            <option value="failure">{t('form.notify.failure')}</option>
            <option value="never">{t('form.notify.never')}</option>
          </select>
        </label>
        <label className={css.field}>
          <span>{t('form.timeout')}</span>
          <input className={css.input} type="number" min={1} value={form.timeoutMinutes} required onChange={(event) => { set({ timeoutMinutes: event.target.value }) }} />
        </label>
        <label className={css.field}>
          <span>{t('form.rotate')}</span>
          <input className={css.input} type="number" min={1} value={form.rotateAfterRuns} onChange={(event) => { set({ rotateAfterRuns: event.target.value }) }} />
        </label>
        <label className={css.field}>
          <span>{t('form.compact')}</span>
          <input className={css.input} type="number" min={1} value={form.compactAboveTokens} onChange={(event) => { set({ compactAboveTokens: event.target.value }) }} />
        </label>
        <label className={clsx(css.field, css.fieldInline)}>
          <input type="checkbox" checked={form.enabled} onChange={(event) => { set({ enabled: event.target.checked }) }} />
          <span>{t('form.enabled')}</span>
        </label>
      </div>
      <label className={clsx(css.field, css.fieldWide)}>
        <span>{t('form.brief')}</span>
        <textarea
          className={css.textarea}
          value={form.brief}
          rows={10}
          required
          onChange={(event) => { set({ brief: event.target.value }) }}
        />
      </label>
      <div className={css.rowActions}>
        <button type="submit" className={css.action} disabled={busy}>{busy ? t('action.busy') : t('action.save')}</button>
        <button type="button" className={css.action} disabled={busy} onClick={onCancel}>{t('action.cancel')}</button>
      </div>
    </form>
  )
}
