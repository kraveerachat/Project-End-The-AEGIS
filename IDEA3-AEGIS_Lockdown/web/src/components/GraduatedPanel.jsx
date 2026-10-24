import React from 'react'
import { ShieldAlert } from 'lucide-react'
import { DataTable } from './DataTable.jsx'
import { Panel } from './Panel.jsx'
import { StatusBadge } from './StatusBadge.jsx'
import { formatDateTime, formatEvidenceAge } from '../lib/format.js'
import { levelClass } from '../lib/graduated.js'
import { makeT, normalizeLanguage } from '../lib/i18n.js'

/** A level code with its own colour and text, so it is never conveyed by colour alone. The code itself is not translated. */
export function LevelTag({ level, muted = false }) {
  return <span className={`level level--${levelClass(level)}${muted ? ' level--muted' : ''}`} data-level={level}>{level}</span>
}

function Unavailable({ t }) {
  return (
    <div className="graduated-unavailable" data-testid="graduated-unavailable">
      <StatusBadge status="UNKNOWN" compact />
      <p><strong>{t('graduated.notAvailable')}</strong></p>
      <small>{t('graduated.notAvailableDetail')}</small>
    </div>
  )
}

/** Lockdown page: current level, CUT recommendation and the automatic-CUT latch. Display only: it contains no button and no form. */
export function GraduatedSummary({ graduated, language = 'th' }) {
  const t = makeT(normalizeLanguage(language))
  return (
    <Panel title={t('graduated.title')} description={t('graduated.description')} className="graduated-summary" ariaLabel={t('graduated.title')}>
      {!graduated ? <Unavailable t={t} /> : (
        <div data-testid="graduated-summary">
          {graduated.demo === true && <p className="graduated-demo" data-testid="graduated-demo">{t('graduated.demoLabel')}</p>}
          <dl className="fact-grid graduated-facts">
            <div>
              <dt>{t('graduated.level')}</dt>
              <dd><LevelTag level={graduated.highestLevel} muted={!graduated.current} />{' '}
                <small>{graduated.current ? t('graduated.current') : t('graduated.historical', { age: formatEvidenceAge(graduated.ageMs, language) })}</small></dd>
            </div>
            <div>
              <dt>{t('graduated.recommendation')}</dt>
              <dd data-testid="graduated-recommendation">{graduated.cutRecommendedFor
                ? <><ShieldAlert size={14} aria-hidden="true" /> {t('graduated.recommendFor', { ip: graduated.cutRecommendedFor })}</>
                : t('graduated.recommendNone')}</dd>
            </div>
            <div>
              <dt>{t('graduated.autoCut')}</dt>
              <dd data-testid="graduated-autocut">{graduated.autoCutLatched ? t('graduated.autoCutLatched') : t('graduated.autoCutNotLatched')}</dd>
            </div>
          </dl>
          <p className="graduated-readonly">{t('graduated.readOnly')}</p>
        </div>
      )}
    </Panel>
  )
}

/** Incidents and Alerts pages: the Core's latest decisions, newest first, with MITRE ids. Display only. */
export function GraduatedDecisions({ graduated, language = 'th' }) {
  const t = makeT(normalizeLanguage(language))
  const columns = [
    { key: 'at', label: t('graduated.col.time'), render: (value) => <span className="mono">{formatDateTime(value, language)}</span> },
    { key: 'attackerIp', label: t('graduated.col.ip'), render: (value) => <span className="mono">{value}</span> },
    { key: 'kind', label: t('graduated.col.kind'), render: (value) => <span className="source-tag">{value}</span> },
    { key: 'level', label: t('graduated.col.level'), render: (value) => <LevelTag level={value} /> },
    { key: 'action', label: t('graduated.col.action'), render: (value) => <span className="mono">{value}</span> },
    { key: 'outcome', label: t('graduated.col.outcome'), render: (value) => <span className="mono">{value}</span> },
    { key: 'score', label: t('graduated.col.score'), render: (value) => <span className="mono">{value}</span> },
    { key: 'mitre', label: t('graduated.col.mitre'), render: (value) => (value?.length ? <span className="mono" data-testid="mitre-ids">{value.join(', ')}</span> : '—') },
  ]
  const rows = (graduated?.decisions ?? []).map((decision, index) => ({ ...decision, id: `${decision.at}-${decision.attackerIp}-${index}` }))
  return (
    <Panel title={t('graduated.decisions')} description={t('graduated.decisionsDescription')} className="graduated-decisions" ariaLabel={t('graduated.decisions')}>
      {graduated?.demo === true && <p className="graduated-demo">{t('graduated.demoLabel')}</p>}
      {!graduated ? <Unavailable t={t} /> : (
        <DataTable columns={columns} rows={rows} emptyLabel={t('graduated.noDecisions')} ariaLabel={`${t('graduated.decisions')} (${t('graduated.table')})`} wide />
      )}
    </Panel>
  )
}
