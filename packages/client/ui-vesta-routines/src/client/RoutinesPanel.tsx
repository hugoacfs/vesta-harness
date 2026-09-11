import clsx from 'clsx'
import { useCallback, useEffect, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Panel.module.css'

/** Routes on the Host, base-relative so a reverse-proxy sub-path works. */
const LIST_ROUTE = 'api/vesta/routines'
const RUN_ROUTE = 'api/vesta/routines/run'
const PAUSE_ROUTE = 'api/vesta/routines/pause'

interface RoutineView {
  readonly name: string
  readonly schedule?: string
  readonly at?: string
  readonly workspace: string
  readonly mode: string
  readonly permission: string
  readonly notify: string
  readonly timeoutMinutes: number
  readonly enabled: boolean
  readonly paused: boolean
  readonly nextRun?: number
  readonly lastRun?: number
  readonly lastOutcome?: string
  readonly lastSessionId?: string
  readonly lastDetail?: string
  readonly running: boolean
}

interface Listing {
  readonly file: string
  readonly items: readonly RoutineView[]
  readonly errors: readonly string[]
}

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly listing: Listing }

/** What the plugin injects: open a session in the conversation column. */
export interface RoutinesInjected {
  readonly open: (sessionId: string) => void
}

/** Props: the locale face plus the injected navigation. */
export type RoutinesPanelProps = PropsLocale<'vesta.routines'> & InjectFace<RoutinesInjected>

async function post(route: string, body: Record<string, unknown>): Promise<string | null> {
  const response = await fetch(new URL(route, document.baseURI), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.ok ? null : `${String(response.status)} ${await response.text()}`
}

function when(ms: number | undefined, never: string): string {
  if (ms === undefined) return never
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * The Routines panel: every routine with its schedule, next and last run, and
 * Run now / Pause / Open last session.
 * @param props - locale face and navigation.
 * @returns the panel.
 */
export function RoutinesPanel({ t, open }: RoutinesPanelProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const load = useCallback(async (quiet: boolean) => {
    if (!quiet) setPhase({ kind: 'loading' })
    try {
      const response = await fetch(new URL(LIST_ROUTE, document.baseURI), { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`${String(response.status)} ${await response.text()}`)
      setPhase({ kind: 'ready', listing: (await response.json()) as Listing })
    } catch (error: unknown) {
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])
  useEffect(() => {
    void load(false)
    const timer = setInterval(() => { void load(true) }, 15000)
    return () => { clearInterval(timer) }
  }, [load])
  const act = async (route: string, body: Record<string, unknown>): Promise<void> => {
    setBusy(String(body['name']))
    setFailure(null)
    try {
      const problem = await post(route, body)
      if (problem !== null) setFailure(problem)
      await load(true)
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className={css.panel} aria-labelledby="vesta-routines-title">
      <div className={css.head}>
        <h2 id="vesta-routines-title" className={css.title}>{t('panel.title')}</h2>
        <button type="button" className={css.refresh} disabled={phase.kind === 'loading'} onClick={() => { void load(false) }}>
          {t('panel.refresh')}
        </button>
        {failure !== null && <span className={css.failure}>{failure}</span>}
      </div>
      {phase.kind === 'loading' && <p className={css.note}>{t('panel.loading')}</p>}
      {phase.kind === 'error' && <p className={css.note}>{t('panel.error')}: {phase.message}</p>}
      {phase.kind === 'ready' && (
        <>
          <p className={css.file}>{t('panel.file')}: {phase.listing.file}</p>
          {phase.listing.errors.length > 0 && (
            <div className={css.problems}>
              {t('panel.errors')}
              <ul>{phase.listing.errors.map(problem => <li key={problem}>{problem}</li>)}</ul>
            </div>
          )}
          {phase.listing.items.length === 0 && <p className={css.note}>{t('panel.empty')}</p>}
          {phase.listing.items.length > 0 && (
            <ul className={css.list}>
              {phase.listing.items.map((item) => {
                const working = busy === item.name
                return (
                  <li key={item.name} className={css.row}>
                    <div>
                      <div className={css.rowTitle}>
                        <span>{item.name}</span>
                        {item.running && <span className={clsx(css.badge, css.badgeRunning)}>{t('row.running')}</span>}
                        {!item.enabled && <span className={css.badge}>{t('row.disabled')}</span>}
                        {item.paused && <span className={css.badge}>{t('row.paused')}</span>}
                        <span className={css.badge}>{item.mode} · {item.permission}</span>
                      </div>
                      <div className={css.rowMeta}>
                        {t('row.schedule')}: {item.schedule ?? item.at} · {t('row.next')}: {when(item.nextRun, '—')} · {t('row.last')}: {when(item.lastRun, t('row.never'))}{item.lastOutcome === undefined ? '' : ` (${item.lastOutcome})`} · {item.workspace}
                      </div>
                    </div>
                    <div className={css.rowActions}>
                      <button type="button" className={css.action} disabled={working || item.running} onClick={() => { void act(RUN_ROUTE, { name: item.name }) }}>
                        {t('row.run')}
                      </button>
                      <button type="button" className={css.action} disabled={working} onClick={() => { void act(PAUSE_ROUTE, { name: item.name, paused: !item.paused }) }}>
                        {item.paused ? t('row.resume') : t('row.pause')}
                      </button>
                      {item.lastSessionId !== undefined && (
                        <button type="button" className={css.action} onClick={() => { open(item.lastSessionId ?? '') }}>
                          {t('row.open')}
                        </button>
                      )}
                    </div>
                    {item.lastDetail !== undefined && item.lastDetail !== '' && <div className={css.rowDetail}>{item.lastDetail}</div>}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
