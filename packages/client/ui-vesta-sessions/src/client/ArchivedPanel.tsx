import clsx from 'clsx'
import { useCallback, useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Panel.module.css'

/** Routes on the Host, base-relative (no leading slash) so a reverse-proxy sub-path works. */
const ARCHIVED_ROUTE = 'api/vesta/sessions/archived'
const UNARCHIVE_ROUTE = 'api/vesta/sessions/unarchive'
const DELETE_ROUTE = 'api/vesta/sessions/delete'
/** Upstream's session-log ZIP export (`@deepseek-ai/dsh-session-log-export`). */
const EXPORT_ROUTE = 'api/session.export'

interface ArchivedSession {
  readonly sessionId: string
  readonly title: string
  readonly updatedAt: number
  readonly cwd: string
}

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly items: readonly ArchivedSession[] }

interface ActionResult {
  readonly ok: boolean
  readonly message: string
  readonly exported?: string
}

async function post(route: string, sessionId: string): Promise<ActionResult> {
  const response = await fetch(new URL(route, document.baseURI), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
  if (!response.ok) return { ok: false, message: `${String(response.status)} ${await response.text()}` }
  const body = (await response.json()) as { exported?: unknown }
  return typeof body.exported === 'string' ? { ok: true, message: '', exported: body.exported } : { ok: true, message: '' }
}

function ageOf(updatedAt: number): string {
  if (updatedAt <= 0) return ''
  const minutes = Math.max(0, Math.round((Date.now() - updatedAt) / 60000))
  if (minutes < 60) return `${String(minutes)} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${String(hours)} h`
  return `${String(Math.round(hours / 24))} d`
}

/** Props: the locale face only; the panel fetches everything from the Host. */
export type ArchivedPanelProps = PropsLocale<'vesta.sessions'>

/**
 * The archived-sessions panel in the main column: restore, download the log,
 * or delete for good (with an inline confirmation).
 * @param props - locale face.
 * @returns the panel.
 */
export function ArchivedPanel({ t }: ArchivedPanelProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<readonly string[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const load = useCallback(async () => {
    setPhase({ kind: 'loading' })
    try {
      const response = await fetch(new URL(ARCHIVED_ROUTE, document.baseURI), { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`${String(response.status)} ${await response.text()}`)
      const body = (await response.json()) as { items: ArchivedSession[] }
      setPhase({ kind: 'ready', items: body.items })
    } catch (error: unknown) {
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const act = async (route: string, sessionId: string): Promise<void> => {
    setBusy(sessionId)
    setFailure(null)
    try {
      const result = await post(route, sessionId)
      if (!result.ok) {
        setFailure(result.message)
        return
      }
      if (result.exported !== undefined) setDone(current => [...current, result.exported ?? ''])
      await load()
    } finally {
      setBusy(null)
      setConfirming(null)
    }
  }
  return (
    <section className={css.panel} aria-labelledby="vesta-archived-title">
      <div className={css.head}>
        <h2 id="vesta-archived-title" className={css.title}>{t('panel.title')}</h2>
        <button
          type="button"
          className={css.refresh}
          disabled={phase.kind === 'loading'}
          onClick={() => {
            void load()
          }}
        >
          {t('panel.refresh')}
        </button>
        {failure !== null && <span className={css.failure}>{failure}</span>}
      </div>
      {phase.kind === 'loading' && <p className={css.note}>{t('panel.loading')}</p>}
      {phase.kind === 'error' && <p className={css.note}>{t('panel.error')}: {phase.message}</p>}
      {phase.kind === 'ready' && phase.items.length === 0 && <p className={css.note}>{t('panel.empty')}</p>}
      {phase.kind === 'ready' && phase.items.length > 0 && (
        <ul className={css.list}>
          {phase.items.map((item) => {
            const exportHref = new URL(`${EXPORT_ROUTE}?sessionId=${encodeURIComponent(item.sessionId)}`, document.baseURI).href
            const working = busy === item.sessionId
            return (
              <li key={item.sessionId} className={css.row}>
                <div>
                  <div className={css.rowTitle}>{item.title === '' ? t('row.untitled') : item.title}</div>
                  <div className={css.rowMeta}>{[ageOf(item.updatedAt), item.cwd].filter(part => part !== '').join(' · ')}</div>
                </div>
                <div className={css.rowActions}>
                  <button
                    type="button"
                    className={css.action}
                    disabled={working}
                    onClick={() => {
                      void act(UNARCHIVE_ROUTE, item.sessionId)
                    }}
                  >
                    {t('row.restore')}
                  </button>
                  <a className={css.action} href={exportHref} download>{t('row.download')}</a>
                  <button
                    type="button"
                    className={clsx(css.action, css.danger)}
                    disabled={working}
                    onClick={() => {
                      setConfirming(item.sessionId)
                    }}
                  >
                    {working ? t('row.busy') : t('row.delete')}
                  </button>
                </div>
                {confirming === item.sessionId && (
                  <div className={css.confirm} role="group" aria-label={t('row.delete')}>
                    <span>{t('row.confirm')}</span>
                    <button
                      type="button"
                      className={clsx(css.action, css.danger)}
                      disabled={working}
                      onClick={() => {
                        void act(DELETE_ROUTE, item.sessionId)
                      }}
                    >
                      {t('row.confirmYes')}
                    </button>
                    <button
                      type="button"
                      className={css.action}
                      onClick={() => {
                        setConfirming(null)
                      }}
                    >
                      {t('row.confirmNo')}
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {done.map(exported => (
        <p key={exported} className={css.done}>{t('row.deleted')} {exported}</p>
      ))}
    </section>
  )
}
