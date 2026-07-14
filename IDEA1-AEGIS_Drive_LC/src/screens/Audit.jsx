import { useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { Chip, Btn, PillSelect } from '../components/ui.jsx'
import { fmtStamp } from '../lib/format.js'
import { AUDIT_LOG } from '../lib/data.js'

/* The audit ledger is deliberately a different material: sharper corners,
   denser rows, mono figures. An append-only record should look like one. */

const RESULT_TONE = { OK: 'ok', DENIED: 'danger', BLOCKED: 'danger' }

export function Audit({ t }) {
  const [resultFilter, setResultFilter] = useState('all')
  const [actorFilter, setActorFilter] = useState('all')
  const [actionFilter, setActionFilter] = useState('all')

  const actors = useMemo(() => [...new Set(AUDIT_LOG.map((e) => e.actor))], [])
  const actions = useMemo(() => [...new Set(AUDIT_LOG.map((e) => e.action))], [])

  // Rows are all rendered; filtered-out rows collapse and fade in place —
  // survivors glide up through layout. Never a reload, never a blank flash.
  const visible = (e) =>
    (resultFilter === 'all' || (resultFilter === 'denied' ? e.result !== 'OK' : true)) &&
    (actorFilter === 'all' || e.actor === actorFilter) &&
    (actionFilter === 'all' || e.action === actionFilter)

  const exportCsv = () => {
    const head = 'timestamp,actor,role,action,target,result,source_ip'
    const rows = AUDIT_LOG.map((e) =>
      [fmtStamp(e.time), e.actor, e.role, e.action, `"${e.target}"`, e.result, e.ip].join(','),
    )
    const blob = new Blob([`${head}\n${rows.join('\n')}`], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'aegis-audit-log.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const visibleCount = AUDIT_LOG.filter(visible).length

  return (
    <div>
      {/* filters — one row above the ledger */}
      <div className="flex items-center gap-2.5 mb-4 flex-wrap">
        <div className="w-40">
          <PillSelect aria-label={t('colResult')} value={resultFilter} onChange={(e) => setResultFilter(e.target.value)}>
            <option value="all">{t('filterAll')}</option>
            <option value="denied">{t('filterDenied')}</option>
          </PillSelect>
        </div>
        <div className="w-44">
          <PillSelect aria-label={t('filterActor')} value={actorFilter} onChange={(e) => setActorFilter(e.target.value)}>
            <option value="all">{t('filterActor')} · {t('filterAll')}</option>
            {actors.map((a) => <option key={a} value={a}>{a}</option>)}
          </PillSelect>
        </div>
        <div className="w-44">
          <PillSelect aria-label={t('filterAction')} value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
            <option value="all">{t('filterAction')} · {t('filterAll')}</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </PillSelect>
        </div>
        <span className="text-[12px] text-ink-3 ml-1" style={{ fontVariantNumeric: 'tabular-nums' }}>{visibleCount} / {AUDIT_LOG.length}</span>
        <div className="flex-1" />
        <Btn variant="outline" size="sm" onClick={exportCsv}>
          <Download size={13} strokeWidth={1.5} />
          {t('exportCsv')}
        </Btn>
      </div>

      <p className="text-[12px] text-ink-3 mb-3">{t('auditSubtitle')}</p>

      {/* the hard, unforgiving record — 8px corners, 40px rows */}
      <div className="bg-card border border-line overflow-hidden" style={{ borderRadius: 'var(--r-ledger)', boxShadow: 'var(--elev-1)' }}>
        <div className="overflow-x-auto">
          <div className="min-w-[860px] relative">
            {/* header */}
            <div
              className="grid gap-3 items-center px-4 pl-10 bg-sunken border-b border-line text-[11px] font-semibold text-ink-3 uppercase tracking-[0.06em] h-9"
              style={{ gridTemplateColumns: '150px minmax(140px,1.2fr) 130px minmax(170px,1.6fr) 84px 118px' }}
            >
              <span>{t('colTimestamp')}</span>
              <span>{t('colActor')}</span>
              <span>{t('colAction')}</span>
              <span>{t('colTargetA')}</span>
              <span>{t('colResult')}</span>
              <span>{t('colSourceIp')}</span>
            </div>

            {/* chain motif — append-only, visibly linked */}
            <div className="absolute left-4 top-9 bottom-0 w-px bg-line" aria-hidden />

            {AUDIT_LOG.map((e, i) => {
              const bad = e.result !== 'OK'
              const shown = visible(e)
              return (
                <div
                  key={e.id}
                  className="overflow-hidden transition-[max-height,opacity] duration-[var(--dur-base)]"
                  style={{ maxHeight: shown ? 40 : 0, opacity: shown ? 1 : 0, transitionTimingFunction: 'var(--ease)' }}
                >
                  <div
                    className="relative grid gap-3 items-center px-4 pl-10 h-10 border-b border-line text-[12.5px] rise-in"
                    style={{
                      gridTemplateColumns: '150px minmax(140px,1.2fr) 130px minmax(170px,1.6fr) 84px 118px',
                      animationDelay: `${Math.min(i * 25, 400)}ms`,
                      background: bad ? 'var(--danger-soft)' : 'transparent',
                      borderLeft: bad ? '3px solid var(--danger)' : '3px solid transparent',
                    }}
                  >
                    {/* chain node */}
                    <span aria-hidden className="absolute left-[13px] size-[7px] rounded-full border bg-card" style={{ borderColor: bad ? 'var(--danger)' : 'var(--ink-3)' }} />
                    <span className="font-mono text-[11.5px] text-ink-2 whitespace-nowrap">{fmtStamp(e.time)}</span>
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-ink">{e.actor}</span>
                      <span className="text-ink-3"> · {e.role}</span>
                    </span>
                    <span className="font-mono text-[11.5px] text-ink-2 whitespace-nowrap">{e.action}</span>
                    <span className="text-ink-2 truncate" title={e.target}>{e.target}</span>
                    <span>
                      <Chip tone={RESULT_TONE[e.result]}>
                        {e.result === 'OK' ? t('resOk') : e.result === 'DENIED' ? t('resDenied') : t('resBlocked')}
                      </Chip>
                    </span>
                    <span className="font-mono text-[11.5px] text-ink-2 whitespace-nowrap">{e.ip}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
