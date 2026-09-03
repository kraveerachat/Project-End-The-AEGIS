import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

export function EvidenceState({ loading, error, stale, empty, onRetry, children }) {
  if (loading) return <div className="skeleton-grid" aria-label="กำลังโหลดหลักฐาน"><span /><span /><span /></div>
  if (error && !stale) {
    return (
      <div className="state-message" role="alert">
        <AlertTriangle aria-hidden="true" />
        <div><strong>ไม่สามารถอ่านหลักฐานล่าสุด</strong><p>{error}</p></div>
        {onRetry && <button className="button button--secondary" onClick={onRetry}><RefreshCw size={16} />ลองใหม่</button>}
      </div>
    )
  }
  if (empty) return <div className="empty-state"><span className="aegis-hatch" aria-hidden="true" /><p>{empty}</p></div>
  return <div className={stale ? 'evidence evidence--stale' : 'evidence'}>{stale && <div className="stale-note" role="status">STALE · API ขาดการเชื่อมต่อ กำลังแสดงหลักฐานล่าสุดที่ตรวจสอบได้{onRetry && <button className="stale-note__retry" type="button" onClick={onRetry}>ลองใหม่</button>}</div>}{children}</div>
}
