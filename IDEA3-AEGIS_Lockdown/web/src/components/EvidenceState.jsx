import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { makeT } from '../lib/i18n.js'

export function EvidenceState({ loading, error, stale, empty, onRetry, language, children }) {
  const t = makeT(language)
  const staleLabel = language ? t('status.stale') : 'STALE'
  if (loading) return <div className="skeleton-grid" aria-label={t('evidence.loading')}><span /><span /><span /></div>
  if (error && !stale) {
    return (
      <div className="state-message" role="alert">
        <AlertTriangle aria-hidden="true" />
        <div><strong>{t('evidence.errorTitle')}</strong><p>{language ? t('evidence.errorDetail') : error}</p></div>
        {onRetry && <button className="button button--secondary" onClick={onRetry}><RefreshCw size={16} />{t('evidence.retry')}</button>}
      </div>
    )
  }
  if (empty) return <div className="empty-state"><span className="aegis-hatch" aria-hidden="true" /><p>{empty}</p></div>
  return <div className={stale ? 'evidence evidence--stale' : 'evidence'}>{stale && <div className="stale-note" role="status">{staleLabel} · {t('evidence.stale')}{onRetry && <button className="stale-note__retry" type="button" onClick={onRetry}>{t('evidence.retry')}</button>}</div>}{children}</div>
}
